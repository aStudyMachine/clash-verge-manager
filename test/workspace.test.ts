import test from 'node:test';
import assert from 'node:assert/strict';
import { Manager } from '../src/core/manager.js';
import { fixture } from './fixture.js';

test('首次只有 default，保存的独立方案在重开后仍可读取', async () => {
  const dataDir = await fixture();
  const manager = new Manager({ dataDir });
  const initial = await manager.execute({ type: 'workspace.read' });
  assert.deepEqual(
    initial.schemes.map((scheme: { name: string }) => scheme.name),
    ['default'],
  );
  const created = await manager.execute({ type: 'scheme.create', name: '办公' });
  const reopened = new Manager({ dataDir });
  const saved = await reopened.execute({ type: 'workspace.read' });
  assert.deepEqual(
    saved.schemes.map((scheme: { name: string }) => scheme.name),
    ['default', '办公'],
  );
  assert.equal(saved.schemes[1].id, created.id);
  assert.equal(saved.applied, null);
});

test('默认方案不可删除，其他方案仍可删除', async () => {
  const manager = new Manager({ dataDir: await fixture() });
  const created = await manager.execute({ type: 'scheme.create', name: '临时方案' });
  await assert.rejects(
    manager.execute({ type: 'scheme.remove', schemeId: 'default' }),
    /默认方案不可删除/,
  );
  const kept = await manager.execute({ type: 'workspace.read' });
  assert.deepEqual(
    kept.schemes.map((scheme: { id: string }) => scheme.id),
    ['default', created.id],
  );
  await manager.execute({ type: 'scheme.remove', schemeId: created.id });
  const after = await manager.execute({ type: 'workspace.read' });
  assert.deepEqual(
    after.schemes.map((scheme: { id: string }) => scheme.id),
    ['default'],
  );
});

test('复制方案后独立编辑，替换被删除组的引用不影响原方案', async () => {
  const manager = new Manager({ dataDir: await fixture() });
  const original = (await manager.execute({ type: 'workspace.read' })).schemes[0];
  original.groups = [
    {
      id: 'exit',
      name: '出口',
      kind: 'strategy',
      strategy: 'select',
      members: [{ kind: 'builtin', id: 'DIRECT' }],
    },
    {
      id: 'scene',
      name: '场景',
      kind: 'scene',
      strategy: 'select',
      members: [{ kind: 'group', id: 'exit' }],
    },
  ];
  await manager.execute({ type: 'scheme.save', scheme: original });
  const copied = await manager.execute({ type: 'scheme.clone', schemeId: 'default', name: '办公' });
  await manager.execute({
    type: 'scheme.removeObject',
    schemeId: copied.id,
    kind: 'group',
    id: 'exit',
    replacement: { kind: 'builtin', id: 'REJECT' },
  });
  const state = await manager.execute({ type: 'workspace.read' });
  assert.equal(
    state.schemes.find((scheme: { id: string }) => scheme.id === 'default').groups.length,
    2,
  );
  const updated = state.schemes.find((scheme: { id: string }) => scheme.id === copied.id);
  assert.equal(updated.groups.length, 1);
  assert.deepEqual(updated.groups[0].members, [{ kind: 'builtin', id: 'REJECT' }]);
});

test('用户保存循环组引用后，预览明确阻止应用', async () => {
  const manager = new Manager({ dataDir: await fixture() });
  const workspace = await manager.execute({ type: 'workspace.read' });
  const scheme = workspace.schemes[0];
  scheme.groups = [
    {
      id: 'a',
      name: '组甲',
      kind: 'strategy',
      strategy: 'select',
      members: [{ kind: 'group', id: 'b' }],
    },
    {
      id: 'b',
      name: '组乙',
      kind: 'strategy',
      strategy: 'select',
      members: [{ kind: 'group', id: 'a' }],
    },
  ];
  await manager.execute({ type: 'scheme.save', scheme });
  const preview = await manager.execute({ type: 'scheme.preview', schemeId: scheme.id });
  assert.equal(preview.valid, false);
  assert.ok(preview.issues.some((issue: { code: string }) => issue.code === 'GROUP_CYCLE'));
});
