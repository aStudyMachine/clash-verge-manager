import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { Manager } from '../src/core/manager.js';
import { fixture } from './fixture.js';
import type { Shared } from '../src/core/shared.js';

test('两台设备发布同一方案自动递增，获取新版本不应用并保留其他方案', async () => {
  const root = await fixture();
  const remote = path.join(root, 'remote.git');
  await promisify(execFile)('git', ['init', '--bare', remote]);
  const options = {
    gitPath: 'git',
    allowFileRemote: true,
    now: () => new Date('2026-10-21T08:00:00Z'),
  };
  const first = new Manager({ ...options, dataDir: path.join(root, 'first') });
  const second = new Manager({ ...options, dataDir: path.join(root, 'second') });
  await first.execute({ type: 'git.configure', remote });
  await second.execute({ type: 'git.configure', remote });
  const published = await first.execute({
    type: 'scheme.publish',
    schemeId: 'default',
    summary: '初次发布',
  });
  assert.equal(published.version, '2026.10.21.1');
  const independent = await first.execute({ type: 'scheme.create', name: '其他方案' });
  await first.execute({
    type: 'scheme.publish',
    schemeId: independent.id,
    summary: '新增另一方案',
  });
  await second.execute({ type: 'git.fetch' });
  const received = await second.execute({ type: 'workspace.read' });
  received.schemes.find((scheme: { id: string }) => scheme.id === 'default').name = '办公';
  await second.execute({
    type: 'scheme.save',
    scheme: received.schemes.find((scheme: { id: string }) => scheme.id === 'default'),
  });
  const newer = await second.execute({
    type: 'scheme.publish',
    schemeId: 'default',
    summary: '第二台调整',
  });
  assert.equal(newer.version, '2026.10.21.2');
  await first.execute({ type: 'git.fetch' });
  const state = await first.execute({ type: 'workspace.read' });
  assert.equal(
    state.schemes.find((scheme: { id: string }) => scheme.id === 'default').name,
    '办公',
  );
  assert.equal(
    state.schemes.some((scheme: { id: string }) => scheme.id === independent.id),
    true,
  );
  assert.equal(state.applied, null);
});

test('删除发布保留历史，其他设备的旧草稿不能复活方案', async () => {
  const root = await fixture();
  const remote = path.join(root, 'remote.git');
  await promisify(execFile)('git', ['init', '--bare', remote]);
  const options = { gitPath: 'git', allowFileRemote: true };
  const first = new Manager({ ...options, dataDir: path.join(root, 'first') });
  const second = new Manager({ ...options, dataDir: path.join(root, 'second') });
  await first.execute({ type: 'git.configure', remote });
  await second.execute({ type: 'git.configure', remote });
  await first.execute({ type: 'scheme.publish', schemeId: 'default', summary: '初次发布' });
  const disposable = await first.execute({ type: 'scheme.create', name: '临时方案' });
  await first.execute({
    type: 'scheme.publish',
    schemeId: disposable.id,
    summary: '发布临时方案',
  });
  await second.execute({ type: 'git.fetch' });
  await first.execute({ type: 'scheme.remove', schemeId: disposable.id });
  await first.execute({ type: 'git.publishChanges', summary: '删除临时方案' });
  await assert.rejects(
    second.execute({ type: 'scheme.publish', schemeId: disposable.id, summary: '旧草稿' }),
    /删除/,
  );
  await second.execute({ type: 'git.fetch' });
  const remaining = await second.execute({ type: 'workspace.read' });
  assert.deepEqual(
    remaining.schemes.map((scheme: { id: string }) => scheme.id),
    ['default'],
  );
  assert.equal(
    (await second.execute({ type: 'git.history', schemeId: disposable.id })).length,
    1,
  );
  assert.equal(
    (await second.execute({ type: 'recovery.list' })).some(
      (row: any) => row.schemeId === disposable.id,
    ),
    true,
  );
});

