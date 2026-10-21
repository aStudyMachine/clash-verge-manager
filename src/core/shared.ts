import { spawn } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { schemeSchema, type Scheme, type Source } from './model.js';
import { canonical, digest, previewScheme } from './compiler.js';
import { atomicWrite } from './storage.js';

const sourceSchema = z
  .object({ id: z.string(), name: z.string(), prefix: z.string(), deleted: z.boolean().optional() })
  .strict();
const publishedSchema = z
  .object({
    version: z.string(),
    hash: z.string(),
    summary: z.string(),
    requestId: z.string(),
    publishedAt: z.string(),
    scheme: schemeSchema,
  })
  .strict();
const sharedSchema = z
  .object({
    schemaVersion: z.literal(1),
    catalog: z
      .object({ revision: z.number().int().min(0), sources: z.record(z.string(), sourceSchema) })
      .strict(),
    schemes: z.record(
      z.string(),
      z
        .object({
          head: z.string(),
          versions: z.record(z.string(), publishedSchema),
          deleted: z.boolean().optional(),
        })
        .strict(),
    ),
    requests: z
      .record(
        z.string(),
        z.object({ hash: z.string(), versions: z.record(z.string(), z.string()) }).strict(),
      )
      .optional(),
  })
  .strict();
export type Shared = z.infer<typeof sharedSchema>;
export type Published = z.infer<typeof publishedSchema>;

function emptyShared(): Shared {
  return { schemaVersion: 1, catalog: { revision: 0, sources: {} }, schemes: {} };
}

export function versionKey(version: string): number[] {
  if (!/^\d{4}\.\d{2}\.\d{2}\.[1-9]\d*$/.test(version)) throw new Error('方案版本格式无效');
  const parts = version.split('.').map(Number);
  const date = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));
  if (
    date.getUTCFullYear() !== parts[0] ||
    date.getUTCMonth() + 1 !== parts[1] ||
    date.getUTCDate() !== parts[2] ||
    !Number.isSafeInteger(parts[3])
  )
    throw new Error('方案版本日期或序号无效');
  return parts;
}

export function compareVersions(a: string, b: string): number {
  const first = versionKey(a);
  const second = versionKey(b);
  for (let index = 0; index < first.length; index++)
    if (first[index] !== second[index]) return first[index] - second[index];
  return 0;
}

function nextVersion(previous: string | undefined, now: Date): string {
  const date = `${now.getFullYear()}.${String(now.getMonth() + 1).padStart(2, '0')}.${String(now.getDate()).padStart(2, '0')}`;
  if (!previous) return `${date}.1`;
  const oldDate = previous.split('.').slice(0, 3).join('.');
  return date > oldDate ? `${date}.1` : `${oldDate}.${versionKey(previous)[3] + 1}`;
}

function validateShared(input: unknown): Shared {
  let data: Shared;
  try {
    data = sharedSchema.parse(input);
  } catch {
    throw new Error('远端配置格式不兼容或包含非白名单字段');
  }
  for (const [id, record] of Object.entries(data.schemes)) {
    const versions = Object.keys(record.versions).sort(compareVersions);
    if (!versions.length || record.head !== versions.at(-1))
      throw new Error('远端方案头或版本顺序无效');
    for (const [version, snapshot] of Object.entries(record.versions)) {
      versionKey(version);
      if (
        version !== snapshot.version ||
        snapshot.scheme.id !== id ||
        digest(snapshot.scheme) !== snapshot.hash
      )
        throw new Error('远端版本内容摘要不符');
    }
    if (
      !record.deleted &&
      record.versions[record.head].scheme.sourceIds.some(
        (sourceId) => !data.catalog.sources[sourceId] || data.catalog.sources[sourceId].deleted,
      )
    )
      throw new Error('远端方案引用失效来源');
  }
  return data;
}

export interface SharedRemote {
  read(): Promise<{ head: string | null; data: Shared }>;
  write(parent: string | null, data: Shared, message: string): Promise<string>;
}

