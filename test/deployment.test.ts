import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { parse } from 'yaml';
import path from 'node:path';
import { Manager } from '../src/core/manager.js';
import { fixture } from './fixture.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

test('写入后客户端启动失败，恢复原入口且不确认成功', async () => {
  const root = await fixture();
  const configDir = path.join(root, 'verge');
  await mkdir(path.join(configDir, 'profiles'), { recursive: true });
  await writeFile(path.join(configDir, 'verge.yaml'), '{}');
  await writeFile(
    path.join(configDir, 'profiles.yaml'),
    'current: old\nitems:\n  - uid: old\n    type: local\n    name: 原配置\n    file: old.yaml\n',
  );
  await writeFile(path.join(configDir, 'profiles', 'old.yaml'), 'mode: rule\n');
  const host = {
    inspect: async () => ({ supported: true, version: '2.5.8', running: false }),
    running: async () => false,
    preflight: async () => {},
    start: async () => {
      throw new Error('模拟启动失败');
    },
    monitorStatus: async () => ({ exists: false, running: false, enabled: false }),
    pauseMonitor: async () => {},
    resumeMonitor: async () => {},
    lock: async () => async () => {},
  };
  const manager = new Manager({ dataDir: path.join(root, 'data'), host });
  await manager.execute({
    type: 'device.connect',
    configDir,
    appPath: path.join(root, 'clash-verge.exe'),
    corePath: path.join(root, 'mihomo.exe'),
  });
  await assert.rejects(manager.execute({ type: 'scheme.apply', schemeId: 'default' }), /恢复/);
  const device = await manager.execute({ type: 'device.inspect' });
  assert.equal(device.current, 'old');
  assert.deepEqual(
    device.profiles.map((profile: { name: string }) => profile.name),
    ['原配置'],
  );
  const state = await manager.execute({ type: 'workspace.read' });
  assert.equal(state.applied, null);
  const history = await manager.execute({ type: 'deployment.history' });
  assert.equal(history[0].state, 'restored');
});

