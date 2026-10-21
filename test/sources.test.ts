import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Manager } from '../src/core/manager.js';
import { fixture } from './fixture.js';

test('来源刷新只提示新节点，已明确选入的聚合成员不自动扩充', async () => {
  const root = await fixture();
  const configDir = path.join(root, 'verge');
  await mkdir(path.join(configDir, 'profiles'), { recursive: true });
  await writeFile(path.join(configDir, 'verge.yaml'), '{}');
  await writeFile(
    path.join(configDir, 'profiles.yaml'),
    'current: remote1\nitems:\n  - uid: remote1\n    type: remote\n    name: 测试来源\n    file: remote1.yaml\n    url: https://example.invalid/subscription\n',
  );
  await writeFile(
    path.join(configDir, 'profiles', 'remote1.yaml'),
    'proxies:\n  - name: 香港甲\n    type: ss\n    server: example.invalid\n    port: 443\n    cipher: aes-128-gcm\n    password: example-only\n',
  );
  const manager = new Manager({
    dataDir: path.join(root, 'data'),
    download: async () => ({
      text: 'proxies:\n  - name: 香港甲\n    type: ss\n    server: example.invalid\n    port: 443\n    cipher: aes-128-gcm\n    password: example-only\n  - name: 香港乙\n    type: ss\n    server: example.invalid\n    port: 443\n    cipher: aes-128-gcm\n    password: example-only\n',
      metadata: {},
    }),
  });
  await manager.execute({ type: 'device.connect', configDir });
  const source = await manager.execute({ type: 'source.adopt', uid: 'remote1' });
  const state = await manager.execute({ type: 'workspace.read' });
  const scheme = state.schemes[0];
  scheme.sourceIds = [source.id];
  scheme.members = [state.nodes[0].id];
  await manager.execute({ type: 'scheme.save', scheme });
  await manager.execute({ type: 'source.refresh', sourceId: source.id });
  const refreshed = await manager.execute({ type: 'workspace.read' });
  assert.equal(refreshed.nodes.filter((node: { missing: boolean }) => !node.missing).length, 2);
  assert.deepEqual(refreshed.schemes[0].members, scheme.members);
  assert.equal(JSON.stringify(refreshed).includes('example-only'), false);
  assert.equal(JSON.stringify(refreshed).includes('/subscription'), false);
});

test('新增来源后，删除仍被方案使用的来源必须给出引用错误', async () => {
  const root = await fixture();
  const configDir = path.join(root, 'verge');
  await mkdir(path.join(configDir, 'profiles'), { recursive: true });
  await writeFile(path.join(configDir, 'verge.yaml'), '{}');
  await writeFile(path.join(configDir, 'profiles.yaml'), 'items: []\n');
  const manager = new Manager({
    dataDir: path.join(root, 'data'),
    download: async () => ({
      text: 'proxies:\n  - name: 节点甲\n    type: ss\n    server: example.invalid\n    port: 443\n    cipher: aes-128-gcm\n    password: example-only\n',
      metadata: {},
    }),
  });
  await manager.execute({ type: 'device.connect', configDir });
  const source = await manager.execute({
    type: 'source.register',
    name: '新增来源',
    url: 'https://example.invalid/new',
  });
  const state = await manager.execute({ type: 'workspace.read' });
  state.schemes[0].sourceIds = [source.id];
  state.schemes[0].members = [state.nodes[0].id];
  await manager.execute({ type: 'scheme.save', scheme: state.schemes[0] });
  await assert.rejects(manager.execute({ type: 'source.remove', sourceId: source.id }), /引用/);
});

