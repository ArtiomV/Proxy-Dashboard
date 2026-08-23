'use strict';

// Public, privacy-safe source for arendaproxy.ru/status/. It exposes only
// country-level availability computed from ProxySmart modem_ping; no IMEI,
// client, proxy credentials, IP addresses or internal event text leave the app.
module.exports = function createPublicStatusRouter(deps) {
  const { db, apiServers, SERVER_COUNTRIES } = deps;
  const express = require('express');
  const r = express.Router();
  const STALE_MIN = 10;

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
      WITH ranked AS (
        SELECT server, nick, ts, ok,
               ROW_NUMBER() OVER (PARTITION BY server, nick ORDER BY ts DESC) AS rn
        FROM modem_ping p
        WHERE server IN (${marks})
          AND EXISTS (
            SELECT 1 FROM modem_meta m
            WHERE m.server_name = p.server AND m.nick = p.nick
              AND (m.deleted IS NULL OR m.deleted = 0)
              AND (m.is_test_pool IS NULL OR m.is_test_pool = 0)
          )
      )
      SELECT server, nick, ts, ok FROM ranked WHERE rn = 1
    `).all(...servers);
    const freshCutoff = Date.now() - STALE_MIN * 60000;
    const fresh = latest.filter(row => {
      const t = Date.parse(row.ts);
      return Number.isFinite(t) && t >= freshCutoff;
    });
    const online = fresh.filter(row => Number(row.ok) === 1).length;
    const denominator = Math.max(total, latest.length);
    const currentPct = denominator > 0 ? Math.round(online / denominator * 1000) / 10 : null;
    let status = 'unknown';
    if (denominator > 0 && fresh.length > 0) status = online === 0 ? 'major_outage' : currentPct >= 98 ? 'operational' : 'degraded';

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
      freshChecks: fresh.length,
      days: dailyRows.map(row => ({ day: row.day, uptime: Math.round(Number(row.uptime) * 1000) / 1000, checks: Number(row.checks) })),
    };
  }

  r.get('/api/public/status', (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'public, max-age=60, stale-while-revalidate=120');
    const components = [
      component('MD', 'mobile-md', 'Мобильные прокси Молдовы'),
      component('RO', 'mobile-ro', 'Мобильные прокси Румынии'),
      // This product has no telemetry in Dashboard yet. Returning unknown is
      // deliberate: the public page must never manufacture 100% uptime.
      { id: 'residential-ru', name: 'Резидентские прокси РФ', country: 'RU', status: 'unknown', reason: 'telemetry_not_connected', uptime60d: null, online: 0, total: 0, days: [] },
    ];
    const live = components.filter(c => c.status !== 'unknown');
    const overall = live.length === 0 ? 'unknown'
      : live.some(c => c.status === 'major_outage') ? 'major_outage'
      : live.some(c => c.status === 'degraded') ? 'degraded'
      : 'operational';
    res.json({ updatedAt: new Date().toISOString(), source: 'proxysmart_ping_stats', staleAfterMinutes: STALE_MIN, overall, components });
  });

  return r;
};
