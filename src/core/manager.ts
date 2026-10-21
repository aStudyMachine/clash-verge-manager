import { randomUUID } from 'node:crypto';
import { WorkspaceStore } from './storage.js';
import type { Command } from './model.js';
import { emptyScheme, schemeSchema } from './model.js';
import { explainRule, previewScheme } from './compiler.js';
import {
  absorbSource,
  adoptSource,
  downloadSource,
  readIndex,
  refreshSource,
  registerSource,
  sourceImpact,
  updateSource,
  parseNodes,
} from './sources.js';
import { stringify } from 'yaml';
import type { Downloader } from './sources.js';
import path from 'node:path';
import { access, readdir, readFile, realpath } from 'node:fs/promises';
import { SystemHost } from './host.js';
import type { Host } from './host.js';
import { Controller } from './controller.js';
import type { Runtime } from './controller.js';
import { Deployment, prepareDeployment } from './deployment.js';
import { fileURLToPath } from 'node:url';
import { atomicWrite } from './storage.js';
import { compareVersions, GitRemote, Publisher } from './shared.js';
import type { SharedRemote } from './shared.js';
import { digest } from './compiler.js';
import { migrate } from './migration.js';
import { applyPreset, presetCatalog, reviewPreset } from './presets.js';
import { affected, removeObject } from './editing.js';
import { inside, readText } from './storage.js';
import { MonitorRunner, type MonitorBinding } from './monitor.js';

export class Manager {
  private readonly store: WorkspaceStore;
  private abort?: AbortController;
  private progress = 'idle';
  private queue: Promise<unknown> = Promise.resolve();

  private async validateNodes(
    workspace: import('./model.js').Workspace,
    nodes: Record<string, unknown>[],
  ): Promise<void> {
    if (!workspace.device?.corePath) return;
    const host =
      this.options.host ??
      new SystemHost(
        this.options.resourcesDir ?? fileURLToPath(new URL('../../resources/', import.meta.url)),
      );
    if (!(await host.inspect(workspace.device)).supported)
      throw new Error('客户端与内核尚未通过兼容校验');
    const file = await inside(
      workspace.device.configDir,
      `config-manager/source-validation/${randomUUID()}/config.yaml`,
    );
    await atomicWrite(
      file,
      stringify({
        mode: 'rule',
        proxies: nodes,
        'proxy-providers': {},
        'proxy-groups': [],
        rules: ['MATCH,DIRECT'],
        tun: { enable: false },
        dns: { enable: false },
      }),
    );
    await host.preflight(workspace.device, file);
  }

  private checkedDownload(workspace: import('./model.js').Workspace): Downloader {
    return async (url) => {
      const downloaded = await (this.options.download ?? downloadSource)(url);
      await this.validateNodes(workspace, parseNodes(downloaded.text));
      return downloaded;
    };
  }

  private async refreshRuntime(
    workspace: import('./model.js').Workspace,
    sourceId: string,
  ): Promise<void> {
    const source = workspace.sources.find((row) => row.id === sourceId);
    if (
      !source ||
      source.stale ||
      !workspace.device ||
      !workspace.applied?.snapshot?.sourceIds.includes(sourceId)
    )
      return;
    const host =
      this.options.host ??
      new SystemHost(
        this.options.resourcesDir ?? fileURLToPath(new URL('../../resources/', import.meta.url)),
      );
    try {
      const refreshed = await new Deployment(
        host,
        this.options.runtime ?? new Controller(workspace.device),
        () => {},
      ).refresh(workspace);
      if (refreshed) {
        source.runtimeAt = new Date().toISOString();
        delete source.runtimeError;
      } else source.runtimeError = '运行方案不满足热刷新条件，请预览并应用';
    } catch {
      source.runtimeError = '运行刷新未完成，已保留恢复记录，请检查应用历史';
    }
  }

  async settle(): Promise<void> {
    await this.queue;
  }

  constructor(
    readonly options: {
      dataDir: string;
      download?: Downloader;
      host?: Host;
      runtime?: Runtime;
      resourcesDir?: string;
      gitPath?: string;
      allowFileRemote?: boolean;
      remote?: SharedRemote;
      now?: () => Date;
    },
  ) {
    this.store = new WorkspaceStore(options.dataDir);
  }

