'use strict';

// Public, privacy-safe source for arendaproxy.ru/status/. It exposes only
// country-level availability computed from ProxySmart modem_ping; no IMEI,
// client, proxy credentials, IP addresses or internal event text leave the app.
//
// FIX-05/06 (2026-09-18): текущий статус — из modem_ping_state с общей
// политикой свежести src/services/ping-freshness.js (TTL общий с остальными
// потребителями, возраст пересчитывается на каждом чтении, missing/invalid
// наблюдения не считаются ни живыми, ни мёртвыми — они «пропуски»).
// История modem_ping — только пригодные измерения, поэтому агрегаты uptime
// по ней корректны без дополнительной фильтрации.
const pingFresh = require('../services/ping-freshness');

module.exports = function createPublicStatusRouter(deps) {
  const { db, apiServers, SERVER_COUNTRIES, appSettings } = deps;
  const express = require('express');
  const r = express.Router();
  const _ttlMs = () => pingFresh.ttlMs((k, d) => (appSettings && appSettings[k] != null ? appSettings[k] : d));

  function fixedOperationalComponent() {
    const days = [];
    const now = new Date();
    const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    for (let offset = 59; offset >= 0; offset--) {
      days.push({ day: new Date(todayUtc - offset * 86400000).toISOString().slice(0, 10), uptime: 100, checks: 1 });
    }
    return {
      id: 'residential-ru', name: 'Резидентские прокси РФ', country: 'RU',
      status: 'operational', reason: 'product_fixed_100', source: 'product_fixed',
      currentPct: 100, uptime60d: 100, online: 1, total: 1, freshChecks: 1, days,
    };
  }

  function component(country, id, name) {
    const servers = (apiServers || []).filter(s => {
      const meta = (SERVER_COUNTRIES || {})[s.name] || {};
      return String(meta.country || '').toUpperCase() === country;
    }).map(s => s.name);

    if (!servers.length) return { id, name, country, status: 'unknown', reason: 'no_configured_servers', uptime60d: null, online: 0, total: 0, days: [] };
    const marks = servers.map(() => '?').join(',');

    const rosterRows = db.prepare(`
      SELECT server_name, COUNT(DISTINCT imei) AS total
      FROM modem_meta
      WHERE server_name IN (${marks})
        AND imei IS NOT NULL AND TRIM(imei) <> ''
        AND (deleted IS NULL OR deleted = 0)
        AND (is_test_pool IS NULL OR is_test_pool = 0)
      GROUP BY server_name
    `).all(...servers);
    const total = rosterRows.reduce((sum, row) => sum + Number(row.total || 0), 0);

    const latest = db.prepare(`
      SELECT s.server, s.nick, s.quality, s.ok, s.observed_at, s.measured_at
      FROM modem_ping_state s
      WHERE s.server IN (${marks})
        AND EXISTS (
          SELECT 1 FROM modem_meta m
          WHERE m.server_name = s.server AND m.nick = s.nick
            AND (m.deleted IS NULL OR m.deleted = 0)
            AND (m.is_test_pool IS NULL OR m.is_test_pool = 0)
        )
    `).all(...servers);
    const ttl = _ttlMs();
    const nowMs = Date.now();
    let online = 0, freshCount = 0, skipped = 0;
    for (const row of latest) {
      const q = pingFresh.qualityAt(row, nowMs, ttl);
      if (q === 'valid') { freshCount++; if (Number(row.ok) === 1) online++; }
      else if (q === 'missing' || q === 'invalid') skipped++;  // пропуски — отдельно, не 0% и не 100%
      // stale — просто нет свежих данных (как раньше по возрасту ts)
    }
    const denominator = Math.max(total, latest.length);
    // Ноль пригодных измерений → «нет данных» (null), а не 0%/100%.
    const currentPct = (denominator > 0 && freshCount > 0) ? Math.round(online / denominator * 1000) / 10 : null;
    let status = 'unknown';
    if (denominator > 0 && freshCount > 0) status = online === 0 ? 'major_outage' : currentPct >= 98 ? 'operational' : 'degraded';

    const aggregate = db.prepare(`
      SELECT AVG(ok) * 100 AS uptime, COUNT(*) AS checks
      FROM modem_ping
      WHERE server IN (${marks}) AND datetime(ts) >= datetime('now', '-60 days')
        AND EXISTS (
          SELECT 1 FROM modem_meta m
          WHERE m.server_name = modem_ping.server AND m.nick = modem_ping.nick
            AND (m.deleted IS NULL OR m.deleted = 0)
            AND (m.is_test_pool IS NULL OR m.is_test_pool = 0)
        )
    `).get(...servers);
    const uptime60d = aggregate && Number(aggregate.checks) > 0
      ? Math.round(Number(aggregate.uptime) * 1000) / 1000 : null;
    const dailyRows = db.prepare(`
      SELECT substr(ts, 1, 10) AS day, AVG(ok) * 100 AS uptime, COUNT(*) AS checks
      FROM modem_ping
      WHERE server IN (${marks}) AND datetime(ts) >= datetime('now', '-60 days')
        AND EXISTS (
          SELECT 1 FROM modem_meta m
          WHERE m.server_name = modem_ping.server AND m.nick = modem_ping.nick
            AND (m.deleted IS NULL OR m.deleted = 0)
            AND (m.is_test_pool IS NULL OR m.is_test_pool = 0)
        )
      GROUP BY substr(ts, 1, 10)
      ORDER BY day
    `).all(...servers);

    return {
      id, name, country, status,
      currentPct,
      uptime60d,
      online,
      total: denominator,
      freshChecks: freshCount,
      skippedChecks: skipped,
      days: dailyRows.map(row => ({ day: row.day, uptime: Math.round(Number(row.uptime) * 1000) / 1000, checks: Number(row.checks) })),
    };
  }

  r.get('/api/public/status', (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'public, max-age=60, stale-while-revalidate=120');
    const components = [
      component('MD', 'mobile-md', 'Мобильные прокси Молдовы'),
      component('RO', 'mobile-ro', 'Мобильные прокси Румынии'),
      // Product decision: RU is a fixed informational component and is always
      // published as 100%; it is intentionally not backed by telemetry.
      fixedOperationalComponent(),
    ];
    const live = components.filter(c => c.status !== 'unknown');
    const overall = live.length === 0 ? 'unknown'
      : live.some(c => c.status === 'major_outage') ? 'major_outage'
      : live.some(c => c.status === 'degraded') ? 'degraded'
      : 'operational';
    res.json({ updatedAt: new Date().toISOString(), source: 'mixed', staleAfterMinutes: Math.round(_ttlMs() / 60000), overall, components });
  });

  return r;
};
