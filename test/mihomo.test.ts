import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:net';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parse, stringify } from 'yaml';
import { Manager } from '../src/core/manager.js';
import { Controller } from '../src/core/controller.js';
import { fixture } from './fixture.js';

test('目标 Mihomo 实际加载固定 provider 并热刷新凭据，不扩大候选', { skip: !process.env.CLASH_MANAGER_TEST_CORE }, async () => {
  const root = await fixture(); const configDir = path.join(root, 'verge');
  await mkdir(path.join(configDir, 'profiles'), { recursive: true });
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>(resolve => server.close(() => resolve()));
  const config = `mode: rule\nexternal-controller: 127.0.0.1:${port}\nsecret: example-only\ntun:\n  enable: false\ndns:\n  enable: false\nlog-level: silent\n`;
  await writeFile(path.join(configDir, 'verge.yaml'), '{}');
  await writeFile(path.join(configDir, 'config.yaml'), config);
  await writeFile(path.join(configDir, 'profiles.yaml'), 'current: old\nitems:\n  - uid: old\n    type: local\n    name: 原配置\n    file: old.yaml\n');
  await writeFile(path.join(configDir, 'profiles/old.yaml'), config);
  let child: ChildProcess | undefined; let staged = ''; let version = 1;
  const host = {
    inspect: async () => ({ supported: true, version: '2.5.8', running: !!child }), running: async () => !!child,
    preflight: async (_device: unknown, file: string) => {
      await promisify(execFile)(process.env.CLASH_MANAGER_TEST_CORE!, ['-t', '-d', path.dirname(file), '-f', file], { windowsHide: true, env: { ...process.env, SAFE_PATHS: configDir } });
      staged = file;
    },
    start: async () => {
      const live = parse(await readFile(staged, 'utf8'));
      for (const [name, provider] of Object.entries(live['proxy-providers']) as [string, any][]) provider.path = path.join(configDir, `config-manager/providers/${name}.yaml`);
      staged = path.join(path.dirname(staged), 'live.yaml'); await writeFile(staged, stringify(live));
      child = spawn(process.env.CLASH_MANAGER_TEST_CORE!, ['-d', path.dirname(staged), '-f', staged], { windowsHide: true, stdio: 'ignore', env: { ...process.env, SAFE_PATHS: configDir } });
    },
    monitorStatus: async () => ({ exists: false, running: false, enabled: false }), pauseMonitor: async () => {}, resumeMonitor: async () => {}, lock: async () => async () => {},
  };
  const runtime = new Controller({ configDir });
  const manager = new Manager({ dataDir: path.join(root, 'data'), host, runtime, download: async () => ({ text: `proxies:\n  - name: 节点甲\n    type: ss\n    server: 127.0.0.1\n    port: ${10000 + version}\n    cipher: aes-128-gcm\n    password: example-only\n  - name: 节点乙\n    type: ss\n    server: 127.0.0.1\n    port: 10002\n    cipher: aes-128-gcm\n    password: example-only\n`, metadata: {} }) });
  try {
    await manager.execute({ type: 'device.connect', configDir });
    const source = await manager.execute({ type: 'source.register', name: '来源', url: 'https://example.invalid/subscription' });
    const state = await manager.execute({ type: 'workspace.read' }); const scheme = state.schemes[0];
    scheme.sourceIds = [source.id]; scheme.members = [state.nodes[0].id];
    scheme.groups = [{ id: 'exit', name: '出口', kind: 'general', strategy: 'select', members: [{ kind: 'node', id: state.nodes[0].id }] }];
    scheme.defaultTarget = { kind: 'group', id: 'exit' };
    scheme.rules = [{ id: 'direct-node', kind: 'DOMAIN', value: 'node.example.invalid', target: { kind: 'node', id: state.nodes[0].id }, layer: 'custom', options: [] }];
    await manager.execute({ type: 'scheme.save', scheme });
    await manager.execute({ type: 'scheme.apply', schemeId: scheme.id });
    assert.deepEqual((await runtime.read()).proxies['出口'].all, ['[来源] 节点甲']);
    version = 2;
    const refreshed = await manager.execute({ type: 'source.refresh', sourceId: source.id });
    assert.ok(refreshed.runtimeAt);
    assert.equal(refreshed.runtimeError, undefined);
    const running = await runtime.read();
    assert.deepEqual(running.proxies['出口'].all, ['[来源] 节点甲']);
    const name = Object.keys(running.providers).find(name => name.startsWith('cm-'))!;
    const provider = await readFile(path.join(configDir, `config-manager/providers/${name}.yaml`), 'utf8');
    assert.match(provider, /port: 10002/);
    assert.doesNotMatch(provider, /节点乙/);
  } finally {
    if (child) { const exited = new Promise(resolve => child!.once('exit', resolve)); child.kill(); await exited; }
  }
});