  async execute(command: Command): Promise<any> {
    if (
      [
        'workspace.read',
        'deployment.cancel',
        'deployment.status',
        'device.inspect',
        'deployment.history',
        'preset.catalog',
        'scheme.preview',
        'rule.explain',
        'scheme.impact',
        'source.impact',
        'preset.review',
        'monitor.status',
        'runtime.status',
      ].includes(command.type)
    )
      return this.run(command);
    const result = this.queue.then(() => this.run(command));
    this.queue = result.catch(() => undefined);
    return result;
  }

  private async run(command: Command): Promise<any> {
    if (command.type === 'deployment.cancel') {
      this.abort?.abort();
      return { cancelled: true };
    }
    if (command.type === 'deployment.status') return { phase: this.progress };
    const workspace = await this.store.read();
    if (command.type === 'device.discover') {
      const host =
        this.options.host ??
        new SystemHost(
          this.options.resourcesDir ?? fileURLToPath(new URL('../../resources/', import.meta.url)),
        );
      if (!host.discover) throw new Error('当前环境不支持自动发现');
      return host.discover();
    }
    if (command.type === 'workspace.read') return workspace;
    if (command.type === 'recovery.list') {
      let files: string[];
      try {
        files = await readdir(path.join(this.options.dataDir, 'recovery'));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        files = [];
      }
      return Promise.all(
        files
          .filter((file) => /^[a-f0-9-]+\.json$/.test(file))
          .map(async (key) => {
            const scheme = schemeSchema.parse(
              JSON.parse(await readFile(path.join(this.options.dataDir, 'recovery', key), 'utf8')),
            );
            return { key, name: scheme.name, schemeId: scheme.id };
          }),
      );
    }
    if (command.type === 'recovery.restore') {
      if (!/^[a-f0-9-]+\.json$/.test(command.key)) throw new Error('恢复快照标识无效');
      const recovered = schemeSchema.parse(
        JSON.parse(
          await readFile(path.join(this.options.dataDir, 'recovery', command.key), 'utf8'),
        ),
      );
      const position = workspace.schemes.findIndex((row) => row.id === recovered.id);
      if (position >= 0) workspace.schemes[position] = recovered;
      else workspace.schemes.push(recovered);
      await this.store.write(workspace);
      return recovered;
    }
    if (command.type === 'scheme.clone') {
      const original = workspace.schemes.find((row) => row.id === command.schemeId);
      if (!original) throw new Error('方案不存在');
      if (!command.name.trim() || workspace.schemes.some((row) => row.name === command.name.trim()))
        throw new Error('方案名称为空或重复');
      const copied = structuredClone(original);
      copied.id = randomUUID();
      copied.name = command.name.trim();
      workspace.schemes.push(copied);
      await this.store.write(workspace);
      return copied;
    }
    if (command.type === 'scheme.remove') {
      if (workspace.applied?.schemeId === command.schemeId)
        throw new Error('当前生效方案须先应用其他有效方案再删除');
      if (!workspace.schemes.some((row) => row.id === command.schemeId))
        throw new Error('方案不存在');
      workspace.schemes = workspace.schemes.filter((row) => row.id !== command.schemeId);
      workspace.deletedSchemes = [
        ...new Set([...(workspace.deletedSchemes ?? []), command.schemeId]),
      ];
      await this.store.write(workspace);
      return { removed: true };
    }
    if (command.type === 'scheme.impact' || command.type === 'scheme.removeObject') {
      const scheme = workspace.schemes.find((row) => row.id === command.schemeId);
      if (!scheme) throw new Error('方案不存在');
      const impact = affected(scheme, workspace, command.kind, command.id);
      if (command.type === 'scheme.impact')
        return { groups: impact.groups, rules: impact.rules, defaultTarget: impact.defaultTarget };
      removeObject(
        scheme,
        workspace,
        command.kind,
        command.id,
        command.replacement,
        command.removeReferences,
      );
      await this.store.write(workspace);
      return scheme;
    }
    if (command.type === 'preset.catalog') return presetCatalog();
    if (command.type === 'preset.review' || command.type === 'preset.apply') {
      const scheme = workspace.schemes.find((row) => row.id === command.schemeId);
      if (!scheme) throw new Error('方案不存在');
      if (command.type === 'preset.review')
        return reviewPreset(scheme, command.presetId, command.groupId);
      applyPreset(scheme, command.presetId, command.groupId, command.addIds, command.removeIds);
      await this.store.write(workspace);
      return scheme;
    }
    if (command.type === 'migration.import') {
      const result = await migrate(workspace, command.confirmOverwrite, (nodes) =>
        this.validateNodes(workspace, nodes),
      );
      await this.store.write(workspace);
      return result;
    }
    if (command.type === 'git.configure') {
      if (workspace.sync?.pending && workspace.sync.remote !== command.remote)
        throw new Error('请先核对并结束待确认发布，再更换远端');
      new GitRemote({
        dataDir: this.options.dataDir,
        remote: command.remote,
        gitPath: this.options.gitPath ?? 'git',
        allowFileRemote: this.options.allowFileRemote,
      });
      workspace.sync = { remote: command.remote, heads: {} };
      await this.store.write(workspace);
      return { configured: true };
    }
    if (command.type === 'git.authenticate') {
      if (!workspace.sync) throw new Error('请先保存私有 Git 地址');
      await new GitRemote({
        dataDir: this.options.dataDir,
        remote: workspace.sync.remote,
        gitPath: this.options.gitPath ?? 'git',
        allowFileRemote: this.options.allowFileRemote,
      }).authenticate();
      return { authenticated: true };
    }
    if (command.type === 'git.resolvePending') {
      if (!workspace.sync?.pending) return { resolved: true };
      const remote =
        this.options.remote ??
        new GitRemote({
          dataDir: this.options.dataDir,
          remote: workspace.sync.remote,
          gitPath: this.options.gitPath ?? 'git',
          allowFileRemote: this.options.allowFileRemote,
        });
      const fetched = await remote.read();
      const accepted = !!fetched.data.requests?.[workspace.sync.pending.requestId];
      delete workspace.sync.pending;
      await this.store.write(workspace);
      return { resolved: true, accepted };
    }
    if (
      command.type === 'scheme.publish' ||
      command.type === 'git.publishChanges' ||
      command.type === 'git.fetch' ||
      command.type === 'git.history'
    ) {
      if (!workspace.sync) throw new Error('请先配置私有 Git 仓库');
      const publisher = new Publisher(
        this.options.remote ??
          new GitRemote({
            dataDir: this.options.dataDir,
            remote: workspace.sync.remote,
            gitPath: this.options.gitPath ?? 'git',
            allowFileRemote: this.options.allowFileRemote,
          }),
        this.options.now ?? (() => new Date()),
      );
      if (command.type === 'scheme.publish' || command.type === 'git.publishChanges') {
        const scheme =
          command.type === 'scheme.publish'
            ? workspace.schemes.find((row) => row.id === command.schemeId)
            : undefined;
        if (command.type === 'scheme.publish' && !scheme) throw new Error('方案不存在');
        const pending = workspace.sync.pending;
        if (
          pending &&
          (pending.scheme?.id !== scheme?.id ||
            (scheme && digest(pending.scheme) !== digest(scheme)))
        )
          throw new Error('上次发布结果未确认，请先重试原发布');
        const related = command.type === 'git.publishChanges' ? workspace.schemes : [scheme!];
        workspace.sync.pending = pending ?? {
          requestId: randomUUID(),
          scheme,
          schemes: related,
          sources: structuredClone(workspace.sources),
          deletedSchemes: workspace.deletedSchemes ?? [],
          summary: command.summary,
        };
        await this.store.write(workspace);
        const request = workspace.sync.pending;
        const result = await publisher.publishBatch(
          request.schemes,
          request.sources,
          request.deletedSchemes,
          request.summary,
          request.requestId,
        );
        for (const [id, snapshot] of Object.entries(result))
          workspace.sync.heads[id] = { version: snapshot.version, hash: snapshot.hash };
        workspace.sync.checkedAt = new Date().toISOString();
        delete workspace.sync.pending;
        for (const source of workspace.sources)
          if (digest(request.sources.find((row) => row.id === source.id)) === digest(source))
            source.dirty = false;
        workspace.deletedSchemes = [];
        await this.store.write(workspace);
        return scheme
          ? { version: result[scheme.id].version, hash: result[scheme.id].hash }
          : { published: Object.keys(result).length, deleted: request.deletedSchemes.length };
      }
      const remote = await publisher.fetch();
      if (command.type === 'git.history')
        return Object.values(remote.schemes[command.schemeId]?.versions ?? {}).sort((a, b) =>
          compareVersions(b.version, a.version),
        );
      for (const source of Object.values(remote.catalog.sources)) {
        const local = workspace.sources.find((row) => row.id === source.id);
        if (local)
          Object.assign(local, {
            name: source.name,
            prefix: source.prefix,
            deleted: source.deleted,
            dirty: false,
          });
        else workspace.sources.push({ ...source, metadata: {} });
      }
      for (const [id, record] of Object.entries(remote.schemes)) {
        if (record.deleted) {
          const local = workspace.schemes.find((scheme) => scheme.id === id);
          if (local)
            await atomicWrite(
              path.join(this.options.dataDir, 'recovery', `${digest(id)}-${randomUUID()}.json`),
              JSON.stringify(local),
            );
          workspace.schemes = workspace.schemes.filter((scheme) => scheme.id !== id);
          continue;
        }
        const snapshot = record.versions[record.head];
        const previous = workspace.sync.heads[id];
        if (!previous || compareVersions(snapshot.version, previous.version) > 0) {
          const position = workspace.schemes.findIndex((scheme) => scheme.id === id);
          if (position >= 0) {
            const local = workspace.schemes[position];
            if (digest(local) !== snapshot.hash)
              await atomicWrite(
                path.join(this.options.dataDir, 'recovery', `${digest(id)}-${randomUUID()}.json`),
                JSON.stringify(local),
              );
            workspace.schemes[position] = snapshot.scheme;
          } else workspace.schemes.push(snapshot.scheme);
          workspace.sync.heads[id] = { version: snapshot.version, hash: snapshot.hash };
        } else if (
          compareVersions(snapshot.version, previous.version) === 0 &&
          snapshot.hash !== previous.hash
        )
          throw new Error('方案版本相同但摘要不同');
      }
      workspace.sync.checkedAt = new Date().toISOString();
      for (const node of workspace.nodes)
        node.displayName =
          (workspace.sources.find((source) => source.id === node.sourceId)?.prefix ?? '') +
          node.name;
      for (const scheme of workspace.schemes)
        for (const id of scheme.members) {
          const reference = scheme.nodeRefs[id];
          if (reference && !workspace.nodes.some((node) => node.id === id))
            workspace.nodes.push({
              id,
              sourceId: reference.sourceId,
              name: reference.name,
              displayName:
                (workspace.sources.find((source) => source.id === reference.sourceId)?.prefix ??
                  '') + reference.name,
              protocol: 'unknown',
              missing: true,
            });
        }
      await this.store.write(workspace);
      return { fetched: true };
    }
    if (command.type === 'device.connect') {
      if (!path.isAbsolute(command.configDir)) throw new Error('配置目录必须为绝对路径');
      const configDir = await realpath(command.configDir);
      await readIndex(configDir);
      await access(path.join(configDir, 'verge.yaml'));
      if (workspace.device && workspace.device.configDir !== configDir) {
        workspace.applied = null;
        for (const source of workspace.sources) {
          delete source.uid;
          delete source.privateRevision;
          delete source.clientHash;
          source.cardPending = false;
        }
        workspace.nodes = workspace.nodes.map((node) => ({ ...node, missing: true }));
      }
      workspace.device = { configDir, appPath: command.appPath, corePath: command.corePath };
      await this.store.write(workspace);
      return workspace.device;
    }
    if (command.type === 'device.inspect') {
      if (!workspace.device) return { profiles: [], current: null };
      const index = await readIndex(workspace.device.configDir);
      const host =
        this.options.host ??
        new SystemHost(
          this.options.resourcesDir ?? fileURLToPath(new URL('../../resources/', import.meta.url)),
        );
      const capability = await host.inspect(workspace.device);
      return {
        current: index.current,
        capability,
        profiles: index.items.map((item: any) => ({
          uid: item.uid,
          type: item.type,
          name: item.name,
        })),
      };
    }
    if (command.type === 'runtime.status') {
      if (!workspace.device) return { available: false, groups: {} };
      try {
        const runtime = await (this.options.runtime ?? new Controller(workspace.device)).read();
        return {
          available: true,
          groups: Object.fromEntries(
            Object.entries(runtime.proxies)
              .filter(([, value]) => value.all)
              .map(([name, value]) => [
                name,
                { type: value.type, all: value.all, now: value.now, fixed: value.fixed },
              ]),
          ),
        };
      } catch {
        return { available: false, groups: {} };
      }
    }
    if (
      command.type === 'monitor.status' ||
      command.type === 'monitor.start' ||
      command.type === 'monitor.stop' ||
      command.type === 'monitor.preview'
    ) {
      if (!workspace.device) throw new Error('请先连接客户端');
      const device = workspace.device;
      const host =
        this.options.host ??
        new SystemHost(
          this.options.resourcesDir ?? fileURLToPath(new URL('../../resources/', import.meta.url)),
        );
      const state = await host.monitorStatus(device);
      let status: unknown = null;
      try {
        status = JSON.parse(
          await readText(await inside(device.configDir, 'config-manager/monitor/status.json')),
        );
      } catch {}
      if (command.type === 'monitor.status')
        return {
          task: {
            exists: state.exists,
            running: state.running,
            enabled: state.enabled,
            legacy: state.legacy,
          },
          status,
        };
      const binding = JSON.parse(
        await readText(await inside(device.configDir, 'config-manager/monitor/binding.json')),
      ) as MonitorBinding;
      if (!binding.enabled) throw new Error('当前应用方案没有启用现有稳定池监测');
      const guard = async () => {
        const owner = JSON.parse(
          await readText(await inside(device.configDir, 'config-manager/owner.json')),
        );
        const index = await readIndex(device.configDir);
        if (owner.schemeHash !== binding.hash || index.current !== owner.ids.local)
          throw new Error('当前活动聚合与监测绑定不符');
      };
      if (command.type === 'monitor.start') {
        await guard();
        await new Deployment(
          host,
          this.options.runtime ?? new Controller(device),
          () => {},
        ).changeMonitor(device, async (original) => {
          await guard();
          await host.resumeMonitor(device, {
            ...original,
            enabled: true,
            running: true,
            migrate: true,
          });
        });
        return { started: true };
      }
      const runner = new MonitorRunner(
        binding,
        this.options.runtime ?? new Controller(device),
        guard,
        () => (this.options.now?.().getTime() ?? Date.now()) / 1000,
      );
      if (command.type === 'monitor.preview') return runner.cycle(false);
      await new Deployment(
        host,
        this.options.runtime ?? new Controller(device),
        () => {},
      ).changeMonitor(device, async () => {
        await runner.stop();
      });
      return { stopped: true };
    }
    if (
      command.type === 'scheme.apply' ||
      command.type === 'deployment.history' ||
      command.type === 'deployment.restore' ||
      command.type === 'deployment.preview'
    ) {
      if (!workspace.device) throw new Error('请先连接客户端');
      const host =
        this.options.host ??
        new SystemHost(
          this.options.resourcesDir ?? fileURLToPath(new URL('../../resources/', import.meta.url)),
        );
      const deployment = new Deployment(
        host,
        this.options.runtime ?? new Controller(workspace.device),
        (phase) => {
          this.progress = phase;
        },
      );
      if (command.type === 'deployment.history')
        return (await deployment.history(workspace.device))
          .map((row) => ({
            id: row.id,
            schemeId: row.schemeId,
            state: row.state,
            startedAt: row.startedAt,
            backup: row.backup,
            error: row.error,
          }))
          .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
      if (command.type === 'deployment.restore') {
        const recovered = await deployment.recover(workspace.device, command.id);
        if (recovered.configurationChanged) workspace.applied = null;
        await this.store.write(workspace);
        return { restored: true };
      }
      const scheme = workspace.schemes.find((row) => row.id === command.schemeId);
      if (!scheme) throw new Error('方案不存在');
      if (command.type === 'deployment.preview') {
        const plan = await prepareDeployment(workspace, scheme);
        const changes: string[] = [];
        for (const [file, text] of Object.entries(plan.payload)) {
          try {
            if ((await readText(await inside(workspace.device.configDir, file))) !== text)
              changes.push(file);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            changes.push(file);
          }
        }
        const drift: string[] = [];
        try {
          const owner = JSON.parse(
            await readText(await inside(workspace.device.configDir, 'config-manager/owner.json')),
          );
          for (const [file, hash] of Object.entries(owner.managedFiles ?? {})) {
            try {
              if (digest(await readText(await inside(workspace.device.configDir, file))) !== hash)
                drift.push(file);
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
              drift.push(file);
            }
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        return {
          changes,
          drift,
          running: await host.running(workspace.device),
          capability: await host.inspect(workspace.device),
        };
      }
      this.abort = new AbortController();
      const result = await deployment.apply(workspace, scheme, this.abort.signal);
      workspace.applied = {
        schemeId: scheme.id,
        hash: result.hash,
        at: result.at,
        deploymentId: result.id,
        snapshot: structuredClone(scheme),
      };
      for (const source of workspace.sources) source.cardPending = false;
      await this.store.write(workspace);
      return workspace.applied;
    }
    if (command.type === 'source.adopt') {
      const source = await adoptSource(workspace, command.uid, command.sourceId, (nodes) =>
        this.validateNodes(workspace, nodes),
      );
      await this.store.write(workspace);
      return source;
    }
    if (command.type === 'source.register') {
      const source = await registerSource(
        workspace,
        command.name,
        command.url,
        this.checkedDownload(workspace),
      );
      await this.store.write(workspace);
      return source;
    }
    if (command.type === 'source.update') {
      const result = await updateSource(
        workspace,
        command.sourceId,
        command,
        this.checkedDownload(workspace),
      );
      await this.store.write(workspace);
      return result;
    }
    if (command.type === 'source.absorb') {
      const changed = await absorbSource(workspace, command.sourceId, (nodes) =>
        this.validateNodes(workspace, nodes),
      );
      if (changed) await this.refreshRuntime(workspace, command.sourceId);
      await this.store.write(workspace);
      return { changed };
    }
    if (command.type === 'source.unlink') {
      const source = workspace.sources.find((row) => row.id === command.sourceId);
      if (!source) throw new Error('来源不存在');
      delete source.uid;
      delete source.privateRevision;
      delete source.clientHash;
      delete source.runtimeAt;
      source.cardPending = false;
      workspace.nodes = workspace.nodes.map((node) =>
        node.sourceId === source.id ? { ...node, missing: true } : node,
      );
      await this.store.write(workspace);
      return { unlinked: true };
    }
    if (command.type === 'source.impact') return sourceImpact(workspace, command.sourceId);
    if (command.type === 'source.remove') {
      const source = workspace.sources.find((row) => row.id === command.sourceId);
      if (!source) throw new Error('来源不存在');
      const impact = sourceImpact(workspace, source.id);
      if (impact.length)
        throw new Error(`来源仍被 ${impact.length} 个方案引用，请先在方案中替换或移除`);
      source.deleted = true;
      source.dirty = true;
      source.cardPending = true;
      await this.store.write(workspace);
      return { removed: true };
    }
    if (command.type === 'source.refresh') {
      const source = await refreshSource(
        workspace,
        command.sourceId,
        this.checkedDownload(workspace),
      );
      await this.refreshRuntime(workspace, command.sourceId);
      await this.store.write(workspace);
      return source;
    }
    if (command.type === 'scheme.create') {
      const name = command.name.trim();
      if (!name || workspace.schemes.some((scheme) => scheme.name === name)) {
        throw new Error('方案名称为空或重复');
      }
      const scheme = emptyScheme(randomUUID(), name);
      workspace.schemes.push(scheme);
      await this.store.write(workspace);
      return scheme;
    }
    if (command.type === 'scheme.save') {
      const scheme = schemeSchema.parse(command.scheme);
      for (const id of scheme.members) {
        const node = workspace.nodes.find((row) => row.id === id);
        if (node) scheme.nodeRefs[id] = { sourceId: node.sourceId, name: node.name };
      }
      const position = workspace.schemes.findIndex((row) => row.id === scheme.id);
      if (position < 0) throw new Error('方案不存在');
      if (workspace.schemes.some((row) => row.id !== scheme.id && row.name === scheme.name))
        throw new Error('方案名称重复');
      if (digest(workspace.schemes[position]) !== digest(scheme))
        await atomicWrite(
          path.join(this.options.dataDir, 'recovery', `${digest(scheme.id)}-${randomUUID()}.json`),
          JSON.stringify(workspace.schemes[position]),
        );
      workspace.schemes[position] = scheme;
      await this.store.write(workspace);
      return scheme;
    }
    if (command.type === 'scheme.preview' || command.type === 'rule.explain') {
      const scheme = workspace.schemes.find((row) => row.id === command.schemeId);
      if (!scheme) throw new Error('方案不存在');
      return command.type === 'rule.explain'
        ? explainRule(scheme, workspace, command.context)
        : previewScheme(scheme, workspace);
    }
    throw new Error('不支持的应用命令');
  }
}