test('相同配置且运行核验一致，再次应用不会要求退出或重启', async () => {
  const root = await fixture();
  const configDir = path.join(root, 'verge');
  await mkdir(path.join(configDir, 'profiles'), { recursive: true });
  await writeFile(path.join(configDir, 'verge.yaml'), '{}');
  await writeFile(
    path.join(configDir, 'profiles.yaml'),
    'current: old\nitems:\n  - uid: old\n    type: local\n    name: 原配置\n    file: old.yaml\n',
  );
  await writeFile(path.join(configDir, 'profiles', 'old.yaml'), 'mode: rule\n');
  let running = false;
  let starts = 0;
  const host = {
    inspect: async () => ({ supported: true, version: '2.5.8', running }),
    running: async () => running,
    preflight: async () => {},
    start: async () => {
      running = true;
      starts++;
    },
    monitorStatus: async () => ({ exists: false, running: false, enabled: false }),
    pauseMonitor: async () => {},
    resumeMonitor: async () => {},
    lock: async () => async () => {},
  };
  const runtime = {
    read: async () => ({
      proxies: {},
      providers: {},
      rules: [{ type: 'Match', payload: '', proxy: 'DIRECT' }],
    }),
    select: async () => {},
    refresh: async () => {},
  };
  const manager = new Manager({ dataDir: path.join(root, 'data'), host, runtime });
  await manager.execute({
    type: 'device.connect',
    configDir,
    appPath: path.join(root, 'clash-verge.exe'),
    corePath: path.join(root, 'mihomo.exe'),
  });
  const first = await manager.execute({ type: 'scheme.apply', schemeId: 'default' });
  let settled = false;
  const second = manager.execute({ type: 'scheme.apply', schemeId: 'default' }).finally(() => {
    settled = true;
  });
  for (let index = 0; index < 50 && !settled; index++) {
    if ((await manager.execute({ type: 'deployment.status' })).phase === 'waiting-exit') {
      await manager.execute({ type: 'deployment.cancel' });
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const reapplied = await second;
  assert.equal(reapplied.deploymentId, first.deploymentId);
  assert.equal(starts, 1);
});

test('首轮内核预检使用已准备的隔离 provider，成功后才确认应用', async () => {
  const root = await fixture();
  const configDir = path.join(root, 'verge');
  await mkdir(path.join(configDir, 'profiles'), { recursive: true });
  await writeFile(path.join(configDir, 'verge.yaml'), '{}');
  await writeFile(
    path.join(configDir, 'profiles.yaml'),
    'current: old\nitems:\n  - uid: old\n    type: local\n    name: 原配置\n    file: old.yaml\n',
  );
  await writeFile(path.join(configDir, 'profiles', 'old.yaml'), 'mode: rule\n');
  let providers: Record<string, { proxies: { name: string }[] }> = {};
  const host = {
    inspect: async () => ({ supported: true, version: '2.5.8', running: false }),
    running: async () => false,
    preflight: async (_device: unknown, file: string) => {
      const config = parse(await readFile(file, 'utf8'));
      for (const [name, declaration] of Object.entries(config['proxy-providers']) as [
        string,
        any,
      ][]) {
        const payload = parse(await readFile(declaration.path, 'utf8'));
        assert.deepEqual(
          payload.proxies.map((node: { name: string }) => node.name),
          ['[来源] 节点甲'],
        );
        providers[name] = {
          proxies: payload.proxies.map((node: { name: string }) => ({ name: node.name })),
        };
      }
    },
    start: async () => {},
    monitorStatus: async () => ({ exists: false, running: false, enabled: false }),
    pauseMonitor: async () => {},
    resumeMonitor: async () => {},
    lock: async () => async () => {},
  };
  const runtime = {
    read: async () => ({
      proxies: { 出口: { type: 'Selector', all: ['[来源] 节点甲'], now: '[来源] 节点甲' } },
      providers,
      rules: [
        { type: 'Domain', payload: 'example.invalid', proxy: 'DIRECT' },
        { type: 'Match', payload: '', proxy: 'DIRECT' },
      ],
    }),
    select: async () => {},
    refresh: async () => {},
  };
  const manager = new Manager({
    dataDir: path.join(root, 'data'),
    host,
    runtime,
    download: async () => ({
      text: 'proxies:\n  - name: 节点甲\n    type: ss\n    server: example.invalid\n    port: 443\n    cipher: aes-128-gcm\n    password: example-only\n',
      metadata: {},
    }),
  });
  await manager.execute({
    type: 'device.connect',
    configDir,
    appPath: path.join(root, 'clash-verge.exe'),
    corePath: path.join(root, 'mihomo.exe'),
  });
  const source = await manager.execute({
    type: 'source.register',
    name: '来源',
    url: 'https://example.invalid/subscription',
  });
  const state = await manager.execute({ type: 'workspace.read' });
  const scheme = state.schemes[0];
  scheme.sourceIds = [source.id];
  scheme.members = [state.nodes[0].id];
  scheme.groups = [
    {
      id: 'exit',
      name: '出口',
      kind: 'general',
      strategy: 'select',
      members: [{ kind: 'node', id: state.nodes[0].id }],
    },
  ];
  await manager.execute({ type: 'scheme.save', scheme });
  await manager.execute({ type: 'scheme.apply', schemeId: scheme.id });
  assert.equal((await manager.execute({ type: 'workspace.read' })).applied.schemeId, 'default');
});

test('规则数量相同但实际出口不同，也必须核验失败并恢复', async () => {
  const root = await fixture();
  const configDir = path.join(root, 'verge');
  await mkdir(path.join(configDir, 'profiles'), { recursive: true });
  await writeFile(path.join(configDir, 'verge.yaml'), '{}');
  await writeFile(
    path.join(configDir, 'profiles.yaml'),
    'current: old\nitems:\n  - uid: old\n    type: local\n    name: 原配置\n    file: old.yaml\n',
  );
  await writeFile(path.join(configDir, 'profiles', 'old.yaml'), 'mode: rule\n');
  const host = {
    inspect: async () => ({ supported: true, version: '2.5.8', running: false }),
    running: async () => false,
    preflight: async () => {},
    start: async () => {},
    monitorStatus: async () => ({ exists: false, running: false, enabled: false }),
    pauseMonitor: async () => {},
    resumeMonitor: async () => {},
    lock: async () => async () => {},
  };
  const runtime = {
    read: async () => ({
      proxies: {},
      providers: {},
      rules: [{ type: 'Match', payload: '', proxy: 'REJECT' }],
    }),
    select: async () => {},
    refresh: async () => {},
  };
  const manager = new Manager({ dataDir: path.join(root, 'data'), host, runtime });
  await manager.execute({
    type: 'device.connect',
    configDir,
    appPath: path.join(root, 'clash-verge.exe'),
    corePath: path.join(root, 'mihomo.exe'),
  });
  await assert.rejects(manager.execute({ type: 'scheme.apply', schemeId: 'default' }), /恢复/);
  assert.equal((await manager.execute({ type: 'workspace.read' })).applied, null);
});

test('暂停监测后取消退出等待，补偿运行状态且不改配置', async () => {
  const root = await fixture();
  const configDir = path.join(root, 'verge');
  await mkdir(path.join(configDir, 'profiles'), { recursive: true });
  await writeFile(path.join(configDir, 'verge.yaml'), '{}');
  const original =
    'current: old\nitems:\n  - uid: old\n    type: local\n    name: 原配置\n    file: old.yaml\n';
  await writeFile(path.join(configDir, 'profiles.yaml'), original);
  await writeFile(path.join(configDir, 'profiles/old.yaml'), 'mode: rule\n');
  let resumed = false;
  let paused = false;
  const host = {
    inspect: async () => ({ supported: true, version: '2.5.8', running: true }),
    running: async () => true,
    preflight: async () => {},
    start: async () => {
      throw new Error('不应重启');
    },
    monitorStatus: async () => ({ exists: true, running: true, enabled: true }),
    pauseMonitor: async () => {
      paused = true;
    },
    resumeMonitor: async () => {
      resumed = true;
    },
    lock: async () => async () => {},
  };
  const runtime = {
    read: async () => ({ proxies: {}, providers: {}, rules: [] }),
    select: async () => {},
    refresh: async () => {},
  };
  const manager = new Manager({ dataDir: path.join(root, 'data'), host, runtime });
  await manager.execute({ type: 'device.connect', configDir });
  const apply = manager.execute({ type: 'scheme.apply', schemeId: 'default' });
  const rejection = assert.rejects(apply, /恢复/);
  while (!paused) await new Promise((resolve) => setTimeout(resolve, 10));
  await manager.execute({ type: 'deployment.cancel' });
  await rejection;
  assert.equal(resumed, true);
  assert.equal(await readFile(path.join(configDir, 'profiles.yaml'), 'utf8'), original);
  assert.equal((await manager.execute({ type: 'deployment.history' }))[0].state, 'restored');
});

test(
  '接管后旧同步器在记录识别和回退识别两条路径都拒绝覆盖',
  { skip: !process.env.CLASH_MANAGER_TEST_PYTHON },
  async () => {
    const root = await fixture();
    const configDir = path.join(root, 'verge');
    await mkdir(path.join(configDir, 'profiles'), { recursive: true });
    await mkdir(path.join(configDir, 'config-sync'), { recursive: true });
    await writeFile(path.join(configDir, 'verge.yaml'), '{}');
    const index = {
      current: 'old',
      items: [
        {
          uid: 'old',
          type: 'local',
          name: '订阅聚合',
          file: 'old.yaml',
          option: { merge: 'oldMerge', script: 'oldScript' },
        },
        { uid: 'oldMerge', type: 'merge', name: '旧合并', file: 'oldMerge.yaml' },
        { uid: 'oldScript', type: 'script', name: '旧脚本', file: 'oldScript.js' },
      ],
    };
    await writeFile(path.join(configDir, 'profiles.yaml'), JSON.stringify(index));
    await writeFile(path.join(configDir, 'profiles/old.yaml'), 'mode: rule\n');
    await writeFile(path.join(configDir, 'profiles/oldMerge.yaml'), '{}');
    await writeFile(
      path.join(configDir, 'profiles/oldScript.js'),
      'const aggregatePolicy = {}; function main(c) { return c; }',
    );
    await writeFile(
      path.join(configDir, 'config-sync/repository.json'),
      JSON.stringify({ ids: { local: 'old', merge: 'oldMerge', script: 'oldScript' } }),
    );
    const host = {
      inspect: async () => ({ supported: true, version: '2.5.8', running: false }),
      running: async () => false,
      preflight: async () => {},
      start: async () => {},
      monitorStatus: async () => ({ exists: false, running: false, enabled: false }),
      pauseMonitor: async () => {},
      resumeMonitor: async () => {},
      lock: async () => async () => {},
    };
    const runtime = {
      read: async () => ({
        proxies: {},
        providers: {},
        rules: [{ type: 'Match', payload: '', proxy: 'DIRECT' }],
      }),
      select: async () => {},
      refresh: async () => {},
    };
    const manager = new Manager({ dataDir: path.join(root, 'data'), host, runtime });
    await manager.execute({ type: 'device.connect', configDir });
    await manager.execute({ type: 'scheme.apply', schemeId: 'default' });
    const script = `import sys,json\nfrom pathlib import Path\nsys.stdout.reconfigure(encoding='utf-8')\nsys.path.insert(0,sys.argv[1])\nimport repository,sync\nroot=Path(sys.argv[2])\nindex=sync.load_yaml((root/'profiles.yaml').read_bytes())\nfor fallback in (False,True):\n repository.MANAGED='config-sync/absent.json' if fallback else 'config-sync/repository.json'\n try: repository.binding(root,index)\n except sync.SyncError: pass\n else: raise RuntimeError('旧入口未拒绝覆盖')\nprint('两条旧入口均拒绝')`;
    const checked = await promisify(execFile)(
      process.env.CLASH_MANAGER_TEST_PYTHON!,
      ['-B', '-c', script, path.resolve('../../tools/config-sync'), configDir],
      { windowsHide: true },
    );
    assert.match(checked.stdout, /两条旧入口均拒绝/);
    const changed = parse(await readFile(path.join(configDir, 'profiles.yaml'), 'utf8'));
    assert.equal(changed.current, 'old');
    assert.notEqual(changed.items[0].option.script, 'oldScript');
    const receipt = (await manager.execute({ type: 'deployment.history' }))[0];
    await manager.execute({ type: 'deployment.restore', id: receipt.id });
    assert.deepEqual(parse(await readFile(path.join(configDir, 'profiles.yaml'), 'utf8')), index);
  },
);

test('独立监测迁移失败时从持久事务恢复原任务状态', async () => {
  const root = await fixture();
  const configDir = path.join(root, 'verge');
  await mkdir(path.join(configDir, 'profiles'), { recursive: true });
  await mkdir(path.join(configDir, 'config-manager/monitor'), { recursive: true });
  await writeFile(path.join(configDir, 'verge.yaml'), '{}');
  await writeFile(
    path.join(configDir, 'profiles.yaml'),
    'current: old\nitems:\n  - uid: old\n    type: local\n    name: 原配置\n    file: old.yaml\n',
  );
  await writeFile(
    path.join(configDir, 'config-manager/owner.json'),
    JSON.stringify({ ids: { local: 'old' }, schemeHash: 'test-hash' }),
  );
  await writeFile(
    path.join(configDir, 'config-manager/monitor/binding.json'),
    JSON.stringify({ enabled: true, hash: 'test-hash' }),
  );
  let monitoring = true;
  const host = {
    inspect: async () => ({ supported: true, version: '2.5.8', running: true }),
    running: async () => true,
    preflight: async () => {},
    start: async () => {},
    monitorStatus: async () => ({
      exists: true,
      running: monitoring,
      enabled: monitoring,
      legacy: true,
    }),
    pauseMonitor: async () => {
      monitoring = false;
    },
    resumeMonitor: async (_device: unknown, state: { migrate?: boolean }) => {
      if (state.migrate) throw new Error('模拟迁移失败');
      monitoring = true;
    },
    lock: async () => async () => {},
  };
  const runtime = {
    read: async () => ({
      proxies: {},
      providers: {},
      rules: [{ type: 'Match', payload: '', proxy: 'DIRECT' }],
    }),
    select: async () => {},
    refresh: async () => {},
  };
  const manager = new Manager({ dataDir: path.join(root, 'data'), host, runtime });
  await manager.execute({ type: 'device.connect', configDir });
  await assert.rejects(manager.execute({ type: 'monitor.start' }));
  assert.equal(monitoring, true);
  const history = await manager.execute({ type: 'deployment.history' });
  assert.equal(history[0].state, 'restored');
});

test('成功应用后的监测补偿失败可从历史重试，不清除已应用方案', async () => {
  const root = await fixture();
  const configDir = path.join(root, 'verge');
  await mkdir(path.join(configDir, 'profiles'), { recursive: true });
  await writeFile(path.join(configDir, 'verge.yaml'), '{}');
  await writeFile(
    path.join(configDir, 'profiles.yaml'),
    'current: old\nitems:\n  - uid: old\n    type: local\n    name: 原配置\n    file: old.yaml\n',
  );
  await writeFile(path.join(configDir, 'profiles/old.yaml'), 'mode: rule\n');
  let running = false;
  let monitoring = false;
  let failure = true;
  const host = {
    inspect: async () => ({ supported: true, version: '2.5.8', running }),
    running: async () => running,
    preflight: async () => {},
    start: async () => {},
    monitorStatus: async () => ({
      exists: true,
      running: monitoring,
      enabled: monitoring,
      legacy: true,
    }),
    pauseMonitor: async () => {
      monitoring = false;
    },
    resumeMonitor: async () => {
      if (failure) throw new Error('模拟恢复失败');
      monitoring = true;
    },
    lock: async () => async () => {},
  };
  const runtime = {
    read: async () => ({
      proxies: {},
      providers: {},
      rules: [{ type: 'Match', payload: '', proxy: 'DIRECT' }],
    }),
    select: async () => {},
    refresh: async () => {},
  };
  const manager = new Manager({ dataDir: path.join(root, 'data'), host, runtime });
  await manager.execute({ type: 'device.connect', configDir });
  const applied = await manager.execute({ type: 'scheme.apply', schemeId: 'default' });
  await writeFile(
    path.join(configDir, 'config-manager/monitor/binding.json'),
    JSON.stringify({ enabled: true, hash: applied.hash }),
  );
  running = true;
  monitoring = true;
  await assert.rejects(manager.execute({ type: 'monitor.start' }));
  const pending = (await manager.execute({ type: 'deployment.history' })).find(
    (row: any) => row.state === 'recovery-required',
  );
  assert.ok(pending);
  failure = false;
  await manager.execute({ type: 'deployment.restore', id: pending.id });
  assert.equal(monitoring, true);
  assert.equal(
    (await manager.execute({ type: 'workspace.read' })).applied.deploymentId,
    applied.deploymentId,
  );
});

test('拒绝覆盖后续修改时，不额外暂停正在运行的监测', async () => {
  const root = await fixture();
  const configDir = path.join(root, 'verge');
  await mkdir(path.join(configDir, 'profiles'), { recursive: true });
  await writeFile(path.join(configDir, 'verge.yaml'), '{}');
  await writeFile(
    path.join(configDir, 'profiles.yaml'),
    'current: old\nitems:\n  - uid: old\n    type: local\n    name: 原配置\n    file: old.yaml\n',
  );
  await writeFile(path.join(configDir, 'profiles/old.yaml'), 'mode: rule\n');
  let monitoring = false;
  let pauses = 0;
  const host = {
    inspect: async () => ({ supported: true, version: '2.5.8', running: false }),
    running: async () => false,
    preflight: async () => {},
    start: async () => {},
    monitorStatus: async () => ({ exists: monitoring, running: monitoring, enabled: monitoring }),
    pauseMonitor: async () => {
      pauses++;
      monitoring = false;
    },
    resumeMonitor: async () => {},
    lock: async () => async () => {},
  };
  const runtime = {
    read: async () => ({
      proxies: {},
      providers: {},
      rules: [{ type: 'Match', payload: '', proxy: 'DIRECT' }],
    }),
    select: async () => {},
    refresh: async () => {},
  };
  const manager = new Manager({ dataDir: path.join(root, 'data'), host, runtime });
  await manager.execute({ type: 'device.connect', configDir });
  const applied = await manager.execute({ type: 'scheme.apply', schemeId: 'default' });
  const changed =
    (await readFile(path.join(configDir, 'profiles.yaml'), 'utf8')) + '# 后续人工修改\n';
  await writeFile(path.join(configDir, 'profiles.yaml'), changed);
  monitoring = true;
  await assert.rejects(
    manager.execute({ type: 'deployment.restore', id: applied.deploymentId }),
    /后续修改/,
  );
  assert.equal(pauses, 0);
  assert.equal(monitoring, true);
  assert.equal(await readFile(path.join(configDir, 'profiles.yaml'), 'utf8'), changed);
});

test('取得锁后在事务登记前崩溃的孤立死锁，可校验留档后继续应用', async () => {
  const root = await fixture();
  const configDir = path.join(root, 'verge');
  await mkdir(path.join(configDir, 'profiles'), { recursive: true });
  await mkdir(path.join(configDir, 'config-sync'), { recursive: true });
  await writeFile(path.join(configDir, 'verge.yaml'), '{}');
  await writeFile(path.join(configDir, 'profiles.yaml'), 'items: []\n');
  const dead = await promisify(execFile)(process.execPath, [
    '-e',
    'process.stdout.write(String(process.pid))',
  ]);
  await writeFile(path.join(configDir, 'config-sync/repository.lock'), dead.stdout);
  await writeFile(path.join(configDir, 'config-sync/import.lock'), dead.stdout);
  await mkdir(path.join(configDir, 'config-manager/leases'), { recursive: true });
  await writeFile(
    path.join(configDir, 'config-manager/leases/11111111-1111-4111-8111-111111111111.json'),
    JSON.stringify({ schemaVersion: 1, owner: 'clash-manager', pid: Number(dead.stdout) }),
  );
  const host = {
    inspect: async () => ({ supported: true, version: '2.5.8', running: false }),
    running: async () => false,
    preflight: async () => {},
    start: async () => {},
    monitorStatus: async () => ({ exists: false, running: false, enabled: false }),
    pauseMonitor: async () => {},
    resumeMonitor: async () => {},
    lock: async () => async () => {},
  };
  const runtime = {
    read: async () => ({
      proxies: {},
      providers: {},
      rules: [{ type: 'Match', payload: '', proxy: 'DIRECT' }],
    }),
    select: async () => {},
    refresh: async () => {},
  };
  const manager = new Manager({ dataDir: path.join(root, 'data'), host, runtime });
  await manager.execute({ type: 'device.connect', configDir });
  await manager.execute({ type: 'scheme.apply', schemeId: 'default' });
  assert.equal((await manager.execute({ type: 'workspace.read' })).applied.schemeId, 'default');
});
