import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { parse } from 'yaml';
import { atomicWrite, inside, readText } from './storage.js';
import type { NodeSummary, Source, Workspace } from './model.js';
import { digest } from './compiler.js';

export interface Download {
  text: string;
  metadata: Source['metadata'];
}
export type Downloader = (url: string) => Promise<Download>;
export interface PrivateSource {
  url: string;
  nodes: Record<string, unknown>[];
  documentText?: string;
}

export function yamlObject(text: string): Record<string, any> {
  try {
    const value = parse(text, { maxAliasCount: 25, uniqueKeys: true });
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch {
    throw new Error('配置 YAML 无法解析，已隐藏私有内容');
  }
}

export function parseNodes(text: string): Record<string, unknown>[] {
  const value = yamlObject(text);
  if (!Array.isArray(value.proxies) || !value.proxies.length) throw new Error('来源没有有效的 Clash/Mihomo 节点');
  const names = new Set<string>();
  const nodes: Record<string, unknown>[] = [];
  for (const node of value.proxies) {
    if (!node || typeof node !== 'object' || typeof node.name !== 'string' || typeof node.type !== 'string') {
      throw new Error('来源节点结构无效');
    }
    if (/剩余流量|套餐到期|若无法使用请更新节点|重置.*倒计时/.test(node.name)) continue;
    if (names.has(node.name)) throw new Error('同一来源存在重名节点，请先区分名称');
    names.add(node.name);
    nodes.push(node);
  }
  if (!nodes.length) throw new Error('来源只有信息项，没有实际节点');
  return nodes;
}

export function nodeId(sourceId: string, name: string): string {
  return createHash('sha256').update(`${sourceId}\0${name}`).digest('hex').slice(0, 32);
}

export async function readIndex(configDir: string): Promise<Record<string, any>> {
  const index = yamlObject(await readText(await inside(configDir, 'profiles.yaml')));
  if (!Array.isArray(index.items)) throw new Error('客户端订阅索引格式不支持');
  const ids = new Set<string>();
  const files = new Set<string>();
  for (const item of index.items) {
    if (!item || typeof item.uid !== 'string' || typeof item.file !== 'string' || /[/\\]/.test(item.file) || !['local', 'remote', 'merge', 'script'].includes(item.type) || ids.has(item.uid) || files.has(item.file.toLowerCase())) {
      throw new Error('客户端索引存在重复或无效引用');
    }
    await inside(configDir, `profiles/${item.file}`);
    ids.add(item.uid);
    files.add(item.file.toLowerCase());
  }
  if (index.current && !ids.has(index.current)) throw new Error('客户端活动入口已缺失');
  for (const item of index.items) for (const kind of ['merge', 'script']) {
    const uid = item.option?.[kind];
    if (uid && !index.items.some((row: any) => row.uid === uid && row.type === kind)) throw new Error('客户端扩展绑定无效');
  }
  return index;
}

export async function privateSource(workspace: Workspace, source: Source): Promise<PrivateSource> {
  if (!workspace.device || !source.privateRevision || !/^[a-f0-9-]{36}$/.test(source.privateRevision)) throw new Error('来源尚未在本机绑定');
  const file = await inside(workspace.device.configDir, `config-manager/private/${source.privateRevision}.json`);
  return JSON.parse(await readText(file));
}

async function saveSnapshot(workspace: Workspace, source: Source, snapshot: PrivateSource): Promise<void> {
  if (!workspace.device) throw new Error('请先连接本机配置目录');
  const revision = randomUUID();
  const target = await inside(workspace.device.configDir, `config-manager/private/${revision}.json`);
  await atomicWrite(target, JSON.stringify(snapshot));
  source.privateRevision = revision;
  source.fetchedAt = new Date().toISOString();
  source.stale = false;
  delete source.error;
  const summaries: NodeSummary[] = snapshot.nodes.map(node => ({
    id: nodeId(source.id, String(node.name)), sourceId: source.id, name: String(node.name),
    displayName: source.prefix + node.name, protocol: String(node.type), missing: false,
  }));
  const current = new Set(summaries.map(node => node.id));
  workspace.nodes = [
    ...workspace.nodes.filter(node => node.sourceId !== source.id),
    ...workspace.nodes.filter(node => node.sourceId === source.id && !current.has(node.id)).map(node => ({ ...node, missing: true })),
    ...summaries,
  ];
}

export async function adoptSource(workspace: Workspace, uid: string, sourceId?: string): Promise<Source> {
  if (!workspace.device) throw new Error('请先连接本机配置目录');
  const index = await readIndex(workspace.device.configDir);
  const item = index.items.find((row: Record<string, unknown>) => row.uid === uid && row.type === 'remote');
  if (!item || typeof item.url !== 'string') throw new Error('来源订阅不存在或缺少本机地址');
  const existing = sourceId ? workspace.sources.find(source => source.id === sourceId) : workspace.sources.find(source => source.uid === uid);
  if (sourceId && !existing) throw new Error('待绑定的共享来源不存在');
  const source: Source = existing ?? { id: randomUUID(), name: String(item.name || uid), prefix: `[${item.name || uid}] `, metadata: {} };
  source.uid = uid;
  const documentText = await readText(await inside(workspace.device.configDir, `profiles/${item.file}`));
  const nodes = parseNodes(documentText);
  await saveSnapshot(workspace, source, { url: item.url, nodes, documentText });
  source.clientHash = digest(documentText);
  const extra = item.extra;
  if (extra && typeof extra === 'object') {
    for (const field of ['upload', 'download', 'total', 'expire'] as const) if (typeof extra[field] === 'number' && extra[field] >= 0) source.metadata[field] = extra[field];
  }
  if (!existing) workspace.sources.push(source);
  source.intervalSeconds ??= Number.isFinite(item.option?.update_interval) && item.option.update_interval >= 1 ? item.option.update_interval * 60 : 7200;
  return source;
}

export async function registerSource(workspace: Workspace, name: string, url: string, download: Downloader): Promise<Source> {
  if (!workspace.device) throw new Error('请先连接配置目录，私有地址只保存在本机管理目录');
  name = name.trim();
  if (!name || name.length > 160 || workspace.sources.some(source => !source.deleted && source.name === name)) throw new Error('来源名称为空或重复');
  let target: URL;
  try { target = new URL(url); } catch { throw new Error('来源地址格式不正确'); }
  if (!['http:', 'https:'].includes(target.protocol)) throw new Error('来源地址协议不支持');
  const response = await download(url);
  const source: Source = { id: randomUUID(), uid: `cmSource${randomUUID().replaceAll('-', '')}`, name, prefix: `[${name}] `, metadata: response.metadata, dirty: true, cardPending: true };
  await saveSnapshot(workspace, source, { url, nodes: parseNodes(response.text), documentText: response.text });
  workspace.sources.push(source);
  return source;
}

export function sourceImpact(workspace: Workspace, sourceId: string) {
  return workspace.schemes.filter(scheme => scheme.sourceIds.includes(sourceId) || scheme.members.some(id => scheme.nodeRefs[id]?.sourceId === sourceId || workspace.nodes.some(node => node.id === id && node.sourceId === sourceId))).map(scheme => ({ id: scheme.id, name: scheme.name }));
}

export async function updateSource(workspace: Workspace, sourceId: string, values: { name: string; prefix: string; intervalSeconds: number; url?: string }, download: Downloader): Promise<Source> {
  const source = workspace.sources.find(row => row.id === sourceId && !row.deleted);
  if (!source) throw new Error('来源不存在');
  if (!values.name.trim() || values.name.length > 160 || workspace.sources.some(row => row.id !== sourceId && !row.deleted && row.name === values.name.trim())) throw new Error('来源名称为空或重复');
  if (!Number.isInteger(values.intervalSeconds) || values.intervalSeconds < 60 || values.intervalSeconds > 604800) throw new Error('刷新间隔须为 60 秒至 7 天');
  if (values.url) {
    const target = new URL(values.url);
    if (!['http:', 'https:'].includes(target.protocol)) throw new Error('来源地址协议不支持');
    const response = await download(values.url);
    await saveSnapshot(workspace, source, { url: values.url, nodes: parseNodes(response.text), documentText: response.text });
    source.metadata = response.metadata;
    source.cardPending = true;
  }
  if (source.name !== values.name.trim() || source.prefix !== values.prefix) source.dirty = true;
  source.name = values.name.trim();
  source.prefix = values.prefix;
  source.intervalSeconds = values.intervalSeconds;
  source.cardPending = true;
  for (const node of workspace.nodes.filter(row => row.sourceId === source.id)) node.displayName = source.prefix + node.name;
  return source;
}

export async function absorbSource(workspace: Workspace, sourceId: string): Promise<boolean> {
  const source = workspace.sources.find(row => row.id === sourceId && !row.deleted);
  if (!source?.uid || !workspace.device || source.cardPending) return false;
  const index = await readIndex(workspace.device.configDir);
  const card = index.items.find((item: any) => item.uid === source.uid && item.type === 'remote');
  if (!card) { source.error = '本机来源卡片已缺失，可重新绑定或在应用时恢复'; return false; }
  const snapshot = await privateSource(workspace, source);
  if (card.url !== snapshot.url) { source.stale = true; source.error = '客户端订阅地址已变更，请明确重新绑定'; return false; }
  const text = await readText(await inside(workspace.device.configDir, `profiles/${card.file}`));
  if (digest(text) === source.clientHash) return false;
  await adoptSource(workspace, source.uid, source.id);
  return true;
}

export async function refreshSource(workspace: Workspace, sourceId: string, download: Downloader): Promise<Source> {
  const source = workspace.sources.find(row => row.id === sourceId);
  if (!source) throw new Error('来源不存在');
  const previous = await privateSource(workspace, source);
  try {
    const response = await download(previous.url);
    const nodes = parseNodes(response.text);
    await saveSnapshot(workspace, source, { url: previous.url, nodes, documentText: response.text });
    source.metadata = response.metadata;
    source.cardPending = true;
  } catch {
    source.stale = true;
    source.error = '来源获取或节点校验失败，保留上次有效快照';
  }
  return source;
}

export const downloadSource: Downloader = async url => {
  const target = new URL(url);
  if (!['http:', 'https:'].includes(target.protocol)) throw new Error('来源地址协议不支持');
  const response = await fetch(target, { signal: AbortSignal.timeout(30000), headers: { 'User-Agent': 'ClashManager/0.1' } });
  if (!response.ok || !response.body) throw new Error(`来源获取失败，HTTP ${response.status}`);
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > 32 * 1024 * 1024) throw new Error('来源响应超过允许大小');
    chunks.push(chunk);
  }
  const metadata: Source['metadata'] = {};
  for (const field of (response.headers.get('subscription-userinfo') ?? '').split(';')) {
    const [key, raw] = field.trim().split('=');
    if (['upload', 'download', 'total', 'expire'].includes(key) && Number.isFinite(Number(raw)) && Number(raw) >= 0) {
      metadata[key as keyof typeof metadata] = Number(raw);
    }
  }
  return { text: Buffer.concat(chunks).toString('utf8'), metadata };
};
