import { appendFile, readFile, access } from 'node:fs/promises';
import { inside, atomicWrite, readText } from './storage.js';
import { readIndex } from './sources.js';
import { Controller, type Runtime } from './controller.js';
import { StabilitySession, type Sample } from './stability.js';
import { monitorSettingsSchema, type MonitorSettings } from './model.js';
import { SystemHost } from './host.js';

export interface MonitorBinding {
  schemaVersion: 1;
  enabled: boolean;
  schemeId: string;
  hash: string;
  groupName: string;
  providerName: string;
  names: string[];
  settings: MonitorSettings;
  dataRevision?: string;
}

type RunnerOptions = Pick<MonitorBinding, 'groupName' | 'providerName' | 'names' | 'settings'>;
const baseUrl = 'https://www.gstatic.com/generate_204';

export class MonitorRunner {
  private readonly session: StabilitySession;
  private readonly samples = new Map<string, Map<string, Sample>>();
  private nextTarget = 0;
  private targetPending = 0;
  private targetError: string | null = null;
  private closed = false;

  constructor(private readonly binding: RunnerOptions, private readonly runtime: Runtime, private readonly guard: () => Promise<void>, private readonly now: () => number = () => Date.now() / 1000) {
    this.session = new StabilitySession(binding.settings);
    for (const name of binding.names) this.samples.set(name, new Map());
  }

  private schedule(): void {
    if (!this.runtime.probe || this.targetPending || this.now() < this.nextTarget || this.closed) return;
    const jobs = this.binding.names.flatMap(name => this.binding.settings.targetUrls.map(url => ({ name, url })));
    this.targetPending = jobs.length;
    this.nextTarget = this.now() + this.binding.settings.targetIntervalSeconds;
    const worker = async () => {
      while (jobs.length && !this.closed) {
        const job = jobs.shift()!;
        try {
          const result = await this.runtime.probe!(this.binding.providerName, job.name, job.url, this.binding.settings.timeoutMs);
          const at = this.now();
          this.samples.get(job.name)!.set(`target/${at}/${job.url}`, { ...result, at, kind: 'target', url: job.url });
          this.targetError = null;
        } catch { this.targetError = '网站探测控制器请求失败，未计入节点评分'; }
        finally { this.targetPending--; }
      }
    };
    for (let index = 0; index < 3; index++) void worker();
  }

  async cycle(apply = false) {
    await this.guard();
    const before = await this.runtime.read();
    const group = before.proxies[this.binding.groupName];
    if (!group || group.type.toLowerCase() !== 'fallback' || JSON.stringify(group.all) !== JSON.stringify(this.binding.names) || (group.testUrl && group.testUrl !== baseUrl)) throw new Error('稳定池类型、候选或基础检测地址不符，暂停评估');
    const now = this.now();
    const supplied = before.providers[this.binding.providerName]?.proxies;
    for (const name of this.binding.names) {
      const node = supplied?.find(row => row.name === name);
      const history = node?.extra?.[baseUrl]?.history;
      if (!history) throw new Error('稳定池基础检测历史尚未就绪');
      const rows = this.samples.get(name)!;
      for (const entry of history) {
        const at = Date.parse(entry.time) / 1000;
        if (Number.isFinite(at) && at >= now - this.binding.settings.windowSeconds && at <= now + 5) rows.set(`base/${at}`, { at, kind: 'base', delay: entry.delay });
      }
      for (const [key, sample] of rows) if (sample.at < now - this.binding.settings.windowSeconds || sample.at > now + 5) rows.delete(key);
    }
    this.schedule();
    const result = this.session.evaluate(Object.fromEntries([...this.samples].map(([name, rows]) => [name, [...rows.values()]])), group.now ?? '', now, group.fixed ?? '');
    let switched = false;
    if (apply && result.proposed) {
      await this.guard();
      const latest = (await this.runtime.read()).proxies[this.binding.groupName];
      if (latest.now === group.now && JSON.stringify(latest.all) === JSON.stringify(this.binding.names) && latest.fixed !== result.proposed) {
        await this.runtime.select(this.binding.groupName, result.proposed);
        const verified = (await this.runtime.read()).proxies[this.binding.groupName];
        if (verified.now !== result.proposed || verified.fixed !== result.proposed) throw new Error('稳定池优先选择未按预期生效');
        this.session.switched(now, result.proposed);
        switched = true;
      }
    }
    const after = await this.runtime.read();
    for (const [name, row] of Object.entries(before.proxies)) {
      if (name !== this.binding.groupName && row.all && row.fixed !== after.proxies[name]?.fixed) throw new Error('监测期间其他组的固定选择发生变化');
    }
    return { ...result, current: after.proxies[this.binding.groupName].now, fixed: after.proxies[this.binding.groupName].fixed, switched, targetPending: this.targetPending, targetError: this.targetError, at: new Date(now * 1000).toISOString() };
  }

