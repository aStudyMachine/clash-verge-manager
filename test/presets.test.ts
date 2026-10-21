import test from 'node:test';
import assert from 'node:assert/strict';
import { Manager } from '../src/core/manager.js';
import { fixture } from './fixture.js';

test('审阅合入场景预设时保留自定义规则和明确的出口覆盖', async () => {
  const manager = new Manager({ dataDir: await fixture() });
  const { schemes } = await manager.execute({ type: 'workspace.read' });
  const scheme = schemes[0];
  scheme.groups = [{ id: 'ai', name: 'AI 场景', kind: 'scene', strategy: 'select', members: [{ kind: 'builtin', id: 'REJECT' }] }];
  scheme.rules = [{ id: 'mine', kind: 'DOMAIN-SUFFIX', value: 'openai.com', target: { kind: 'builtin', id: 'DIRECT' }, layer: 'custom', options: [] }];
  await manager.execute({ type: 'scheme.save', scheme });
  const review = await manager.execute({ type: 'preset.review', schemeId: 'default', presetId: 'ai', groupId: 'ai' });
  assert.ok(review.additions.length > 0);
  await manager.execute({ type: 'preset.apply', schemeId: 'default', presetId: 'ai', groupId: 'ai', addIds: review.additions.map((rule: { id: string }) => rule.id), removeIds: [] });
  const state = await manager.execute({ type: 'workspace.read' });
  assert.equal(state.schemes[0].rules.find((rule: { id: string }) => rule.id === 'mine').target.id, 'DIRECT');
  const match = await manager.execute({ type: 'rule.explain', schemeId: 'default', context: { domain: 'api.openai.com' } });
  assert.equal(match.ruleId, 'mine');
});
