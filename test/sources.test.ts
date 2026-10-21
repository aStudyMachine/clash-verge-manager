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
  await writeFile(path.join(configDir, 'profiles.yaml'), 'current: remote1\nitems:\n  - uid: remote1\n    type: remote\n    name: 测试来源\n    file: remote1.yaml\n    url: https://example.invalid/subscription\n');
  await writeFile(path.join(configDir, 'profiles', 'remote1.yaml'), 'proxies:\n  - name: 香港甲\n    type: ss\n    server: example.invalid\n    port: 443\n    cipher: aes-128-gcm\n    password: example-only\n');
  const manager = new Manager({
    dataDir: path.join(root, 'data'),
    download: async () => ({ text: 'proxies:\n  - name: 香港甲\n    type: ss\n    server: example.invalid\n    port: 443\n    password: example-only\n  - name: 香港乙\n    type: ss\n    server: example.invalid\n    port: 443\n    password: example-only\n', metadata: {} }),
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
  const manager = new Manager({ dataDir: path.join(root, 'data'), download: async () => ({ text: 'proxies:\n  - name: 节点甲\n    type: ss\n    server: example.invalid\n    password: example-only\n', metadata: {} }) });
  await manager.execute({ type: 'device.connect', configDir });
  const source = await manager.execute({ type: 'source.register', name: '新增来源', url: 'https://example.invalid/new' });
  const state = await manager.execute({ type: 'workspace.read' });
  state.schemes[0].sourceIds = [source.id];
  state.schemes[0].members = [state.nodes[0].id];
  await manager.execute({ type: 'scheme.save', scheme: state.schemes[0] });
  await assert.rejects(manager.execute({ type: 'source.remove', sourceId: source.id }), /引用/);
});
