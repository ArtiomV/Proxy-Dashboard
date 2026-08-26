'use strict';

// Predictive monitoring over the seven-day server_metrics history.
// The calculations are intentionally local and deterministic: no external
// ML service, no training job and no extra database tables are required.

const DAY_MS = 86400 * 1000;

const METRICS = {
  cpu_pct:      { label: 'CPU',         floor: 15 },
  mem_used_pct: { label: 'RAM',         floor: 10 },
  temp_c:       { label: 'Температура', floor: 8 },
  conns:        { label: 'Соединения',  floor: 20, relativeFloor: 0.30 },
};

function round(value, digits = 1) {
  if (!Number.isFinite(value)) return null;
  const k = 10 ** digits;
  return Math.round(value * k) / k;
}

function finiteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function median(values) {
  const a = values.filter(Number.isFinite).slice().sort((x, y) => x - y);
  if (!a.length) return null;
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

function metricBaseline(rows, field, current, options = {}) {
  const cfg = METRICS[field];
  const value = finiteNumber(current);
  if (!cfg || value == null) return null;
  const minSamples = Math.max(6, Number(options.minSamples) || 24);
  const values = rows.map(r => finiteNumber(r[field])).filter(v => v != null);
  if (values.length < minSamples) {
    return { metric: field, label: cfg.label, current: value, samples: values.length, status: 'insufficient_history', is_anomaly: false };
  }
  const center = median(values);
  const mad = median(values.map(v => Math.abs(v - center))) || 0;
  // Six MAD is robust against normal spikes. The absolute/relative floors
  // keep a very flat history from declaring tiny harmless changes anomalous.
  const minDelta = Math.max(cfg.floor, Math.abs(center) * (cfg.relativeFloor || 0));
  const delta = Math.max(minDelta, mad * 6);
  const threshold = center + delta;
  return {
    metric: field,
    label: cfg.label,
    current: round(value),
    median: round(center),
    mad: round(mad, 2),
    threshold: round(threshold),
    deviation_pct: center > 0 ? round((value - center) / center * 100) : null,
    samples: values.length,
    status: value > threshold ? 'anomaly' : 'normal',
    is_anomaly: value > threshold,
  };
}

function baselines(rows, latest, options = {}) {
  const result = {};
  const anomalies = [];
  for (const field of Object.keys(METRICS)) {
    const item = metricBaseline(rows, field, latest && latest[field], options);
    if (!item) continue;
    result[field] = item;
    if (item.is_anomaly) anomalies.push(item);
  }
  return { baselines: result, anomalies };
}

function diskForecast(rows, options = {}) {
  const minSamples = Math.max(6, Number(options.minSamples) || 24);
  const points = rows.map(r => ({
    ts: Date.parse(r.collected_at),
    used: finiteNumber(r.disk_used_mb),
    total: finiteNumber(r.disk_total_mb),
  })).filter(p => Number.isFinite(p.ts) && p.used != null && p.used >= 0 && p.total != null && p.total > 0)
    .sort((a, b) => a.ts - b.ts);
  if (points.length < minSamples) return { status: 'insufficient_history', samples: points.length };
  const spanDays = (points[points.length - 1].ts - points[0].ts) / DAY_MS;
  if (spanDays < (Number(options.minSpanDays) || 1)) {
    return { status: 'insufficient_history', samples: points.length, span_days: round(spanDays, 2) };
  }

  const origin = points[0].ts;
  const xs = points.map(p => (p.ts - origin) / DAY_MS);
  const ys = points.map(p => p.used);
  const xMean = xs.reduce((s, v) => s + v, 0) / xs.length;
  const yMean = ys.reduce((s, v) => s + v, 0) / ys.length;
  let covariance = 0, varianceX = 0, varianceY = 0;
  for (let i = 0; i < xs.length; i++) {
    covariance += (xs[i] - xMean) * (ys[i] - yMean);
    varianceX += (xs[i] - xMean) ** 2;
    varianceY += (ys[i] - yMean) ** 2;
  }
  const growthMbDay = varianceX > 0 ? covariance / varianceX : 0;
  const r2 = varianceX > 0 && varianceY > 0 ? (covariance ** 2) / (varianceX * varianceY) : 0;
  const latest = points[points.length - 1];
  const freeMb = Math.max(0, latest.total - latest.used);
  const base = {
    samples: points.length,
    span_days: round(spanDays, 2),
    used_mb: round(latest.used),
    total_mb: round(latest.total),
    free_mb: round(freeMb),
    growth_mb_day: round(growthMbDay),
    confidence: round(r2, 2),
  };
  const minGrowth = Math.max(1, Number(options.minGrowthMbDay) || 50);
  const minConfidence = Number.isFinite(Number(options.minConfidence)) ? Number(options.minConfidence) : 0.25;
  if (growthMbDay < minGrowth || r2 < minConfidence) return { ...base, status: 'stable', days_left: null, full_date: null };
  const daysLeft = freeMb / growthMbDay;
  const fullAt = latest.ts + daysLeft * DAY_MS;
  return {
    ...base,
    status: freeMb <= 0 ? 'full' : 'growing',
    days_left: round(Math.max(0, daysLeft), 1),
    full_date: new Date(fullAt).toISOString().slice(0, 10),
  };
}

// Прогноз серверной ёмкости по дневной средней CPU. Сырые 10-минутные
// снимки слишком зависят от времени суток, поэтому сначала сворачиваем их
// в сутки и только затем строим тренд. Прогноз выдаётся лишь при устойчивом
// росте с приемлемой корреляцией — иначе честно возвращаем stable.
function cpuForecast(rows, options = {}) {
  const limit = Math.max(60, Math.min(100, Number(options.limitPct) || 85));
  const minDays = Math.max(3, Number(options.minDays) || 4);
  const groups = new Map();
  for (const row of rows || []) {
    const ts = Date.parse(row.collected_at);
    const value = finiteNumber(row.cpu_pct);
    if (!Number.isFinite(ts) || value == null) continue;
    const day = new Date(ts).toISOString().slice(0, 10);
    const g = groups.get(day) || { ts: Date.parse(day + 'T12:00:00.000Z'), sum: 0, n: 0 };
    g.sum += value; g.n += 1; groups.set(day, g);
  }
  const points = [...groups.values()].map(g => ({ ts: g.ts, value: g.sum / g.n })).sort((a, b) => a.ts - b.ts);
  if (points.length < minDays) return { status: 'insufficient_history', samples: points.length, limit_pct: limit };
  const origin = points[0].ts;
  const xs = points.map(p => (p.ts - origin) / DAY_MS);
  const ys = points.map(p => p.value);
  const xMean = xs.reduce((s, v) => s + v, 0) / xs.length;
  const yMean = ys.reduce((s, v) => s + v, 0) / ys.length;
  let covariance = 0, varianceX = 0, varianceY = 0;
  for (let i = 0; i < xs.length; i++) {
    covariance += (xs[i] - xMean) * (ys[i] - yMean);
    varianceX += (xs[i] - xMean) ** 2;
    varianceY += (ys[i] - yMean) ** 2;
  }
  const growthPctDay = varianceX > 0 ? covariance / varianceX : 0;
  const r2 = varianceX > 0 && varianceY > 0 ? (covariance ** 2) / (varianceX * varianceY) : 0;
  const current = points[points.length - 1].value;
  const base = {
    samples: points.length, current_pct: round(current), limit_pct: limit,
    growth_pct_day: round(growthPctDay, 2), confidence: round(r2, 2),
  };
  if (current >= limit) return { ...base, status: 'capacity_reached', days_left: 0, full_date: new Date(points[points.length - 1].ts).toISOString().slice(0, 10) };
  const minGrowth = Math.max(0.1, Number(options.minGrowthPctDay) || 0.5);
  const minConfidence = Number.isFinite(Number(options.minConfidence)) ? Number(options.minConfidence) : 0.35;
  if (growthPctDay < minGrowth || r2 < minConfidence) return { ...base, status: 'stable', days_left: null, full_date: null };
  const daysLeft = Math.max(0, (limit - current) / growthPctDay);
  return {
    ...base, status: 'growing', days_left: round(daysLeft, 1),
    full_date: new Date(points[points.length - 1].ts + daysLeft * DAY_MS).toISOString().slice(0, 10),
  };
}

function analyze(rows, latest, options = {}) {
  const history = (rows || []).filter(r => !latest || r.id !== latest.id);
  const baselineResult = baselines(history, latest || {}, options);
  return {
    ...baselineResult,
    disk_forecast: diskForecast(rows || [], options),
    cpu_forecast: cpuForecast(rows || [], options),
  };
}

module.exports = { METRICS, median, metricBaseline, baselines, diskForecast, cpuForecast, analyze };