export class GitRemote implements SharedRemote {
  private readonly directory: string;
  private readonly cacheRoot: string;
  constructor(
    private readonly options: {
      dataDir: string;
      remote: string;
      gitPath: string;
      allowFileRemote?: boolean;
    },
  ) {
    this.cacheRoot = path.join(options.dataDir, 'remotes', digest(options.remote));
    this.directory = path.join(this.cacheRoot, 'git-cache.git');
    const remote = options.remote;
    if (/^https:\/\//.test(remote)) {
      const url = new URL(remote);
      if (url.username || url.password || url.search || url.hash)
        throw new Error('Git 地址不能内嵌凭据或查询参数，请使用系统认证');
    } else if (
      !/^git@[A-Za-z0-9.-]+:[A-Za-z0-9_./-]+$/.test(remote) &&
      !(options.allowFileRemote && path.isAbsolute(remote))
    ) {
      throw new Error('Git 远端仅支持 HTTPS 或 SSH；本地远端仅供隔离测试');
    }
  }

  private async git(args: string[], input?: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(
        this.options.gitPath,
        [
          '--no-pager',
          '-c',
          'core.hooksPath=NUL',
          '-c',
          'protocol.ext.allow=never',
          '-c',
          'credential.interactive=never',
          ...args,
        ],
        {
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe'],
          env: {
            ...process.env,
            GIT_TERMINAL_PROMPT: '0',
            GCM_INTERACTIVE: 'Never',
            GIT_AUTHOR_NAME: 'ClashManager',
            GIT_AUTHOR_EMAIL: 'clash-manager@localhost',
            GIT_COMMITTER_NAME: 'ClashManager',
            GIT_COMMITTER_EMAIL: 'clash-manager@localhost',
          },
        },
      );
      let output = '';
      let size = 0;
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error('Git 操作超时，草稿已保留'));
      }, 45000);
      child.once('error', () => {
        clearTimeout(timer);
        reject(new Error('Git 运行环境不可用'));
      });
      child.stdout.on('data', (chunk) => {
        size += chunk.length;
        if (size <= 32 * 1024 * 1024) output += chunk.toString('utf8');
        else {
          child.kill();
          reject(new Error('Git 配置超过允许大小'));
        }
      });
      child.stderr.resume();
      child.once('close', (code) => {
        clearTimeout(timer);
        code === 0
          ? resolve(output.trimEnd())
          : reject(new Error('Git 操作失败，请核对网络、认证、仓库格式或并发发布'));
      });
      child.stdin.on('error', () => {});
      child.stdin.end(input);
    });
  }

  private async initialize(): Promise<void> {
    await mkdir(this.cacheRoot, { recursive: true });
    try {
      await readFile(path.join(this.directory, 'HEAD'));
    } catch {
      await this.git(['init', '--bare', this.directory]);
    }
  }

  async authenticate(): Promise<void> {
    const url = new URL(this.options.remote);
    if (url.protocol !== 'https:' || url.hostname !== 'github.com')
      throw new Error('内置登录支持 GitHub HTTPS；其他远端请使用已有系统凭据或 SSH');
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        this.options.gitPath,
        ['credential-manager', 'github', 'login', '--url', url.origin, '--browser'],
        { windowsHide: true, stdio: 'ignore', env: { ...process.env, GCM_INTERACTIVE: 'always' } },
      );
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error('认证等待超时，可重新登录'));
      }, 180000);
      child.once('error', () => {
        clearTimeout(timer);
        reject(new Error('系统凭据管理器无法启动'));
      });
      child.once('exit', (code) => {
        clearTimeout(timer);
        code === 0 ? resolve() : reject(new Error('认证未完成，请重试'));
      });
    });
  }

  async read(): Promise<{ head: string | null; data: Shared }> {
    await this.initialize();
    const advertised = await this.git([
      'ls-remote',
      '--heads',
      this.options.remote,
      'refs/heads/main',
    ]);
    if (!advertised) {
      try {
        await readFile(path.join(this.cacheRoot, 'shared-cache.json'));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT')
          return { head: null, data: emptyShared() };
        throw error;
      }
      throw new Error('已知远端主分支消失，停止同步以保留历史与删除记录');
    }
    await this.git([
      '--git-dir',
      this.directory,
      'fetch',
      '--no-tags',
      this.options.remote,
      'refs/heads/main',
    ]);
    const head = await this.git(['--git-dir', this.directory, 'rev-parse', 'FETCH_HEAD']);
    let text: string;
    try {
      text = await this.git(['--git-dir', this.directory, 'show', `${head}:configuration.json`]);
    } catch {
      throw new Error('远端不是配置仓库，请使用专用空仓库或已有配置仓库');
    }
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      throw new Error('远端配置 JSON 无效');
    }
    const data = validateShared(value);
    try {
      const previous = JSON.parse(
        await readFile(path.join(this.cacheRoot, 'shared-cache.json'), 'utf8'),
      ) as { head: string; data: Shared };
      if (previous.head && previous.head !== head)
        await this.git([
          '--git-dir',
          this.directory,
          'merge-base',
          '--is-ancestor',
          previous.head,
          head,
        ]);
      for (const [id, record] of Object.entries(previous.data.schemes))
        for (const [version, snapshot] of Object.entries(record.versions)) {
          if (canonical(data.schemes[id]?.versions[version]) !== canonical(snapshot))
            throw new Error('远端历史方案被改写，停止同步');
        }
      for (const [id, source] of Object.entries(previous.data.catalog.sources))
        if (source.deleted && !data.catalog.sources[id]?.deleted)
          throw new Error('远端来源删除记录被改写');
      for (const [id, record] of Object.entries(previous.data.schemes))
        if (record.deleted && !data.schemes[id]?.deleted) throw new Error('远端方案删除记录被改写');
      for (const [id, request] of Object.entries(previous.data.requests ?? {}))
        if (canonical(data.requests?.[id]) !== canonical(request))
          throw new Error('远端发布请求历史被改写');
      if (data.catalog.revision < previous.data.catalog.revision)
        throw new Error('远端来源目录修订倒退');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await atomicWrite(
      path.join(this.cacheRoot, 'shared-cache.json'),
      JSON.stringify({ head, data }),
    );
    return { head, data };
  }

  async write(parent: string | null, data: Shared, message: string): Promise<string> {
    validateShared(data);
    const blob = await this.git(
      ['--git-dir', this.directory, 'hash-object', '-w', '--stdin'],
      canonical(data),
    );
    const existing = parent ? await this.git(['--git-dir', this.directory, 'ls-tree', parent]) : '';
    const entries = existing
      .split('\n')
      .filter((line) => line && !line.endsWith('\tconfiguration.json'));
    entries.push(`100644 blob ${blob}\tconfiguration.json`);
    const tree = await this.git(['--git-dir', this.directory, 'mktree'], `${entries.join('\n')}\n`);
    const commit = await this.git(
      [
        '--git-dir',
        this.directory,
        'commit-tree',
        tree,
        ...(parent ? ['-p', parent] : []),
        '-F',
        '-',
      ],
      message,
    );
    await this.git([
      '--git-dir',
      this.directory,
      'push',
      this.options.remote,
      `${commit}:refs/heads/main`,
    ]);
    await atomicWrite(
      path.join(this.cacheRoot, 'shared-cache.json'),
      JSON.stringify({ head: commit, data }),
    );
    return commit;
  }
}

