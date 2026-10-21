import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { Manager } from '../src/core/manager.js';
import { fixture } from './fixture.js';
import type { Shared } from '../src/core/shared.js';

test('两台设备发布同一方案自动递增，获取新版本不应用并保留其他方案', async () => {
  const root = await fixture();
  const remote = path.join(root, 'remote.git');
  await promisify(execFile)('git', ['init', '--bare', remote]);
  const options = { gitPath: 'git', allowFileRemote: true, now: () => new Date('2026-10-21T08:00:00Z') };
  const first = new Manager({ ...options, dataDir: path.join(root, 'first') });
  const second = new Manager({ ...options, dataDir: path.join(root, 'second') });
  await first.execute({ type: 'git.configure', remote });
  await second.execute({ type: 'git.configure', remote });
  const published = await first.execute({ type: 'scheme.publish', schemeId: 'default', summary: '初次发布' });
  assert.equal(published.version, '2026.10.21.1');
  const independent = await first.execute({ type: 'scheme.create', name: '其他方案' });
  await first.execute({ type: 'scheme.publish', schemeId: independent.id, summary: '新增另一方案' });
  await second.execute({ type: 'git.fetch' });
  const received = await second.execute({ type: 'workspace.read' });
  received.schemes.find((scheme: { id: string }) => scheme.id === 'default').name = '办公';
  await second.execute({ type: 'scheme.save', scheme: received.schemes.find((scheme: { id: string }) => scheme.id === 'default') });
  const newer = await second.execute({ type: 'scheme.publish', schemeId: 'default', summary: '第二台调整' });
  assert.equal(newer.version, '2026.10.21.2');
  await first.execute({ type: 'git.fetch' });
  const state = await first.execute({ type: 'workspace.read' });
  assert.equal(state.schemes.find((scheme: { id: string }) => scheme.id === 'default').name, '办公');
  assert.equal(state.schemes.some((scheme: { id: string }) => scheme.id === independent.id), true);
  assert.equal(state.applied, null);
});

test('删除发布保留历史，其他设备的旧草稿不能复活方案', async () => {
  const root = await fixture(); const remote = path.join(root, 'remote.git');
  await promisify(execFile)('git', ['init', '--bare', remote]);
  const options = { gitPath: 'git', allowFileRemote: true };
  const first = new Manager({ ...options, dataDir: path.join(root, 'first') });
  const second = new Manager({ ...options, dataDir: path.join(root, 'second') });
  await first.execute({ type: 'git.configure', remote }); await second.execute({ type: 'git.configure', remote });
  await first.execute({ type: 'scheme.publish', schemeId: 'default', summary: '初次发布' });
  await second.execute({ type: 'git.fetch' });
  await first.execute({ type: 'scheme.remove', schemeId: 'default' });
  await first.execute({ type: 'git.publishChanges', summary: '删除默认方案' });
  await assert.rejects(second.execute({ type: 'scheme.publish', schemeId: 'default', summary: '旧草稿' }), /删除/);
  await second.execute({ type: 'git.fetch' });
  assert.equal((await second.execute({ type: 'workspace.read' })).schemes.length, 0);
  assert.equal((await second.execute({ type: 'git.history', schemeId: 'default' })).length, 1);
  assert.equal((await second.execute({ type: 'recovery.list' })).some((row: any) => row.schemeId === 'default'), true);
});

test('远端接受但响应丢失，重试识别原请求且不覆盖后续版本', async () => {
  const root = await fixture(); let stored: Shared = { schemaVersion: 1, catalog: { revision: 0, sources: {} }, schemes: {} };
  let failRead = false; let loseResponse = true; let serial = 0;
  const remote = {
    read: async () => { if (failRead) throw new Error('模拟断网'); return { head: serial ? String(serial) : null, data: structuredClone(stored) }; },
    write: async (_parent: string | null, data: Shared) => { stored = structuredClone(data); serial++; if (loseResponse) { failRead = true; throw new Error('模拟响应丢失'); } return String(serial); },
  };
  const first = new Manager({ dataDir: path.join(root, 'first'), remote });
  const second = new Manager({ dataDir: path.join(root, 'second'), remote });
  await first.execute({ type: 'git.configure', remote: 'https://example.invalid/config.git' });
  await second.execute({ type: 'git.configure', remote: 'https://example.invalid/config.git' });
  await assert.rejects(first.execute({ type: 'scheme.publish', schemeId: 'default', summary: '原请求' }));
  failRead = false; loseResponse = false;
  await second.execute({ type: 'git.fetch' });
  const scheme = (await second.execute({ type: 'workspace.read' })).schemes[0]; scheme.name = '后续修改';
  await second.execute({ type: 'scheme.save', scheme });
  const later = await second.execute({ type: 'scheme.publish', schemeId: 'default', summary: '另一设备' });
  const retried = await first.execute({ type: 'scheme.publish', schemeId: 'default', summary: '原请求' });
  assert.notEqual(retried.version, later.version); assert.equal(serial, 2);
  await first.execute({ type: 'git.fetch' });
  assert.equal((await first.execute({ type: 'workspace.read' })).schemes[0].name, '后续修改');
});
