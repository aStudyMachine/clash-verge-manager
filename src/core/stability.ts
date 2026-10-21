import type { MonitorSettings } from './model.js';

export interface Sample {
  at: number;
  kind: 'base' | 'target';
  delay: number;
  url?: string;
  outcome?: 'ok' | 'networkFailure' | 'httpResponseOnRetry';
}

export interface Metric {
  samples: number; ready: boolean; fresh: boolean; latestOk: boolean; failures: number;
  successRate: number; p95Ms: number; jitterMs: number; shortSamples: number; shortReady: boolean;
  shortSuccessRate: number; shortP95Ms: number; lastBaseAt: number; recoverySuccesses: number;
  targetSamples: number; targetReady: boolean; targetSuccessRate: number | null; targetP95Ms: number | null;
  targetNetworkFailures: number; targetHttpResponsesOnRetry: number; score: number; quarantineUntil?: number;
}

const round = (value: number, decimals = 2) => Number(value.toFixed(decimals));

function summarize(input: Sample[], now: number, settings: MonitorSettings): Metric {
  const unique = new Map(input.map(sample => [`${sample.kind}/${sample.at}/${sample.url ?? ''}`, sample]));
  const rows = [...unique.values()].filter(sample => sample.at >= now - settings.windowSeconds && sample.at <= now + 5);
  const base = rows.filter(sample => sample.kind === 'base').sort((a, b) => a.at - b.at);
  const targets = rows.filter(sample => sample.kind === 'target');
  const delays = base.filter(sample => sample.delay > 0).map(sample => sample.delay).sort((a, b) => a - b);
  const p95 = (values: number[]) => values[Math.max(0, Math.ceil(values.length * .95) - 1)] ?? settings.timeoutMs;
  let failures = 0; let recoverySuccesses = 0;
  for (const sample of [...base].reverse()) { if (sample.delay > 0) break; failures++; }
  for (const sample of [...base].reverse()) { if (sample.delay <= 0) break; recoverySuccesses++; }
  const lastBaseAt = base.at(-1)?.at ?? 0;
  const fresh = !!base.length && now - lastBaseAt <= settings.freshSeconds;
  const short = base.filter(sample => sample.at >= now - settings.shortWindowSeconds);
  const shortDelays = short.filter(sample => sample.delay > 0).map(sample => sample.delay).sort((a, b) => a - b);
  const shortReady = short.length >= settings.shortMinSamples;
  const rate = base.length ? delays.length / base.length : 0;
  const shortRate = short.length ? shortDelays.length / short.length : 0;
  const mean = delays.length ? delays.reduce((sum, value) => sum + value, 0) / delays.length : 0;
  const jitter = delays.length ? Math.sqrt(delays.reduce((sum, value) => sum + (value - mean) ** 2, 0) / delays.length) : settings.timeoutMs;
  const targetReady = targets.length >= settings.minTargetSamples;
  const targetOk = targets.filter(sample => sample.delay > 0 && (sample.outcome ?? 'ok') === 'ok');
  const targetNetworkFailures = targets.filter(sample => sample.outcome === 'networkFailure' || (!sample.outcome && sample.delay <= 0)).length;
  const targetDelays = targetOk.map(sample => sample.delay).sort((a, b) => a - b);
  const targetP95 = targetDelays.length ? p95(targetDelays) : null;
  const score = 60 * rate + 40 * (shortReady ? shortRate : rate) - Math.min(10, p95(delays) / 200) - Math.min(5, jitter / 100)
    - (targetReady ? 15 * targetNetworkFailures / targets.length : 0) - (targetReady && targetP95 !== null ? Math.min(10, targetP95 / 500) : 0);
  return {
    samples: base.length, ready: fresh && base.length >= settings.minSamples, fresh, latestOk: (base.at(-1)?.delay ?? 0) > 0,
    failures, recoverySuccesses, lastBaseAt, successRate: round(rate, 4), p95Ms: p95(delays), jitterMs: round(jitter),
    shortSamples: short.length, shortReady, shortSuccessRate: round(shortRate, 4), shortP95Ms: p95(shortDelays),
    targetSamples: targets.length, targetReady, targetSuccessRate: targets.length ? targetOk.length / targets.length : null,
    targetP95Ms: targetP95, targetNetworkFailures, targetHttpResponsesOnRetry: targets.filter(sample => sample.outcome === 'httpResponseOnRetry').length, score: round(score),
  };
}