export class Publisher {
  constructor(
    private readonly remote: SharedRemote,
    private readonly now: () => Date,
  ) {}

  async publishBatch(
    schemes: Scheme[],
    sources: Source[],
    deletedSchemes: string[],
    summary: string,
    requestId: string,
  ): Promise<Record<string, Published>> {
    if (!summary.trim() || summary.length > 200) throw new Error('更新说明须为 1 至 200 字');
    const hash = digest({
      schemes,
      sources: sources.map((source) => ({
        id: source.id,
        name: source.name,
        prefix: source.prefix,
        deleted: source.deleted,
        dirty: source.dirty,
      })),
      deletedSchemes,
      summary,
    });
    const reconcile = (data: Shared): Record<string, Published> | undefined => {
      const request = data.requests?.[requestId];
      if (!request) return undefined;
      if (request.hash !== hash) throw new Error('发布请求标识已用于其他内容');
      return Object.fromEntries(
        Object.entries(request.versions).map(([id, version]) => [
          id,
          data.schemes[id].versions[version],
        ]),
      );
    };
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      const { head, data } = await this.remote.read();
      const acknowledged = reconcile(data);
      if (acknowledged) return acknowledged;
      const updated = structuredClone(data);
      for (const source of sources) {
        if (updated.catalog.sources[source.id]?.deleted && !source.deleted)
          throw new Error('来源已删除，不能由旧草稿复活');
        if (!source.dirty && updated.catalog.sources[source.id]) continue;
        const shared = sourceSchema.parse({
          id: source.id,
          name: source.name,
          prefix: source.prefix,
          ...(source.deleted ? { deleted: true } : {}),
        });
        if (canonical(updated.catalog.sources[source.id]) !== canonical(shared))
          updated.catalog.revision++;
        updated.catalog.sources[source.id] = shared;
      }
      const published: Record<string, Published> = {};
      for (const scheme of schemes) {
        if (data.schemes[scheme.id]?.deleted) throw new Error('方案已删除，恢复须显式新建方案');
        const checked = previewScheme(scheme, {
          schemaVersion: 1,
          schemes: [scheme],
          sources: Object.values(updated.catalog.sources).map((source) => ({
            ...source,
            metadata: {},
          })),
          nodes: Object.entries(scheme.nodeRefs).map(([id, node]) => ({
            id,
            sourceId: node.sourceId,
            name: node.name,
            displayName: (updated.catalog.sources[node.sourceId]?.prefix ?? '') + node.name,
            missing: false,
            protocol: 'unknown',
          })),
          device: null,
          applied: null,
        });
        if (!checked.valid) throw new Error(`发布方案引用校验未通过：${checked.issues[0].message}`);
        const version = nextVersion(updated.schemes[scheme.id]?.head, this.now());
        const snapshot: Published = {
          scheme: schemeSchema.parse(scheme),
          version,
          summary: summary.trim(),
          requestId,
          publishedAt: this.now().toISOString(),
          hash: digest(scheme),
        };
        const record = updated.schemes[scheme.id] ?? { head: version, versions: {} };
        record.head = version;
        record.versions[version] = snapshot;
        updated.schemes[scheme.id] = record;
        published[scheme.id] = snapshot;
      }
      for (const id of deletedSchemes) if (updated.schemes[id]) updated.schemes[id].deleted = true;
      for (const record of Object.values(updated.schemes))
        if (
          !record.deleted &&
          record.versions[record.head].scheme.sourceIds.some(
            (id) => !updated.catalog.sources[id] || updated.catalog.sources[id].deleted,
          )
        )
          throw new Error('来源删除仍被远端方案引用，请先获取并修复全部引用再发布');
      updated.requests ??= {};
      updated.requests[requestId] = {
        hash,
        versions: Object.fromEntries(
          Object.entries(published).map(([id, value]) => [id, value.version]),
        ),
      };
      try {
        await this.remote.write(head, updated, summary);
        return published;
      } catch (error) {
        lastError = error;
      }
    }
    const reconciled = await this.remote.read();
    const found = reconcile(reconciled.data);
    if (found) return found;
    throw lastError ?? new Error('发布未完成，草稿与发布请求已保留');
  }

  async fetch(): Promise<Shared> {
    return (await this.remote.read()).data;
  }
}
