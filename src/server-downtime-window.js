'use strict';

const PERIODS = Object.freeze({
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
  '90d': 90 * 24 * 60 * 60 * 1000,
});

function resolvePeriod(value) {
  const key = String(value || '24h').trim();
  return Object.prototype.hasOwnProperty.call(PERIODS, key) ? key : null;
}

function unionDurationSec(events) {
  const ranges = events.map(event => [Date.parse(event.from), Date.parse(event.to)])
    .filter(range => Number.isFinite(range[0]) && Number.isFinite(range[1]) && range[1] > range[0])
    .sort((a, b) => a[0] - b[0]);
  let total = 0, start = null, end = null;
  for (const range of ranges) {
    if (start == null) { [start, end] = range; continue; }
    if (range[0] <= end) { end = Math.max(end, range[1]); continue; }
    total += end - start;
    [start, end] = range;
  }
  if (start != null) total += end - start;
  return Math.round(total / 1000);
}

function buildDowntimeWindow({ rows = [], servers = [], ongoing = {}, nowMs = Date.now(), period = '24h' } = {}) {
  const periodKey = resolvePeriod(period) || '24h';
  const windowMs = PERIODS[periodKey];
  const fromMs = nowMs - windowMs;
  const byName = new Map();

  for (const server of servers || []) {
    if (!server || !server.name) continue;
    byName.set(server.name, {
      name: server.name,
      display_name: server.displayName || server.name,
      country: server.country || '',
      events: [],
    });
  }

  function addEvent(name, rawFrom, rawTo, extra) {
    const from = Math.max(fromMs, Date.parse(rawFrom));
    const to = Math.min(nowMs, rawTo == null ? nowMs : Date.parse(rawTo));
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return;
    if (!byName.has(name)) byName.set(name, { name, display_name: name, country: '', events: [] });
    byName.get(name).events.push({
      from: new Date(from).toISOString(),
      to: new Date(to).toISOString(),
      duration_sec: Math.round((to - from) / 1000),
      ongoing: !!(extra && extra.ongoing),
      maintenance: !!(extra && extra.maintenance),
      alerted: !!(extra && extra.alerted),
    });
  }

  for (const row of rows || []) {
    addEvent(row.server_name, row.down_from, row.down_to, {
      ongoing: row.down_to == null,
      maintenance: Number(row.maintenance) === 1,
      alerted: Number(row.alerted) === 1,
    });
  }
  for (const [name, since] of Object.entries(ongoing || {})) {
    if (!Number.isFinite(Number(since))) continue;
    const server = byName.get(name);
    if (server && server.events.some(event => event.ongoing)) continue;
    addEvent(name, new Date(Number(since)).toISOString(), null, { ongoing: true });
  }

  const result = Array.from(byName.values()).map(server => {
    server.events.sort((a, b) => Date.parse(a.from) - Date.parse(b.from));
    const durationSec = unionDurationSec(server.events);
    return {
      ...server,
      episodes: server.events.length,
      duration_sec: durationSec,
      uptime_pct: Math.round(Math.max(0, 100 * (1 - durationSec / (windowMs / 1000))) * 1000) / 1000,
    };
  });

  return {
    period: periodKey,
    from: new Date(fromMs).toISOString(),
    to: new Date(nowMs).toISOString(),
    window_sec: Math.round(windowMs / 1000),
    servers: result,
  };
}

module.exports = { PERIODS, resolvePeriod, unionDurationSec, buildDowntimeWindow };