test('客户端带增强模板类型时可以完成连接', async () => {
  const root = await fixture();
  const configDir = path.join(root, 'verge');
  await mkdir(path.join(configDir, 'profiles'), { recursive: true });
  await writeFile(path.join(configDir, 'verge.yaml'), '{}');
  await writeFile(
    path.join(configDir, 'profiles.yaml'),
    [
      'current: local1',
      'items:',
      '  - uid: merge1',
      '    type: merge',
      '    name: null',
      '    file: merge1.yaml',
      '  - uid: script1',
      '    type: script',
      '    name: null',
      '    file: script1.js',
      '  - uid: rules1',
      '    type: rules',
      '    name: null',
      '    file: rules1.yaml',
      '  - uid: proxies1',
      '    type: proxies',
      '    name: null',
      '    file: proxies1.yaml',
      '  - uid: groups1',
      '    type: groups',
      '    name: null',
      '    file: groups1.yaml',
      '  - uid: local1',
      '    type: local',
      '    name: 订阅聚合',
      '    file: local1.yaml',
      '    option:',
      '      merge: merge1',
      '      script: script1',
      '      rules: rules1',
      '      proxies: proxies1',
      '      groups: groups1',
      '',
    ].join('\n'),
  );
  for (const file of ['merge1.yaml', 'rules1.yaml', 'proxies1.yaml', 'groups1.yaml'])
    await writeFile(
      path.join(configDir, 'profiles', file),
      'prepend: []\nappend: []\ndelete: []\n',
    );
  await writeFile(
    path.join(configDir, 'profiles', 'script1.js'),
    'function main(config) { return config; }\n',
  );
  await writeFile(path.join(configDir, 'profiles', 'local1.yaml'), 'mode: rule\n');
  const manager = new Manager({ dataDir: path.join(root, 'data') });
  await manager.execute({ type: 'device.connect', configDir });
  const device = await manager.execute({ type: 'device.inspect' });
  assert.equal(device.current, 'local1');
  assert.equal(device.profiles.length, 6);
});

test('客户端扩展绑定指向错误类型时拒绝连接', async () => {
  const root = await fixture();
  const configDir = path.join(root, 'verge');
  await mkdir(path.join(configDir, 'profiles'), { recursive: true });
  await writeFile(path.join(configDir, 'verge.yaml'), '{}');
  await writeFile(
    path.join(configDir, 'profiles.yaml'),
    [
      'current: local1',
      'items:',
      '  - uid: script1',
      '    type: script',
      '    name: null',
      '    file: script1.js',
      '  - uid: rules1',
      '    type: rules',
      '    name: null',
      '    file: rules1.yaml',
      '  - uid: local1',
      '    type: local',
      '    name: 订阅聚合',
      '    file: local1.yaml',
      '    option:',
      '      rules: script1',
      '',
    ].join('\n'),
  );
  await writeFile(
    path.join(configDir, 'profiles', 'script1.js'),
    'function main(config) { return config; }\n',
  );
  await writeFile(
    path.join(configDir, 'profiles', 'rules1.yaml'),
    'prepend: []\nappend: []\ndelete: []\n',
  );
  await writeFile(path.join(configDir, 'profiles', 'local1.yaml'), 'mode: rule\n');
  const manager = new Manager({ dataDir: path.join(root, 'data') });
  await assert.rejects(manager.execute({ type: 'device.connect', configDir }), /扩展绑定无效/);
});

test('协议或端口无效的刷新不会替换最后有效快照', async () => {
  const root = await fixture();
  const configDir = path.join(root, 'verge');
  await mkdir(path.join(configDir, 'profiles'), { recursive: true });
  await writeFile(path.join(configDir, 'verge.yaml'), '{}');
  await writeFile(path.join(configDir, 'profiles.yaml'), 'items: []\n');
  let invalid = false;
  const manager = new Manager({
    dataDir: path.join(root, 'data'),
    download: async () => ({
      text: JSON.stringify({
        proxies: [
          {
            name: '固定甲',
            type: invalid ? 'unknown-protocol' : 'ss',
            server: 'example.invalid',
            port: invalid ? -1 : 443,
            cipher: 'aes-128-gcm',
            password: 'example-only',
          },
        ],
      }),
      metadata: {},
    }),
  });
  await manager.execute({ type: 'device.connect', configDir });
  const source = await manager.execute({
    type: 'source.register',
    name: '来源',
    url: 'https://example.invalid/subscription',
  });
  invalid = true;
  const refreshed = await manager.execute({ type: 'source.refresh', sourceId: source.id });
  assert.equal(refreshed.stale, true);
  assert.equal(refreshed.privateRevision, source.privateRevision);
  assert.equal((await manager.execute({ type: 'workspace.read' })).nodes[0].missing, false);
});
