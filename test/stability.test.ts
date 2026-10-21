import test from 'node:test';
import assert from 'node:assert/strict';
import { StabilitySession } from '../src/core/stability.js';
import { MonitorRunner } from '../src/core/monitor.js';
import { monitorSettingsSchema } from '../src/core/model.js';

test('稳定评估保留既有质量门槛，故障时快速恢复且重复样本不增加证据', () => {
  const settings = monitorSettingsSchema.parse({
    freshSeconds: 90,
    failureThreshold: 2,
    cooldownSeconds: 300,
    improvementPoints: 5,
  });
  const session = new StabilitySession(settings);
  const stable = Array.from({ length: 10 }, (_, index) => ({
    at: 10000 - index * 30,
    kind: 'base' as const,
    delay: 150,
  }));
  const flaky = stable.map((sample, index) => ({ ...sample, delay: index < 2 ? 0 : 40 }));
  const decision = session.evaluate({ 稳定: stable, 快但不稳: flaky }, '快但不稳', 10000, '');
  assert.equal(decision.proposed, '稳定');
  assert.ok(decision.metrics.稳定.score > decision.metrics.快但不稳.score);
  const repeated = session.evaluate(
    { 稳定: [...stable, ...stable], 快但不稳: flaky },
    '快但不稳',
    10000,
    '',
  );
  assert.equal(repeated.metrics.稳定.samples, 10);
});

test('监测只写确认的稳定池，不改变费用池和上层模式', async () => {
  const settings = monitorSettingsSchema.parse({ freshSeconds: 90, failureThreshold: 2 });
  const baseUrl = 'https://www.gstatic.com/generate_204';
  const state = {
    proxies: {
      稳定池: { type: 'Fallback', all: ['甲', '乙'], now: '甲', fixed: '' },
      费用池: { type: 'Fallback', all: ['甲', '乙'], now: '甲', fixed: '' },
      模式: { type: 'Selector', all: ['稳定池', '费用池'], now: '费用池', fixed: '' },
    },
    providers: {
      confirmed: {
        proxies: ['甲', '乙'].map((name) => ({
          name,
          extra: {
            [baseUrl]: {
              history: Array.from({ length: 10 }, (_, index) => ({
                time: new Date((10000 - index * 30) * 1000).toISOString(),
                delay: name === '甲' && index < 2 ? 0 : 150,
              })),
            },
          },
        })),
      },
    },
    rules: [],
  };
  const runtime = {
    read: async () => structuredClone(state),
    select: async (name: string, value: string | null) => {
      const row = state.proxies[name as keyof typeof state.proxies];
      row.now = value ?? '甲';
      row.fixed = value ?? '';
    },
    refresh: async () => {},
  };
  const runner = new MonitorRunner(
    { groupName: '稳定池', providerName: 'confirmed', names: ['甲', '乙'], settings },
    runtime,
    async () => {},
    () => 10000,
  );
  await runner.cycle(true);
  assert.equal(state.proxies.稳定池.fixed, '乙');
  assert.equal(state.proxies.费用池.fixed, '');
  assert.equal(state.proxies.模式.now, '费用池');
  await runner.stop();
  assert.equal(state.proxies.稳定池.fixed, '');
  assert.equal(state.proxies.模式.now, '费用池');
});
