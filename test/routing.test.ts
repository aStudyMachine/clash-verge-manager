import test from 'node:test';
import assert from 'node:assert/strict';
import { Manager } from '../src/core/manager.js';
import { fixture } from './fixture.js';

test('自定义规则能覆盖预设，命中预览给出真正的首条规则', async () => {
  const manager = new Manager({ dataDir: await fixture() });
  const { schemes } = await manager.execute({ type: 'workspace.read' });
  const scheme = schemes[0];
  scheme.rules = [
    { id: 'preset-rule', kind: 'DOMAIN-SUFFIX', value: 'example.com', target: { kind: 'builtin', id: 'REJECT' }, layer: 'preset', options: [] },
    { id: 'custom-rule', kind: 'DOMAIN-SUFFIX', value: 'example.com', target: { kind: 'builtin', id: 'DIRECT' }, layer: 'custom', options: [] },
  ];
  await manager.execute({ type: 'scheme.save', scheme });
  const preview = await manager.execute({ type: 'scheme.preview', schemeId: scheme.id });
  assert.equal(preview.valid, true);
  assert.deepEqual(preview.rules, ['DOMAIN-SUFFIX,example.com,DIRECT', 'MATCH,DIRECT']);
  const match = await manager.execute({ type: 'rule.explain', schemeId: scheme.id, context: { domain: 'api.example.com' } });
  assert.equal(match.status, 'matched');
  assert.equal(match.ruleId, 'custom-rule');
  assert.deepEqual(match.chain, ['DIRECT']);
});

test('专属服务域名必须先于宽泛场景，添加预设的顺序不影响去向', async () => {
  const manager = new Manager({ dataDir: await fixture() });
  const scheme = (await manager.execute({ type: 'workspace.read' })).schemes[0];
  scheme.rules = [
    { id: 'broad', kind: 'DOMAIN-SUFFIX', value: 'google.com', target: { kind: 'builtin', id: 'DIRECT' }, layer: 'preset', options: [] },
    { id: 'specific', kind: 'DOMAIN', value: 'ai.google.com', target: { kind: 'builtin', id: 'REJECT' }, layer: 'preset', options: [] },
  ];
  await manager.execute({ type: 'scheme.save', scheme });
  assert.equal((await manager.execute({ type: 'rule.explain', schemeId: scheme.id, context: { domain: 'ai.google.com' } })).ruleId, 'specific');
});