  async stop(): Promise<void> {
    this.closed = true;
    await this.guard();
    await this.runtime.select(this.binding.groupName, null);
  }
}

export async function runMonitor(configDir: string, resourcesDir: string): Promise<void> {
  const device = { configDir };
  const root = await inside(configDir, 'config-manager/monitor');
  const abort = new AbortController();
  const runtime = new Controller(device, abort.signal);
  const host = new SystemHost(resourcesDir);
  const release = await host.lock(device, 'monitor');
  let runner: MonitorRunner | undefined;
  let binding: MonitorBinding | undefined;
  let stopping = false;
  process.once('SIGINT', () => { stopping = true; });
  process.once('SIGTERM', () => { stopping = true; });
  const guard = async () => {
    const owner = JSON.parse(await readText(await inside(configDir, 'config-manager/owner.json')));
    const index = await readIndex(configDir);
    if (!binding || owner.schemeHash !== binding.hash || owner.schemeId !== binding.schemeId || index.current !== owner.ids.local) throw new Error('目标方案或入口已改变，暂停稳定评估');
  };
  try {
    while (!stopping) {
      try { await access(await inside(configDir, 'config-manager/monitor/stop')); break; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      try {
        const loaded = JSON.parse(await readFile(await inside(configDir, 'config-manager/monitor/binding.json'), 'utf8')) as MonitorBinding;
        if (!loaded.enabled) break;
        loaded.settings = monitorSettingsSchema.parse(loaded.settings);
        if (!runner || loaded.hash !== binding?.hash || loaded.dataRevision !== binding?.dataRevision) {
          binding = loaded;
          runner = new MonitorRunner(loaded, runtime, guard);
        }
        const status = await runner.cycle(true);
        await atomicWrite(await inside(configDir, 'config-manager/monitor/status.json'), JSON.stringify({ ...status, pid: process.pid, state: 'running' }));
        if (status.switched) await appendFile(await inside(configDir, 'config-manager/monitor/switches.jsonl'), JSON.stringify({ at: status.at, selected: status.proposed, reason: status.reason }) + '\n', 'utf8');
      } catch {
        await atomicWrite(await inside(configDir, 'config-manager/monitor/status.json'), JSON.stringify({ state: 'paused', pid: process.pid, at: new Date().toISOString(), message: '目标方案、控制器或检测历史尚未就绪，未应用新决策' }));
      }
      const deadline = Date.now() + (binding?.settings.pollSeconds ?? 30) * 1000;
      while (Date.now() < deadline && !stopping) {
        try { await access(await inside(configDir, 'config-manager/monitor/stop')); stopping = true; } catch { }
        if (!stopping) await new Promise(resolve => setTimeout(resolve, 400));
      }
    }
    if (runner) {
      try { await runner.stop(); }
      catch { await guard().then(() => { throw new Error('监测停止时动态优先值清理未完成'); }).catch(error => { if (error.message.includes('清理')) throw error; }); }
    }
    await atomicWrite(await inside(configDir, 'config-manager/monitor/status.json'), JSON.stringify({ state: 'stopped', at: new Date().toISOString(), pid: process.pid }));
  } finally { abort.abort(); await release(); }
}
