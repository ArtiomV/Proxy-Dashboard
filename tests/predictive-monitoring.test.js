import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const predictive = require('../src/monitoring/predictive.js');

function row(day, used, cpu = 20) {
  return {
    collected_at: new Date(Date.UTC(2026, 7, 1) + day * 86400e3).toISOString(),
    disk_used_mb: used,
    disk_total_mb: 10000,
    cpu_pct: cpu,
    mem_used_pct: 45,
    temp_c: 50,
    conns: 100,
  };
}

describe('predictive monitoring', () => {
  it('robust baseline ignores normal jitter and detects a large current spike', () => {
    const history = Array.from({ length: 30 }, (_, i) => row(i / 10, 2000 + i * 10, 19 + (i % 4)));
    const normal = predictive.metricBaseline(history, 'cpu_pct', 30, { minSamples: 24 });
    expect(normal.is_anomaly).toBe(false);
    const spike = predictive.metricBaseline(history, 'cpu_pct', 70, { minSamples: 24 });
    expect(spike.is_anomaly).toBe(true);
    expect(spike.median).toBeGreaterThanOrEqual(19);
    expect(spike.threshold).toBeLessThan(70);
  });

  it('does not classify a baseline before enough history is accumulated', () => {
    const item = predictive.metricBaseline([row(0, 1000)], 'cpu_pct', 99, { minSamples: 24 });
    expect(item.status).toBe('insufficient_history');
    expect(item.is_anomaly).toBe(false);
  });

  it('does not turn missing metric values into zero samples', () => {
    const history = Array.from({ length: 30 }, (_, i) => ({ ...row(i / 10, 2000), cpu_pct: null }));
    const item = predictive.metricBaseline(history, 'cpu_pct', 80, { minSamples: 24 });
    expect(item.status).toBe('insufficient_history');
    expect(item.samples).toBe(0);
    expect(predictive.metricBaseline(history, 'cpu_pct', null, { minSamples: 24 })).toBeNull();
  });

  it('forecasts disk exhaustion from a confirmed linear growth trend', () => {
    const rows = Array.from({ length: 49 }, (_, i) => row(i / 24, 2000 + i * (1000 / 24)));
    const f = predictive.diskForecast(rows, { minSamples: 24 });
    expect(f.status).toBe('growing');
    expect(f.growth_mb_day).toBeCloseTo(1000, 0);
    expect(f.days_left).toBeCloseTo(6, 0);
    expect(f.confidence).toBeGreaterThan(0.99);
  });

  it('does not invent an exhaustion date for a flat disk series', () => {
    const rows = Array.from({ length: 49 }, (_, i) => row(i / 24, 4000 + (i % 3)));
    const f = predictive.diskForecast(rows, { minSamples: 24 });
    expect(f.status).toBe('stable');
    expect(f.days_left).toBeNull();
    expect(f.full_date).toBeNull();
  });
});