test('远端接受但响应丢失，重试识别原请求且不覆盖后续版本', async () => {
  const root = await fixture();
  let stored: Shared = { schemaVersion: 1, catalog: { revision: 0, sources: {} }, schemes: {} };
  let failRead = false;
  let loseResponse = true;
  let serial = 0;
  const remote = {
    read: async () => {
      if (failRead) throw new Error('模拟断网');
      return { head: serial ? String(serial) : null, data: structuredClone(stored) };
    },
    write: async (_parent: string | null, data: Shared) => {
      stored = structuredClone(data);
      serial++;
      if (loseResponse) {
        failRead = true;
        throw new Error('模拟响应丢失');
      }
      return String(serial);
    },
  };
  const first = new Manager({ dataDir: path.join(root, 'first'), remote });
  const second = new Manager({ dataDir: path.join(root, 'second'), remote });
  await first.execute({ type: 'git.configure', remote: 'https://example.invalid/config.git' });
  await second.execute({ type: 'git.configure', remote: 'https://example.invalid/config.git' });
  await assert.rejects(
    first.execute({ type: 'scheme.publish', schemeId: 'default', summary: '原请求' }),
  );
  failRead = false;
  loseResponse = false;
  await second.execute({ type: 'git.fetch' });
  const scheme = (await second.execute({ type: 'workspace.read' })).schemes[0];
  scheme.name = '后续修改';
  await second.execute({ type: 'scheme.save', scheme });
  const later = await second.execute({
    type: 'scheme.publish',
    schemeId: 'default',
    summary: '另一设备',
  });
  const retried = await first.execute({
    type: 'scheme.publish',
    schemeId: 'default',
    summary: '原请求',
  });
  assert.notEqual(retried.version, later.version);
  assert.equal(serial, 2);
  await first.execute({ type: 'git.fetch' });
  assert.equal((await first.execute({ type: 'workspace.read' })).schemes[0].name, '后续修改');
});

test('已知远端主分支消失后停止同步，不把空远端当成首次接入', async () => {
  const root = await fixture();
  const remote = path.join(root, 'remote.git');
  await promisify(execFile)('git', ['init', '--bare', remote]);
  const manager = new Manager({
    dataDir: path.join(root, 'data'),
    gitPath: 'git',
    allowFileRemote: true,
  });
  await manager.execute({ type: 'git.configure', remote });
  await manager.execute({ type: 'scheme.publish', schemeId: 'default', summary: '历史基线' });
  await promisify(execFile)('git', ['--git-dir', remote, 'update-ref', '-d', 'refs/heads/main']);
  await assert.rejects(manager.execute({ type: 'git.fetch' }), /分支消失/);
  await assert.rejects(
    manager.execute({ type: 'scheme.publish', schemeId: 'default', summary: '不能重建历史' }),
    /分支消失/,
  );
});

test('处理方案引用后全局删除来源，同一发布提交全部方案和目录墓碑', async () => {
  const root = await fixture();
  const remote = path.join(root, 'remote.git');
  const configDir = path.join(root, 'verge');
  await promisify(execFile)('git', ['init', '--bare', remote]);
  await mkdir(path.join(configDir, 'profiles'), { recursive: true });
  await writeFile(path.join(configDir, 'profiles.yaml'), 'items: []\n');
  await writeFile(path.join(configDir, 'verge.yaml'), '{}');
  const options = { gitPath: 'git', allowFileRemote: true };
  const first = new Manager({
    ...options,
    dataDir: path.join(root, 'first'),
    download: async () => ({
      text: 'proxies:\n  - name: 固定甲\n    type: ss\n    server: example.invalid\n    port: 443\n    cipher: aes-128-gcm\n    password: example-only\n',
      metadata: {},
    }),
  });
  const second = new Manager({ ...options, dataDir: path.join(root, 'second') });
  await first.execute({ type: 'device.connect', configDir });
  await first.execute({ type: 'git.configure', remote });
  await second.execute({ type: 'git.configure', remote });
  const source = await first.execute({
    type: 'source.register',
    name: '来源',
    url: 'https://example.invalid/subscription',
  });
  const state = await first.execute({ type: 'workspace.read' });
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
  await first.execute({ type: 'scheme.save', scheme });
  const copied = await first.execute({ type: 'scheme.clone', schemeId: 'default', name: '办公' });
  await first.execute({ type: 'git.publishChanges', summary: '初始两个方案' });
  await second.execute({ type: 'git.fetch' });
  for (const schemeId of ['default', copied.id])
    await first.execute({
      type: 'scheme.removeObject',
      schemeId,
      kind: 'source',
      id: source.id,
      replacement: { kind: 'builtin', id: 'DIRECT' },
    });
  await first.execute({ type: 'source.remove', sourceId: source.id });
  await first.execute({ type: 'git.publishChanges', summary: '删除来源并移除全部引用' });
  await assert.rejects(
    second.execute({ type: 'scheme.publish', schemeId: 'default', summary: '旧来源不能复活' }),
    /来源已删除/,
  );
  await second.execute({ type: 'git.fetch' });
  const final = await second.execute({ type: 'workspace.read' });
  assert.equal(final.sources[0].deleted, true);
  assert.ok(final.schemes.every((scheme: any) => scheme.sourceIds.length === 0));
  assert.equal((await second.execute({ type: 'git.history', schemeId: 'default' })).length, 2);
});
