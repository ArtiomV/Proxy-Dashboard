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
//
// 2026-10-13: история uptime за 60 дней — из инкрементального кэша, а не
// запросом на каждый визит. Раньше каждый запрос страницы статуса гнал по
// modem_ping (~7 млн строк) четыре полных скана с datetime(ts) (индекс не
// работает) и коррелированным EXISTS — синхронно, на event loop: ~45 с
// полной остановки дашборда на КАЖДЫЙ визит arendaproxy.ru/status
// (совпадения с лагами 12.10 07:35/10:52/13:32 и 13.10 02:34 — до секунды).
// Теперь: прошедшие сутки неизменны — считаются один раз на модем по
// индексу (server, nick, ts), сегодняшние — пересчитываются раз в 5 минут;
// каждый модем — отдельный тик event loop. В агрегаты идут только модемы с
// клиентом (src/modems/stat-scope.js) — свободные SIM статистику не портят.
const pingFresh = require('../services/ping-freshness');
const statScope = require('../modems/stat-scope');

const HISTORY_DAYS = 60;
const HISTORY_REFRESH_MS = 5 * 60 * 1000;
const _dayMs = 86400000;
const _utcDay = (ms) => new Date(ms).toISOString().slice(0, 10);

module.exports = function createPublicStatusRouter(deps) {
  const { db, apiServers, SERVER_COUNTRIES, appSettings, logger } = deps;
  const express = require('express');
  const r = express.Router();
  const _ttlMs = () => pingFresh.ttlMs((k, d) => (appSettings && appSettings[k] != null ? appSettings[k] : d));
  const _knownModems = () => deps.knownModems || null;

  // Модем входит в публичную статистику: не удалён, не тест-пул (как
  // раньше) и — если ростер загружен — с клиентом.
  function _inScope(bound, server, nick, imei) {
    if (!bound.size) return true;
    return bound.has(server + '|' + nick) || (!!imei && bound.has(server + '|' + imei));
  }

  // ── Кэш истории: key 'server|nick' → { finalizedBefore: 'YYYY-MM-DD', days: Map(day → {ok, n, checks}) }
  const _hist = new Map();
  let _histScope = new Set();   // модемы, прошедшие фильтр удалён/тест-пул в последнем проходе
  let _histBuilding = null;
  let _histStartedAt = 0;
  let _stmtCandidates = null, _stmtRange = null;

  function _prep() {
    if (_stmtRange) return;
    _stmtCandidates = db.prepare(`
      SELECT DISTINCT server_name AS server, nick FROM modem_meta
      WHERE nick IS NOT NULL AND TRIM(nick) <> ''
        AND (deleted IS NULL OR deleted = 0)
        AND (is_test_pool IS NULL OR is_test_pool = 0)
    `);
    _stmtRange = db.prepare(`
      SELECT substr(ts, 1, 10) AS day, SUM(ok) AS ok, COUNT(ok) AS n, COUNT(*) AS checks
      FROM modem_ping
      WHERE server = ? AND nick = ? AND ts >= ? AND ts < ?
      GROUP BY substr(ts, 1, 10)
    `);
  }

  async function refreshHistory() {
    if (_histBuilding) return _histBuilding;
    _histStartedAt = Date.now();
    _histBuilding = (async () => {
      _prep();
      const nowMs = Date.now();
      const today = _utcDay(nowMs);
      const cutoff = _utcDay(nowMs - HISTORY_DAYS * _dayMs);
      const tomorrowIso = _utcDay(nowMs + _dayMs) + 'T00:00:00.000Z';
      const servers = new Set((apiServers || []).map(s => s.name));
      const candidates = _stmtCandidates.all().filter(c => servers.has(c.server));
      _histScope = new Set(candidates.map(c => c.server + '|' + c.nick));
      for (const c of candidates) {
        const key = c.server + '|' + c.nick;
        let h = _hist.get(key);
        if (!h) { h = { finalizedBefore: cutoff, days: new Map() }; _hist.set(key, h); }
        if (h.finalizedBefore < cutoff) h.finalizedBefore = cutoff;
        // Прошедшие сутки (один раз), затем сегодняшние (каждый проход).
        const from = h.finalizedBefore + 'T00:00:00.000Z';
        for (const row of _stmtRange.all(c.server, c.nick, from, tomorrowIso)) {
          h.days.set(row.day, { ok: Number(row.ok || 0), n: Number(row.n || 0), checks: Number(row.checks || 0) });
        }
        h.finalizedBefore = today;
        for (const d of h.days.keys()) if (d < cutoff) h.days.delete(d);
        await new Promise(resolve => setImmediate(resolve));
      }
    })().catch((e) => {
      if (logger && logger.warn) logger.warn('[PublicStatus] history refresh failed: ' + (e.message || e));
    }).finally(() => { _histBuilding = null; });
    return _histBuilding;
  }

  function _maybeRefresh() {
    if (!_histBuilding && Date.now() - _histStartedAt > HISTORY_REFRESH_MS) refreshHistory();
  }

  if (deps.warmup !== false) {
    const t = setTimeout(() => { refreshHistory(); }, 60 * 1000);
    if (t.unref) t.unref();
  }

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
    const bound = statScope.boundModemKeys(_knownModems());

    const rosterRows = db.prepare(`
      SELECT DISTINCT server_name, imei, nick
      FROM modem_meta
      WHERE server_name IN (${marks})
        AND imei IS NOT NULL AND TRIM(imei) <> ''
        AND (deleted IS NULL OR deleted = 0)
        AND (is_test_pool IS NULL OR is_test_pool = 0)
    `).all(...servers);
    const rosterImeis = new Set();
    for (const row of rosterRows) {
      if (_inScope(bound, row.server_name, row.nick, row.imei)) rosterImeis.add(row.server_name + '|' + row.imei);
    }
    const total = rosterImeis.size;

    const latest = db.prepare(`
      SELECT s.server, s.nick, s.imei, s.quality, s.ok, s.observed_at, s.measured_at
      FROM modem_ping_state s
      WHERE s.server IN (${marks})
        AND EXISTS (
          SELECT 1 FROM modem_meta m
          WHERE m.server_name = s.server AND m.nick = s.nick
            AND (m.deleted IS NULL OR m.deleted = 0)
            AND (m.is_test_pool IS NULL OR m.is_test_pool = 0)
        )
    `).all(...servers).filter(row => _inScope(bound, row.server, row.nick, row.imei));
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

    // История — только из кэша; пока он не прогрет, uptime60d = null
    // («нет данных»), а не блокирующий скан.
    const cutoff = _utcDay(nowMs - HISTORY_DAYS * _dayMs);
    const serverSet = new Set(servers);
    const perDay = new Map();
    let sumOk = 0, sumN = 0;
    for (const [key, h] of _hist) {
      const sep = key.indexOf('|');
      const srv = key.slice(0, sep), nick = key.slice(sep + 1);
      if (!serverSet.has(srv) || !_histScope.has(key) || !_inScope(bound, srv, nick, null)) continue;
      for (const [day, v] of h.days) {
        if (day < cutoff) continue;
        const acc = perDay.get(day) || { ok: 0, n: 0, checks: 0 };
        acc.ok += v.ok; acc.n += v.n; acc.checks += v.checks;
        perDay.set(day, acc);
        sumOk += v.ok; sumN += v.n;
      }
    }
    const uptime60d = sumN > 0 ? Math.round(sumOk / sumN * 100 * 1000) / 1000 : null;
    const dailyRows = [...perDay.entries()]
      .filter(([, v]) => v.n > 0)
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([day, v]) => ({ day, uptime: v.ok / v.n * 100, checks: v.checks }));

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
    _maybeRefresh();
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

  r._refreshHistory = refreshHistory;   // тесты: дождаться прогрева кэша
  return r;
};
