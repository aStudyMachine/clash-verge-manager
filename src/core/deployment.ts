import { randomUUID } from 'node:crypto';
import { acquireDevice } from './device-lease.js';
import { readFile, readdir, unlink, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { stringify } from 'yaml';
import { atomicWrite, inside, readText } from './storage.js';
import { privateSource, readIndex, yamlObject } from './sources.js';
import { digest, label, orderedRules, previewScheme } from './compiler.js';
import type { Device, Scheme, Workspace } from './model.js';
import type { Host, MonitorState } from './host.js';
import type { Runtime, RuntimeState } from './controller.js';

interface FileChange {
  path: string;
  before: string | null;
  afterHash: string;
}
export interface DeploymentRecord {
  id: string;
  pid: number;
  schemeId: string;
  schemeHash: string;
  startedAt: string;
  state: string;
  originalRunning: boolean;
  originalCurrent: string;
  monitor: MonitorState;
  monitorPaused: boolean;
  written: boolean;
  files: FileChange[];
  selections: Record<string, string>;
  backup: string;
  backupHash?: string;
  groupNames?: Record<string, string>;
  nodeNames?: Record<string, string>;
  kind?: 'refresh' | 'monitor';
  providers?: string[];
  originalRuntime?: RuntimeState;
  error?: string;
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const nodeTargets = (scheme: Scheme) => [
  ...new Set(
    [...scheme.rules.map((rule) => rule.target), scheme.defaultTarget]
      .filter((reference) => reference.kind === 'node')
      .map((reference) => reference.id),
  ),
];
const targetGroup = (id: string) => `cm-node-${digest(id).slice(0, 16)}`;

export async function prepareDeployment(workspace: Workspace, scheme: Scheme) {
  const device = workspace.device;
  if (!device) throw new Error('请先连接客户端');
  const preview = previewScheme(scheme, workspace);
  if (!preview.valid) throw new Error(`方案校验未通过：${preview.issues[0].message}`);
  const index = await readIndex(device.configDir);
  let owner: any = null;
  try {
    owner = JSON.parse(await readText(await inside(device.configDir, 'config-manager/owner.json')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const matches = index.items.filter((item: any) => item.name === '订阅聚合');
  if (matches.length > 1) throw new Error('存在多个同名聚合，请先区分');
  const target = owner ? index.items.find((item: any) => item.uid === owner.ids.local) : matches[0];
  if (owner && !target) throw new Error('受管聚合入口已缺失，需显式恢复');
  if (target && target.type !== 'local') throw new Error('同名入口不是受管本地聚合');
  if (target && !owner) {
    const oldScript = index.items.find((item: any) => item.uid === target.option?.script);
    if (
      !oldScript ||
      !(await readText(await inside(device.configDir, `profiles/${oldScript.file}`))).includes(
        'aggregatePolicy',
      )
    )
      throw new Error('同名聚合无法安全识别，停止接管');
  }
  const ids = owner?.ids ?? {
    local: target?.uid ?? `cm${randomUUID().replaceAll('-', '')}`,
    merge: `cm${randomUUID().replaceAll('-', '')}`,
    script: `cm${randomUUID().replaceAll('-', '')}`,
  };
  for (const kind of ['merge', 'script']) {
    const reference = owner ? ids[kind] : target?.option?.[kind];
    if (
      reference &&
      index.items.some((item: any) => item.uid !== ids.local && item.option?.[kind] === reference)
    )
      throw new Error('专属扩展被其他订阅共享，停止接管');
  }
  let base: Record<string, any> = { mode: 'rule' };
  const originalBase = target ?? index.items.find((item: any) => item.uid === index.current);
  if (originalBase)
    base = yamlObject(
      await readText(await inside(device.configDir, `profiles/${originalBase.file}`)),
    );
  delete base['proxy-groups'];
  delete base['proxy-providers'];
  delete base.rules;
  base.proxies = [];
  const payload: Record<string, string> = {};
  const providers: Record<string, any> = {};
  const rawNodes = new Map<string, Record<string, unknown>>();
  const subscriptionHosts = new Set<string>();
  for (const sourceId of scheme.sourceIds) {
    const source = workspace.sources.find((row) => row.id === sourceId)!;
    const snapshot = await privateSource(workspace, source);
    subscriptionHosts.add(new URL(snapshot.url).hostname);
    for (const node of workspace.nodes.filter(
      (row) => row.sourceId === sourceId && scheme.members.includes(row.id),
    )) {
      const raw = snapshot.nodes.find((row) => row.name === node.name);
      if (!raw) throw new Error('固定节点的私有快照不完整');
      rawNodes.set(node.id, { ...raw, name: node.displayName });
    }
  }
  const groups = await Promise.all(
    scheme.groups.map(async (group) => {
      const nodeMembers = group.members.filter((member) => member.kind === 'node');
      const providerName = `cm-${digest(group.id).slice(0, 16)}`;
      if (nodeMembers.length) {
        const relative = `config-manager/providers/${providerName}.yaml`;
        payload[relative] = stringify({
          proxies: nodeMembers.map((member) => rawNodes.get(member.id)),
        });
        providers[providerName] = {
          type: 'file',
          path: await inside(device.configDir, relative),
          'health-check': {
            enable: true,
            url: group.url,
            interval: group.interval,
            timeout: group.timeout,
            lazy: group.strategy === 'select',
          },
        };
      }
      return {
        name: group.name,
        type: group.strategy,
        proxies: group.members
          .filter((member) => member.kind !== 'node')
          .map((member) => label(member, scheme, workspace)),
        ...(nodeMembers.length
          ? {
              use: [providerName],
              filter: group.members
                .map((member) => `^${escapeRegex(label(member, scheme, workspace))}$`)
                .join('`'),
            }
          : {}),
        ...(group.strategy === 'select'
          ? {}
          : {
              url: group.url,
              interval: group.interval,
              timeout: group.timeout,
              tolerance: group.tolerance,
              lazy: false,
            }),
      };
    }),
  );
  const localExceptions = [...subscriptionHosts].sort().map((host) => `DOMAIN,${host},DIRECT`);
  for (const id of nodeTargets(scheme)) {
    const name = targetGroup(id);
    const providerName = `cm-target-${digest(id).slice(0, 16)}`;
    const relative = `config-manager/providers/${providerName}.yaml`;
    payload[relative] = stringify({ proxies: [rawNodes.get(id)] });
    providers[providerName] = { type: 'file', path: await inside(device.configDir, relative) };
    groups.push({
      name,
      type: 'select',
      proxies: [],
      use: [providerName],
      filter: `^${escapeRegex(label({ kind: 'node', id }, scheme, workspace))}$`,
      hidden: true,
    } as any);
  }
  const targetLabel = (reference: import('./model.js').Reference) =>
    reference.kind === 'node' ? targetGroup(reference.id) : label(reference, scheme, workspace);
  const compiledRules = orderedRules(scheme).map((rule) =>
    [rule.kind, rule.value, targetLabel(rule.target), ...rule.options].join(','),
  );
  compiledRules.push(`MATCH,${targetLabel(scheme.defaultTarget)}`);
  const generated = {
    'proxy-providers': providers,
    'proxy-groups': groups,
    rules: [...localExceptions, ...compiledRules],
    proxies: [],
  };
  const stable = scheme.groups.find((group) => group.id === scheme.monitor?.groupId);
  payload['config-manager/monitor/binding.json'] = JSON.stringify(
    stable && scheme.monitor
      ? {
          schemaVersion: 1,
          enabled: scheme.monitor.settings.enabled,
          schemeId: scheme.id,
          hash: preview.hash,
          groupName: stable.name,
          providerName: `cm-${digest(stable.id).slice(0, 16)}`,
          names: stable.members.map((member) => label(member, scheme, workspace)),
          settings: scheme.monitor.settings,
          dataRevision: digest(stable.members.map((member) => rawNodes.get(member.id))),
        }
      : { schemaVersion: 1, enabled: false },
  );
  const result = structuredClone(index);
  for (const source of workspace.sources.filter((source) => source.cardPending)) {
    if (source.deleted && !source.uid) continue;
    if (!source.uid) throw new Error('来源缺少本机绑定标识');
    const sourceItem = result.items.find((item: any) => item.uid === source.uid);
    if (sourceItem && sourceItem.type !== 'remote')
      throw new Error('来源卡片标识与已有 profile 类型冲突');
    if (source.deleted) {
      result.items = result.items.filter((item: any) => item.uid !== source.uid);
      continue;
    }
    const snapshot = await privateSource(workspace, source);
    const item = sourceItem ?? {
      uid: source.uid,
      type: 'remote',
      name: source.name,
      file: `${source.uid}.yaml`,
    };
    if (
      !sourceItem &&
      result.items.some((row: any) => row.file.toLowerCase() === item.file.toLowerCase())
    )
      throw new Error('新增来源缓存文件名冲突');
    if (!sourceItem) result.items.push(item);
    item.url = snapshot.url;
    item.name = source.name;
    item.updated = Math.floor(Date.now() / 1000);
    item.option = {
      ...(item.option ?? {}),
      update_interval: Math.max(1, Math.round((source.intervalSeconds ?? 7200) / 60)),
    };
    if (Object.keys(source.metadata).length) item.extra = source.metadata;
    payload[`profiles/${item.file}`] =
      snapshot.documentText ?? stringify({ proxies: snapshot.nodes });
  }
  for (const kind of ['local', 'merge', 'script']) {
    let item = result.items.find((row: any) => row.uid === ids[kind]);
    if (!item) {
      item = {
        uid: ids[kind],
        type: kind,
        name: kind === 'local' ? '订阅聚合' : `配置管理器 · ${kind}`,
        file: `${ids[kind]}.${kind === 'script' ? 'js' : 'yaml'}`,
      };
      if (result.items.some((row: any) => row.file.toLowerCase() === item.file.toLowerCase()))
        throw new Error('受管文件名称冲突');
      result.items.push(item);
    }
    payload[`profiles/${item.file}`] =
      kind === 'local'
        ? stringify(base)
        : kind === 'merge'
          ? stringify({ 'proxy-providers': providers })
          : `// 由配置管理器生成，修改请使用方案编辑器。\nfunction main(config) { return Object.assign(config, ${JSON.stringify(generated)}); }\n`;
    if (kind === 'local')
      item.option = { ...(item.option ?? {}), merge: ids.merge, script: ids.script };
  }
  result.current = ids.local;
  payload['profiles.yaml'] = stringify(result);
  const ownedPaths = new Set(
    result.items
      .filter((item: any) => Object.values(ids).includes(item.uid))
      .map((item: any) => `profiles/${item.file}`),
  );
  const managedFiles = Object.fromEntries(
    Object.entries(payload)
      .filter(([file]) => ownedPaths.has(file))
      .map(([file, content]) => [file, digest(content)]),
  );
  payload['config-manager/owner.json'] = JSON.stringify({
    schemaVersion: 1,
    ids,
    schemeId: scheme.id,
    schemeHash: preview.hash,
    managedFiles,
    groupNames: Object.fromEntries(scheme.groups.map((group) => [group.id, group.name])),
    nodeNames: Object.fromEntries(
      scheme.members.map((id) => [id, label({ kind: 'node', id }, scheme, workspace)]),
    ),
  });
  return { payload, index: result, config: { ...base, ...generated }, preview, ids };
}

export class Deployment {
  constructor(
    private readonly host: Host,
    private readonly runtime: Runtime,
    private readonly progress: (state: string) => void,
  ) {}

  private async save(device: Device, record: DeploymentRecord): Promise<void> {
    await atomicWrite(
      await inside(device.configDir, `config-manager/transactions/${record.id}.json`),
      JSON.stringify(record, null, 2),
    );
    this.progress(record.state);
  }

  private async stage(
    device: Device,
    plan: Awaited<ReturnType<typeof prepareDeployment>>,
    configFile: string,
  ): Promise<void> {
    const config = structuredClone(plan.config);
    for (const [name, declaration] of Object.entries(config['proxy-providers'])) {
      const source = path.relative(device.configDir, declaration.path).replaceAll('\\', '/');
      const content = plan.payload[source];
      if (!content) throw new Error('预检 provider 内容缺失');
      const staged = path.join(path.dirname(configFile), `${name}.yaml`);
      await atomicWrite(staged, content);
      declaration.path = staged;
    }
    await atomicWrite(configFile, stringify(config));
    for (const name of ['geoip.dat', 'geosite.dat', 'Country.mmdb', 'ASN.mmdb']) {
      try {
        await copyFile(
          await inside(device.configDir, name),
          path.join(path.dirname(configFile), name),
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
  }

  async history(device: Device): Promise<DeploymentRecord[]> {
    const directory = await inside(device.configDir, 'config-manager/transactions');
    let files: string[];
    try {
      files = await readdir(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    return Promise.all(
      files
        .filter((file) => /^[a-f0-9-]{36}\.json$/.test(file))
        .sort()
        .map(async (file) => JSON.parse(await readText(path.join(directory, file)))),
    );
  }

  private async restore(device: Device, record: DeploymentRecord): Promise<void> {
    if (record.written) {
      const backup = await readText(await inside(device.configDir, `${record.backup}/record.json`));
      if (!record.backupHash || digest(backup) !== record.backupHash)
        throw new Error('恢复备份校验失败');
      const saved = JSON.parse(backup) as DeploymentRecord;
      if (JSON.stringify(saved.files) !== JSON.stringify(record.files))
        throw new Error('恢复文件清单与备份不符');
      if (record.kind !== 'refresh' && (await this.host.running(device)))
        throw new Error('恢复前请正常退出客户端');
      for (const file of record.files) {
        let current: string | null = null;
        try {
          current = await readText(await inside(device.configDir, file.path));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        const before =
          file.before === null ? null : Buffer.from(file.before, 'base64').toString('utf8');
        if (
          (current === null && before !== null) ||
          (current !== null &&
            digest(current) !== file.afterHash &&
            (before === null || digest(current) !== digest(before)))
        )
          throw new Error('配置存在后续修改，停止覆盖恢复');
      }
      const monitor = await this.host.monitorStatus(device);
      if (monitor.running) {
        record.monitorPaused = true;
        await this.save(device, record);
        await this.host.pauseMonitor(device, monitor);
      }
      for (const file of [...record.files].reverse()) {
        const target = await inside(device.configDir, file.path);
        let current: Buffer | null = null;
        try {
          current = await readFile(target);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        if (
          current &&
          digest(current.toString('utf8')) !== file.afterHash &&
          (file.before === null ||
            digest(current.toString('utf8')) !==
              digest(Buffer.from(file.before, 'base64').toString('utf8')))
        )
          throw new Error('配置存在后续修改，停止覆盖恢复');
        if (file.before !== null) await atomicWrite(target, Buffer.from(file.before, 'base64'));
        else if (current) {
          const retained = await inside(
            device.configDir,
            `${record.backup}/new-files/${digest(file.path)}.txt`,
          );
          await atomicWrite(retained, current);
          await unlink(target);
        }
      }
      if (record.kind === 'refresh')
        for (const provider of record.providers ?? []) await this.runtime.refresh(provider);
    }
    if (record.originalRunning && !(await this.host.running(device))) await this.host.start(device);
    if (record.originalRunning) {
      await this.readReady();
      await this.restoreSelections(record.selections);
      if ((await readIndex(device.configDir)).current !== record.originalCurrent)
        throw new Error('恢复后的原活动入口不符');
      const actual = this.runtimeBaseline(await this.runtime.read());
      if (
        !record.originalRuntime ||
        digest(this.runtimeStructure(actual)) !==
          digest(this.runtimeStructure(record.originalRuntime))
      )
        throw new Error('原运行配置尚未通过恢复核验');
    }
    if (record.monitorPaused) {
      const currentMonitor = await this.host.monitorStatus(device);
      if (currentMonitor.running) await this.host.pauseMonitor(device, currentMonitor);
      if (!record.monitor.exists && currentMonitor.exists) {
        if (!this.host.removeMonitor) throw new Error('无法恢复监测任务原先不存在的状态');
        await this.host.removeMonitor(device);
      } else await this.host.resumeMonitor(device, record.monitor);
    }
    record.state = 'restored';
    await this.save(device, record);
  }

  async changeMonitor(
    device: Device,
    operation: (original: MonitorState) => Promise<void>,
  ): Promise<void> {
    const release = await acquireDevice(this.host, device);
    let record: DeploymentRecord | undefined;
    try {
      if ((await this.history(device)).some((row) => !['verified', 'restored'].includes(row.state)))
        throw new Error('请先恢复未完成事务');
      const originalRunning = await this.host.running(device);
      const baseline = originalRunning
        ? this.runtimeBaseline(await this.runtime.read())
        : undefined;
      record = {
        id: randomUUID(),
        pid: process.pid,
        schemeId: 'monitor',
        schemeHash: '',
        startedAt: new Date().toISOString(),
        state: 'prepared',
        originalRunning,
        originalCurrent: String((await readIndex(device.configDir)).current ?? ''),
        monitor: await this.host.monitorStatus(device),
        monitorPaused: true,
        written: false,
        files: [],
        selections: {},
        backup: '',
        kind: 'monitor',
        originalRuntime: baseline,
      };
      await this.save(device, record);
      if (record.monitor.exists) await this.host.pauseMonitor(device, record.monitor);
      await operation(record.monitor);
      record.state = 'verified';
      await this.save(device, record);
    } catch (error) {
      if (record) {
        try {
          await this.restore(device, record);
        } catch {
          record.state = 'recovery-required';
          record.error = '监测操作未完成，原状态恢复需要从历史入口重试';
          await this.save(device, record);
        }
      }
      throw error;
    } finally {
      await release();
    }
  }

  private runtimeBaseline(state: RuntimeState): RuntimeState {
    return {
      proxies: Object.fromEntries(
        Object.entries(state.proxies)
          .filter(([, row]) => row.all)
          .map(([name, row]) => [name, { type: row.type, all: row.all, now: row.now }]),
      ),
      providers: Object.fromEntries(
        Object.entries(state.providers).map(([name, row]) => [
          name,
          { proxies: row.proxies?.map((node) => ({ name: node.name })) },
        ]),
      ),
      rules: state.rules,
    };
  }

  private runtimeStructure(state: RuntimeState) {
    return {
      ...state,
      proxies: Object.fromEntries(
        Object.entries(state.proxies).map(([name, row]) => [
          name,
          { type: row.type, all: row.all },
        ]),
      ),
    };
  }

  private async readReady(): Promise<RuntimeState> {
    const deadline = Date.now() + 45000;
    while (true) {
      try {
        return await this.runtime.read();
      } catch {
        if (Date.now() > deadline) throw new Error('运行控制器核验超时');
        await wait(500);
      }
    }
  }

  async refresh(workspace: Workspace): Promise<boolean> {
    const device = workspace.device;
    const scheme = workspace.applied?.snapshot;
    if (!device || !scheme || !(await this.host.running(device))) return false;
    if (!(await this.host.inspect(device)).supported) return false;
    const release = await acquireDevice(this.host, device);
    let record: DeploymentRecord | undefined;
    try {
      if ((await this.history(device)).some((row) => !['verified', 'restored'].includes(row.state)))
        throw new Error('存在未完成事务，暂停热刷新');
      const owner = JSON.parse(
        await readText(await inside(device.configDir, 'config-manager/owner.json')),
      );
      const index = await readIndex(device.configDir);
      const plan = await prepareDeployment(workspace, scheme);
      if (
        index.current !== owner.ids.local ||
        owner.schemeHash !== workspace.applied!.hash ||
        plan.preview.hash !== owner.schemeHash
      )
        return false;
      for (const [file, hash] of Object.entries(owner.managedFiles ?? {}))
        if (digest(await readText(await inside(device.configDir, file))) !== hash)
          throw new Error('受管结构已被外部修改，暂停热刷新');
      await this.verify(workspace, scheme, plan.config.rules);
      const entries = Object.entries(plan.payload).filter(
        ([file]) =>
          file.startsWith('config-manager/providers/') ||
          file === 'config-manager/monitor/binding.json',
      );
      const changed: [string, string][] = [];
      for (const entry of entries)
        if ((await readText(await inside(device.configDir, entry[0]))) !== entry[1])
          changed.push(entry);
      if (!changed.length) return true;
      const staging = await inside(
        device.configDir,
        `config-manager/staging/${randomUUID()}/config.yaml`,
      );
      await this.stage(device, plan, staging);
      await this.host.preflight(device, staging);
      record = {
        id: randomUUID(),
        pid: process.pid,
        schemeId: scheme.id,
        schemeHash: plan.preview.hash,
        startedAt: new Date().toISOString(),
        state: 'prepared',
        originalRunning: true,
        originalCurrent: index.current,
        monitor: await this.host.monitorStatus(device),
        monitorPaused: false,
        written: false,
        files: [],
        selections: {},
        backup: '',
        kind: 'refresh',
        providers: Object.keys(plan.config['proxy-providers']),
      };
      record.originalRuntime = this.runtimeBaseline(await this.runtime.read());
      await this.save(device, record);
      if (record.monitor.running || record.monitor.enabled) {
        record.monitorPaused = true;
        await this.save(device, record);
        await this.host.pauseMonitor(device, record.monitor);
      }
      if (
        (await readIndex(device.configDir)).current !== owner.ids.local ||
        digest(await readText(await inside(device.configDir, 'config-manager/owner.json'))) !==
          digest(JSON.stringify(owner))
      )
        throw new Error('刷新前活动方案发生变化');
      for (const [file, content] of changed)
        record.files.push({
          path: file,
          before: (await readFile(await inside(device.configDir, file))).toString('base64'),
          afterHash: digest(content),
        });
      record.backup = `profiles/backups/cm-${record.id}`;
      const backupText = JSON.stringify(record);
      const backup = await inside(device.configDir, `${record.backup}/record.json`);
      await atomicWrite(backup, backupText);
      if ((await readText(backup)) !== backupText) throw new Error('热刷新备份校验失败');
      record.backupHash = digest(backupText);
      record.written = true;
      record.state = 'applying';
      await this.save(device, record);
      for (const [file, content] of changed) {
        if (
          (await readFile(await inside(device.configDir, file))).toString('base64') !==
          record.files.find((row) => row.path === file)!.before
        )
          throw new Error('热刷新基线发生变化');
        await atomicWrite(await inside(device.configDir, file), content);
      }
      for (const provider of record.providers!) await this.runtime.refresh(provider);
      await this.verify(workspace, scheme, plan.config.rules);
      if (record.monitorPaused) await this.host.resumeMonitor(device, record.monitor);
      record.state = 'verified';
      await this.save(device, record);
      return true;
    } catch (error) {
      if (record) {
        try {
          await this.restore(device, record);
        } catch {
          record.state = 'recovery-required';
          await this.save(device, record);
        }
      }
      throw error;
    } finally {
      await release();
    }
  }

  async apply(
    workspace: Workspace,
    scheme: Scheme,
    signal: AbortSignal,
  ): Promise<{ id: string; hash: string; at: string }> {
    const device = workspace.device;
    if (!device) throw new Error('请先连接客户端');
    const capability = await this.host.inspect(device);
    if (!capability.supported) throw new Error('当前客户端版本未通过写入兼容校验，仅支持读取');
    const release = await acquireDevice(this.host, device);
    let record: DeploymentRecord | undefined;
    try {
      const pending = (await this.history(device)).filter(
        (row) => !['verified', 'restored'].includes(row.state),
      );
      if (pending.length) throw new Error('存在未完成应用事务，请先恢复');
      let plan = await prepareDeployment(workspace, scheme);
      const previous = (await this.history(device)).find(
        (row) =>
          row.id === workspace.applied?.deploymentId &&
          row.state === 'verified' &&
          row.schemeHash === plan.preview.hash,
      );
      if (previous && (await this.host.running(device))) {
        let unchanged = true;
        for (const [relative, content] of Object.entries(plan.payload)) {
          try {
            if ((await readText(await inside(device.configDir, relative))) !== content)
              unchanged = false;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            unchanged = false;
          }
        }
        if (unchanged) {
          await this.verify(workspace, scheme, plan.config.rules);
          this.progress('verified');
          return { id: previous.id, hash: previous.schemeHash, at: new Date().toISOString() };
        }
      }
      const staging = await inside(
        device.configDir,
        `config-manager/staging/${randomUUID()}/config.yaml`,
      );
      await this.stage(device, plan, staging);
      await this.host.preflight(device, staging);
      const originalRunning = await this.host.running(device);
      let selections: Record<string, string> = {};
      let originalRuntime: RuntimeState | undefined;
      if (originalRunning) {
        const runtime = await this.runtime.read();
        originalRuntime = this.runtimeBaseline(runtime);
        selections = Object.fromEntries(
          Object.entries(runtime.proxies)
            .filter(([, row]) => row.type === 'Selector' && row.now)
            .map(([name, row]) => [name, row.now!]),
        );
      }
      record = {
        id: randomUUID(),
        pid: process.pid,
        schemeId: scheme.id,
        schemeHash: plan.preview.hash,
        startedAt: new Date().toISOString(),
        state: 'prepared',
        originalRunning,
        originalCurrent: String((await readIndex(device.configDir)).current ?? ''),
        monitor: await this.host.monitorStatus(device),
        monitorPaused: false,
        written: false,
        files: [],
        selections,
        backup: '',
      };
      record.originalRuntime = originalRuntime;
      try {
        const owner = JSON.parse(
          await readText(await inside(device.configDir, 'config-manager/owner.json')),
        );
        record.groupNames = owner.groupNames;
        record.nodeNames = owner.nodeNames;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      await this.save(device, record);
      if (record.monitor.exists && (record.monitor.running || record.monitor.enabled)) {
        record.monitorPaused = true;
        record.state = 'pausing-monitor';
        await this.save(device, record);
        await this.host.pauseMonitor(device, record.monitor);
      }
      record.state = 'waiting-exit';
      await this.save(device, record);
      const deadline = Date.now() + 120000;
      while (await this.host.running(device)) {
        if (signal.aborted || Date.now() > deadline) throw new Error('客户端退出等待已取消或超时');
        await wait(500);
      }
      if (signal.aborted) throw new Error('应用已取消');
      if (String((await readIndex(device.configDir)).current ?? '') !== record.originalCurrent)
        throw new Error('退出期间活动入口已改变，请重新预览');
      plan = await prepareDeployment(workspace, scheme);
      await this.stage(device, plan, staging);
      await this.host.preflight(device, staging);
      record.state = 'backing-up';
      record.backup = `profiles/backups/cm-${record.id}`;
      await this.save(device, record);
      const changes: FileChange[] = [];
      const entries = Object.entries(plan.payload).sort(([a], [b]) =>
        a === 'profiles.yaml' ? 1 : b === 'profiles.yaml' ? -1 : a.localeCompare(b),
      );
      for (const [relative, content] of entries) {
        const file = await inside(device.configDir, relative);
        let before: Buffer | null = null;
        try {
          before = await readFile(file);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        changes.push({
          path: relative,
          before: before?.toString('base64') ?? null,
          afterHash: digest(content),
        });
      }
      record.files = changes;
      const backup = await inside(device.configDir, `${record.backup}/record.json`);
      const backupText = JSON.stringify(record);
      await atomicWrite(backup, backupText);
      if ((await readText(backup)) !== backupText) throw new Error('备份校验失败');
      record.backupHash = digest(backupText);
      record.state = 'applying';
      record.written = true;
      await this.save(device, record);
      for (const [relative, content] of entries) {
        const target = await inside(device.configDir, relative);
        const baseline = changes.find((file) => file.path === relative)!;
        let current: string | null = null;
        try {
          current = (await readFile(target)).toString('base64');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        if (current !== baseline.before) throw new Error('备份后配置已变化，停止写入');
        await atomicWrite(target, content);
      }
      record.state = 'verifying';
      await this.save(device, record);
      await this.host.start(device);
      if ((await readIndex(device.configDir)).current !== plan.ids.local)
        throw new Error('客户端活动入口与受管方案不符');
      await this.verify(workspace, scheme, plan.config.rules);
      const renamed = Object.fromEntries(
        Object.entries(record.groupNames ?? {}).map(([id, oldName]) => [
          oldName,
          scheme.groups.find((group) => group.id === id)?.name ?? oldName,
        ]),
      );
      for (const [id, name] of Object.entries(record.nodeNames ?? {})) {
        const node = workspace.nodes.find((row) => row.id === id && scheme.members.includes(id));
        if (node) renamed[name] = node.displayName;
      }
      await this.restoreSelections(record.selections, renamed);
      await this.verify(workspace, scheme, plan.config.rules);
      if (record.monitorPaused && scheme.monitor?.settings.enabled)
        await this.host.resumeMonitor(device, { ...record.monitor, migrate: true });
      record.state = 'verified';
      await this.save(device, record);
      return { id: record.id, hash: record.schemeHash, at: new Date().toISOString() };
    } catch (error) {
      if (record) {
        try {
          await this.restore(device, record);
        } catch {
          record.state = 'recovery-required';
          record.error = '自动恢复未完成，请正常退出客户端后从恢复入口处理';
          await this.save(device, record);
          throw new Error(record.error);
        }
        throw new Error('应用未完成，已恢复原配置与运行状态');
      }
      throw error;
    } finally {
      await release();
    }
  }

  private async restoreSelections(
    selections: Record<string, string>,
    renamed: Record<string, string> = {},
  ): Promise<void> {
    if (!Object.keys(selections).length) return;
    const state = await this.runtime.read();
    for (const [oldName, oldValue] of Object.entries(selections)) {
      const name = renamed[oldName] ?? oldName;
      const value = renamed[oldValue] ?? oldValue;
      const group = state.proxies[name];
      if (group?.type === 'Selector' && group.all?.includes(value) && group.now !== value) {
        await this.runtime.select(name, value);
        if ((await this.runtime.read()).proxies[name]?.now !== value)
          throw new Error('有效手选恢复核验失败');
      }
    }
  }

  private async verify(
    workspace: Workspace,
    scheme: Scheme,
    expectedRules = previewScheme(scheme, workspace).rules,
  ): Promise<void> {
    const expected = previewScheme(scheme, workspace);
    const deadline = Date.now() + 45000;
    let state: RuntimeState;
    while (true) {
      try {
        state = await this.runtime.read();
        break;
      } catch {
        if (Date.now() > deadline) throw new Error('运行控制器核验超时');
        await wait(500);
      }
    }
    for (const group of expected.groups) {
      const actual = state.proxies[group.name];
      const type = { select: 'selector', 'url-test': 'urltest', fallback: 'fallback' }[group.type];
      if (
        !actual ||
        actual.type.toLowerCase() !== type ||
        JSON.stringify(actual.all) !== JSON.stringify(group.candidates)
      )
        throw new Error('运行代理组类型、候选或顺序与方案不符');
      if (
        !actual.now ||
        !actual.all?.includes(actual.now) ||
        (actual.fixed && !actual.all?.includes(actual.fixed))
      )
        throw new Error('运行代理组存在无效选择');
    }
    for (const group of scheme.groups.filter((group) =>
      group.members.some((member) => member.kind === 'node'),
    )) {
      const provider = state.providers[`cm-${digest(group.id).slice(0, 16)}`];
      const names = group.members
        .filter((member) => member.kind === 'node')
        .map((member) => label(member, scheme, workspace));
      if (
        !provider?.proxies?.length ||
        JSON.stringify(provider.proxies.map((node) => node.name)) !== JSON.stringify(names)
      )
        throw new Error('运行 provider 候选与方案不符');
    }
    for (const id of nodeTargets(scheme)) {
      const name = label({ kind: 'node', id }, scheme, workspace);
      const group = state.proxies[targetGroup(id)];
      const provider = state.providers[`cm-target-${digest(id).slice(0, 16)}`];
      if (
        group?.type !== 'Selector' ||
        group.now !== name ||
        JSON.stringify(group.all) !== JSON.stringify([name]) ||
        JSON.stringify(provider?.proxies?.map((node) => node.name)) !== JSON.stringify([name])
      )
        throw new Error('节点直接出口的运行候选不符');
    }
    if (state.rules.length !== expectedRules.length) throw new Error('运行规则数量与方案不符');
    const signature = (kind: string, payload: string, target: string): string => {
      let normalized = kind.replaceAll('-', '').replaceAll('_', '').toUpperCase();
      if (['IPCIDR', 'IPCIDR6'].includes(normalized) && payload.includes(':'))
        normalized = 'IPCIDR';
      return JSON.stringify([
        normalized,
        normalized === 'GEOIP' ? payload.toLowerCase() : payload,
        target,
      ]);
    };
    for (let index = 0; index < expectedRules.length; index++) {
      const parts = expectedRules[index].split(',');
      const target = parts[parts[0] === 'MATCH' ? 1 : 2];
      const actual = state.rules[index];
      if (
        signature(parts[0], parts[0] === 'MATCH' ? '' : parts[1], target) !==
        signature(actual.type, actual.payload ?? '', actual.proxy)
      )
        throw new Error(`第 ${index + 1} 条运行规则内容、顺序或出口不符`);
    }
  }

  async recover(device: Device, id: string): Promise<{ configurationChanged: boolean }> {
    const candidate = (await this.history(device)).find((row) => row.id === id);
    if (!candidate) throw new Error('恢复记录不存在');
    const release = await acquireDevice(this.host, device, candidate.pid);
    try {
      const record = (await this.history(device)).find((row) => row.id === id);
      if (!record) throw new Error('恢复记录不存在');
      if (record.state === 'restored') return { configurationChanged: false };
      const latest = (await this.history(device))
        .filter((row) => row.state !== 'restored')
        .sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
      if (latest && latest.id !== id) throw new Error('只能先恢复最近一次写入事务');
      await this.restore(device, record);
      return { configurationChanged: record.written && !record.kind };
    } finally {
      await release();
    }
  }
}
