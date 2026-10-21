import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { inside, readText } from './storage.js';
import {
  adoptSource,
  nodeId,
  parseNodes,
  privateSource,
  readIndex,
  yamlObject,
} from './sources.js';
import {
  emptyScheme,
  monitorSettingsSchema,
  schemeSchema,
  type Reference,
  type Rule,
  type Workspace,
} from './model.js';
import { previewScheme } from './compiler.js';

function literalPolicy(script: string): any {
  const marker = /const\s+aggregatePolicy\s*=\s*\{/.exec(script);
  if (!marker) return null;
  const start = marker.index + marker[0].length - 1;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = start; index < script.length; index++) {
    const char = script[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === '{') depth++;
    else if (char === '}' && --depth === 0) {
      try {
        return JSON.parse(script.slice(start, index + 1));
      } catch {
        throw new Error('旧策略数据无法安全解析，未执行脚本');
      }
    }
  }
  throw new Error('旧策略数据不完整，未执行脚本');
}

function expression(pattern: string): RegExp {
  try {
    return new RegExp(pattern.replace(/\(\?i\)/g, ''), pattern.includes('(?i)') ? 'iu' : 'u');
  } catch {
    throw new Error('旧 provider 过滤表达式不受支持，停止迁移');
  }
}

export async function migrate(
  workspace: Workspace,
  confirmOverwrite = false,
  validate?: import('./sources.js').NodeValidator,
) {
  if (!workspace.device) throw new Error('请先连接配置目录');
  const existing = workspace.schemes.find((scheme) => scheme.id === 'default');
  if (
    existing &&
    (existing.groups.length || existing.rules.length || existing.members.length) &&
    !confirmOverwrite
  )
    throw new Error('default 已有编辑，请确认覆盖或先复制方案');
  const root = workspace.device.configDir;
  const index = await readIndex(root);
  const current = index.items.find((item: any) => item.uid === index.current);
  const generated = yamlObject(await readText(await inside(root, 'clash-verge.yaml')));
  if (!Array.isArray(generated['proxy-groups']) || !Array.isArray(generated.rules))
    throw new Error('当前生成配置缺少可迁移的组或规则');
  let policy: any = null;
  const script = index.items.find((item: any) => item.uid === current?.option?.script);
  if (script) policy = literalPolicy(await readText(await inside(root, `profiles/${script.file}`)));
  const remotes = index.items.filter(
    (item: any) => item.type === 'remote' && typeof item.url === 'string',
  );
  for (const item of remotes) {
    const source = await adoptSource(workspace, item.uid, undefined, validate);
    const definition = Object.values(policy?.subscriptions ?? {}).find(
      (row: any) => row.localName === item.name,
    ) as any;
    if (definition?.prefix) source.prefix = String(definition.prefix);
    source.dirty = true;
  }
  for (const node of workspace.nodes) {
    const source = workspace.sources.find((row) => row.id === node.sourceId)!;
    node.displayName = source.prefix + node.name;
  }
  const providerMembers = new Map<string, string[]>();
  for (const [providerName, declaration] of Object.entries(generated['proxy-providers'] ?? {}) as [
    string,
    any,
  ][]) {
    let nodes: Record<string, unknown>[];
    if (Array.isArray(declaration.payload)) nodes = declaration.payload;
    else {
      const declared = String(declaration.path ?? '');
      const relative = path.isAbsolute(declared)
        ? path.relative(root, declared).replaceAll('\\', '/')
        : declared.replace(/^\.\//, '');
      nodes = parseNodes(await readText(await inside(root, relative)));
    }
    const prefix = declaration.override?.['additional-prefix'] ?? '';
    let names = nodes.map((node) => prefix + node.name);
    if (declaration.filter)
      names = names.filter((name) => expression(String(declaration.filter)).test(name));
    if (declaration['exclude-filter'])
      names = names.filter((name) => !expression(String(declaration['exclude-filter'])).test(name));
    providerMembers.set(providerName, names);
  }
  const scheme = emptyScheme('default', 'default');
  const groupIds = new Map<string, string>(
    generated['proxy-groups'].map((group: any) => [String(group.name), randomUUID()]),
  );
  if (groupIds.size !== generated['proxy-groups'].length) throw new Error('现有配置存在重名代理组');
  const reference = (name: string): Reference => {
    if (['DIRECT', 'REJECT'].includes(name)) return { kind: 'builtin', id: name };
    if (groupIds.has(name)) return { kind: 'group', id: groupIds.get(name)! };
    const matches = workspace.nodes.filter((node) => node.displayName === name && !node.missing);
    if (matches.length !== 1) throw new Error('现有候选无法唯一对应来源节点，停止迁移');
    const node = matches[0];
    if (!scheme.members.includes(node.id)) scheme.members.push(node.id);
    if (!scheme.sourceIds.includes(node.sourceId)) scheme.sourceIds.push(node.sourceId);
    scheme.nodeRefs[node.id] = { sourceId: node.sourceId, name: node.name };
    return { kind: 'node', id: node.id };
  };
  for (const raw of generated['proxy-groups']) {
    if (!['select', 'url-test', 'fallback'].includes(raw.type))
      throw new Error('现有配置包含不支持的策略类型，停止迁移');
    const explicit = (raw.proxies ?? []).map(String);
    const supplied = (raw.use ?? []).flatMap((provider: string) => {
      if (!providerMembers.has(provider)) throw new Error('现有组缺少 provider 依赖');
      return providerMembers.get(provider)!;
    });
    let candidates = raw.filter
      ? String(raw.filter)
          .split('`')
          .flatMap((pattern) =>
            [...supplied, ...explicit].filter((name) => expression(pattern).test(name)),
          )
          .concat(explicit)
      : [...explicit, ...supplied];
    if (raw['exclude-filter'])
      candidates = candidates.filter(
        (name: string) => !expression(String(raw['exclude-filter'])).test(name),
      );
    candidates = [...new Set(candidates)];
    scheme.groups.push({
      id: groupIds.get(raw.name)!,
      name: raw.name,
      kind: raw.name.includes('场景')
        ? 'scene'
        : raw.name.includes('默认')
          ? 'general'
          : 'strategy',
      strategy: raw.type,
      members: candidates.map(reference),
      interval: raw.interval ?? 300,
      timeout: raw.timeout ?? 5000,
      tolerance: raw.tolerance ?? 50,
      url: raw.url ?? 'https://www.gstatic.com/generate_204',
    });
  }
  const privateHosts = new Set<string>();
  for (const source of workspace.sources) {
    try {
      privateHosts.add(new URL((await privateSource(workspace, source)).url).hostname);
    } catch {
      /* 未绑定来源不参与本机例外。 */
    }
  }
  const keys = new Set<string>();
  const warnings: string[] = [];
  let exceptionPrefix = true;
  for (const raw of generated.rules) {
    const parts = String(raw).split(',');
    if (parts[0] === 'MATCH') {
      scheme.defaultTarget = reference(parts[1]);
      continue;
    }
    if (parts.length < 3) throw new Error('现有规则格式无法迁移');
    if (parts[0] === 'DOMAIN' && privateHosts.has(parts[1]) && parts[2] === 'DIRECT') continue;
    const target = reference(parts[2]);
    const group = scheme.groups.find((row) => row.id === target.id);
    const direct = target.kind === 'builtin' && target.id === 'DIRECT';
    if (!direct) exceptionPrefix = false;
    const layer = exceptionPrefix && direct ? 'exception' : 'base';
    const key = `${parts[0]}/${parts[1]}`;
    if (keys.has(key)) {
      warnings.push('历史重复规则按首条命中保留');
      continue;
    }
    keys.add(key);
    const rule: Rule = {
      id: randomUUID(),
      kind: parts[0],
      value: parts[1],
      target,
      layer,
      options: parts.slice(3),
    };
    if (group?.kind === 'scene') {
      rule.presetId = `migration-${group.id}`;
      if (!scheme.presets.some((preset) => preset.id === rule.presetId))
        scheme.presets.push({
          id: rule.presetId,
          name: group.name,
          source: '本机现有聚合',
          version: new Date().toISOString().slice(0, 10),
        });
    }
    scheme.rules.push(rule);
  }
  for (const source of workspace.sources) {
    const definition = Object.values(policy?.subscriptions ?? {}).find(
      (row: any) => row.localName === source.name,
    ) as any;
    for (const name of definition?.excludeNodes ?? [])
      scheme.excluded.push(nodeId(source.id, String(name)));
  }
  const stable = scheme.groups.find((group) => group.name === '🛡 稳定优先');
  if (stable && policy?.dynamicStability)
    scheme.monitor = {
      groupId: stable.id,
      settings: monitorSettingsSchema.parse(policy.dynamicStability),
    };
  const parsed = schemeSchema.parse(scheme);
  const preview = previewScheme(parsed, workspace);
  if (!preview.valid) throw new Error(`迁移校验未通过：${preview.issues[0].message}`);
  const position = workspace.schemes.findIndex((row) => row.id === 'default');
  if (position < 0) workspace.schemes.push(parsed);
  else workspace.schemes[position] = parsed;
  return {
    scheme: parsed,
    warnings: [...new Set(warnings)],
    sources: workspace.sources.length,
    nodes: scheme.members.length,
  };
}