// 仅负责稳定池决策；运行调用者在实际选择写入并核验后才确认 switched。
export class StabilitySession {
  private lastSwitch = 0;
  private lastFixed?: string;
  private challenger?: string;
  private rounds = 0;
  private evidence = '';
  private readonly quarantined = new Map<string, number>();
  private readonly lastBadSample = new Map<string, number>();

  constructor(private readonly settings: MonitorSettings) {
    if (settings.freshSeconds >= settings.windowSeconds || settings.shortWindowSeconds >= settings.windowSeconds) throw new Error('稳定评估窗口设置无效');
  }

  private degraded(row?: Metric): boolean {
    return !row?.fresh || row.failures >= this.settings.failureThreshold ||
      (row.ready && row.successRate < this.settings.minSuccessPercent / 100) ||
      (row.shortReady && (row.shortSuccessRate < this.settings.minSuccessPercent / 100 || row.shortP95Ms >= this.settings.slowP95Ms));
  }

  evaluate(samples: Record<string, Sample[]>, current: string, now: number, fixed = '') {
    const metrics = Object.fromEntries(Object.entries(samples).map(([name, rows]) => [name, summarize(rows, now, this.settings)]));
    const lost = !!this.lastFixed && !fixed;
    if (lost) this.quarantined.set(this.lastFixed!, now + this.settings.quarantineSeconds);
    this.lastFixed = fixed;
    for (const [name, row] of Object.entries(metrics)) {
      if (this.degraded(row)) {
        if (row.lastBaseAt && row.lastBaseAt !== this.lastBadSample.get(name)) {
          this.quarantined.set(name, now + this.settings.quarantineSeconds);
          this.lastBadSample.set(name, row.lastBaseAt);
        }
      } else if (this.quarantined.has(name) && now >= this.quarantined.get(name)! && row.recoverySuccesses >= this.settings.recoverySuccesses) this.quarantined.delete(name);
      row.quarantineUntil = this.quarantined.get(name);
    }
    const evidence = JSON.stringify(Object.entries(samples).map(([name, rows]) => [name, Math.max(0, ...rows.filter(row => row.at <= now + 5 && row.at >= now - this.settings.windowSeconds).map(row => row.at))]));
    const newEvidence = evidence !== this.evidence;
    this.evidence = evidence;
    const eligible = Object.entries(metrics).filter(([name, row]) => row.ready && row.shortReady && row.latestOk && !this.degraded(row) && !this.quarantined.has(name));
    let proposed: string | null = null;
    let reason = '样本不足或候选未通过质量及观察期门槛，保留内核回退';
    const best = eligible.reduce<[string, Metric] | undefined>((winner, candidate) => !winner || candidate[1].score > winner[1].score ? candidate : winner, undefined);
    if (!best) { this.challenger = undefined; this.rounds = 0; }
    else if (this.degraded(metrics[current]) || this.quarantined.has(current) || lost) {
      proposed = best[0]; reason = '当前节点劣化或优先值丢失，恢复合格候选'; this.challenger = undefined; this.rounds = 0;
    } else if (best[0] === current || !metrics[current]?.ready || best[1].score < metrics[current].score + this.settings.improvementPoints) {
      reason = '维持当前节点，改善不足'; this.challenger = undefined; this.rounds = 0;
    } else if (!newEvidence) reason = '等待新检测样本';
    else {
      this.rounds = this.challenger === best[0] ? this.rounds + 1 : 1;
      this.challenger = best[0];
      reason = this.rounds < this.settings.confirmRounds ? '候选持续改善，等待连续确认' : now - this.lastSwitch < this.settings.cooldownSeconds ? '处于切换冷却期' : '候选持续显著改善';
      if (this.rounds >= this.settings.confirmRounds && now - this.lastSwitch >= this.settings.cooldownSeconds) proposed = best[0];
    }
    return { metrics, proposed, reason };
  }

  switched(now: number, name: string): void {
    this.lastSwitch = now; this.lastFixed = name; this.challenger = undefined; this.rounds = 0;
  }
}
