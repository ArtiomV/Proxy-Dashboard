'use strict';
//
// src/routes/analytics.js — read-only analytics endpoints.
//
// WP6.1: capacity/logs_domains_full carved out to dedicated routers.
// ALL SQL lives in src/db/analytics.js — routes here only shape responses.
// only shape parameters and responses.

const express = require('express');
const analyticsDb = require('../db/analytics');
const { tzModifier } = require('../utils/time');  // P2-3: shared "+N hours" builder
const { parseBwToBytes } = require('../utils/traffic');

// 2026-09-27: pure-часть «живой ячейки» текущего часа — частичный трафик
// незавершённого часа из bw-счётчиков минус СОБСТВЕННЫЙ baseline (таблица
// live_hour_baseline, миграция 106). Раньше baseline брался из
// hourly_snapshots.day_at_last_hour_start — он управляется часовой
// агрегацией и бывает 0/протухшим (RO1 27.09: +226 ГБ фантома за час).
// Теперь: первое наблюдение порта в МСК-часе = точка отсчёта этого часа.
function computeLiveCells(results, hourKey, baseGet, baseUpsert, pnMap, opMap, normalizeOp) {
  const out = [];
  for (const data of results || []) {
    const srv = data.serverName || '';
    if (data._cached || typeof data.bw !== 'object' || !data.bw) continue;   // протухший фид превью не доказывает
    // portId → {nick, operator, portName} по живому фиду (first wins при
    // клоне IMEI — как в traffic/hourly.js, DEEP-33).
    const statusArr = Array.isArray(data.status) ? data.status : [];
    const portsMap = data.ports || {};
    const portIdInfo = {};
    for (const m of statusArr) {
      const md = m.modem_details || {};
      const imei = md.IMEI || '';
      const nick = md.NICK || imei;
      const liveOp = String((m.net_details || {}).CELLOP || md.OPERATOR || '').trim();
      if (!imei) continue;
      for (const p of (portsMap[imei] || [])) {
        if (!portIdInfo[p.portID]) portIdInfo[p.portID] = { nick, operator: liveOp, portName: p.portName || '' };
      }
    }
    for (const [portId, b] of Object.entries(data.bw)) {
      const fullId = srv + '_' + portId;
      const cur = parseBwToBytes(b.bandwidth_bytes_day_in) + parseBwToBytes(b.bandwidth_bytes_day_out);
      let base;
      try {
        const row = baseGet.get(fullId);
        if (!row || row.hour_key !== hourKey) {
          // Первое наблюдение порта в этом часе — это и есть точка отсчёта.
          // Дельта 0 в этом наблюдении; недооценка ограничена началом часа.
          base = cur;
          if (baseUpsert) { try { baseUpsert.run(fullId, hourKey, cur); } catch (_) {} }
        } else {
          base = Number(row.bytes) || 0;
        }
      } catch (_) { continue; }   // таблицы нет на старой схеме — превью пропускаем
      const bytes = cur - base;
      if (!(bytes > 0)) continue;   // 0 и отрицательное (сброс счётчика внутри часа) — не превью
      const info = portIdInfo[portId] || {};
      const meta = opMap[fullId] || {};
      const client = String(info.portName || pnMap[fullId] || meta.client_name || '').trim();
      if (!client) continue;   // UNBOUND_FILTER: свободные порты в хитмап не входят
      const rawOp = (info.operator && info.operator.toLowerCase() !== 'unknown') ? info.operator : (meta.operator || '');
      const operator = typeof normalizeOp === 'function' ? normalizeOp(rawOp, srv) : rawOp;
      out.push({ server: srv, client, operator: operator || '', bytes });
    }
  }
  return out;
}

module.exports = function createAnalyticsRouter(deps) {
  const {
    db, logger, authMiddleware, adminMiddleware,
    fetchAllServersDataCached, parseBwToBytes,
    getMoscowToday, getMoscowNow,
    clients, clientByLogin,
    dailyTraffic,
    apiServers,
    SERVER_COUNTRIES,
    portKeyToPortName,
    getStaleNicks, getStaleKeys,
    getTzOffset,
    normalizeOperator,
  } = deps;
  const r = express.Router();
  // Stage 4 finish: heatmap response cache is local to the router. Period →
  // {data, ts}; TTL keeps the dashboard cheap to refresh.
  const _heatmapCache = new Map();
  const HEATMAP_TTL_MS = 5 * 60 * 1000;

  // ── 2026-09-27: живая ячейка текущего часа ───────────────────────────
  // traffic_hourly пишется ПО завершении часа — целый час хитмап показывал
  // ноль, и владельцу было «непонятно, что происходит». Здесь считается
  // частичный трафик ТЕКУЩЕГО (незавершённого) часа: живые bw-счётчики боксов
  // минус baseline последнего часового снапшота (hourly_snapshots.
  // day_at_last_hour_start_*). В 5-минутный SQL-кэш не входит — мержается
  // в ответ на каждый запрос (fetchAllServersDataCached сам кэширован).
  let _liveSnapStmt = null;
  let _liveOpMapCache = { ts: 0, map: {} };
  async function _liveHour(view, id, idKey, mskNow) {
    if (typeof fetchAllServersDataCached !== 'function' || typeof parseBwToBytes !== 'function') return null;
    try {
      if (!_liveSnapStmt) {
        _liveSnapStmt = {
          get: db.prepare('SELECT hour_key, bytes FROM live_hour_baseline WHERE port_id = ?'),
          upsert: db.prepare(`INSERT INTO live_hour_baseline (port_id, hour_key, bytes) VALUES (?, ?, ?)
            ON CONFLICT(port_id) DO UPDATE SET hour_key = excluded.hour_key, bytes = excluded.bytes`),
        };
      }
      if (Date.now() - _liveOpMapCache.ts > 5 * 60e3) {
        const map = {};
        try {
          // 2026-09-27: fallback-оператор живой ячейки. Пустые/'unknown'
          // строки отфильтрованы — иначе GROUP BY port_id мог отдать строку
          // БЕЗ оператора поверх известного. MAX(hour_start) + bare columns:
          // SQLite берёт operator/client_name из самой свежей строки порта.
          for (const row of db.prepare("SELECT port_id, operator, client_name, MAX(hour_start) AS h FROM traffic_hourly WHERE hour_start >= datetime('now','-7 days') AND operator IS NOT NULL AND TRIM(operator) != '' AND LOWER(TRIM(operator)) != 'unknown' GROUP BY port_id").all()) {
            map[row.port_id] = row;
          }
        } catch (_) {}
        _liveOpMapCache = { ts: Date.now(), map };
      }
      const hourKey = mskNow.toISOString().slice(0, 10) + ' ' + String(mskNow.getUTCHours()).padStart(2, '0');
      const cells = computeLiveCells(await fetchAllServersDataCached(), hourKey, _liveSnapStmt.get, _liveSnapStmt.upsert, portKeyToPortName || {}, _liveOpMapCache.map,
        (rawOp, srv) => { try { return normalizeOperator(rawOp, ((SERVER_COUNTRIES[srv] || {}).country || '') === 'RO') || rawOp; } catch (_) { return rawOp; } });
      const countryServers = view === 'country' && idKey !== 'all' ? _serversForCountry(idKey) : null;
      let gb = 0;
      const ops = {};
      for (const c of cells) {
        if (view === 'client' && c.client !== id) continue;
        if (countryServers && !countryServers.includes(c.server)) continue;
        if (view === 'operator') {
          const opKey = String(c.operator || '').toLowerCase().replace(/[\s.]+/g, '_');
          if (!opKey.includes(idKey)) continue;
        }
        gb += c.bytes;
        const op = c.operator || 'Неизвестный';
        if (!ops[op]) ops[op] = { gb: 0, ports: 0 };
        ops[op].gb += c.bytes;
        ops[op].ports++;
      }
      return {
        day: mskNow.toISOString().slice(0, 10),
        hour: mskNow.getUTCHours(),
        gb: gb / 1e9,
        by_operator: Object.fromEntries(Object.entries(ops).map(([k, v]) => [k, { gb: v.gb / 1e9, ports: v.ports }])),
        ts: Date.now(),
      };
    } catch (e) {
      logger.warn('[heatmap] live hour degraded: ' + e.message);
      return null;
    }
  }

  function _serversForCountry(idKey) {
    const serverCountryMap = {};
    for (const s of apiServers) {
      const cn = ((SERVER_COUNTRIES[s.name] || {}).name || '').toLowerCase();
      if (cn) serverCountryMap[s.name] = cn;
    }
    const servers = [];
    for (const [srv, cn] of Object.entries(serverCountryMap)) {
      if (cn.includes(idKey) || idKey.includes(cn)) servers.push(srv);
    }
    return servers;
  }

r.get('/api/analytics/monthly_traffic', authMiddleware, adminMiddleware, (req, res) => {
  const months = Math.min(parseInt(req.query.months) || 6, 12);
  const now = new Date();
  const startDate = new Date(now.getFullYear(), now.getMonth() - (months - 1), 1)
    .toISOString().slice(0, 10);
  try {
    const rows = analyticsDb.monthlyTraffic(startDate);
    const byMonth = {};
    for (const row of rows) byMonth[row.month] = row.total_bytes || 0;
    // Add today's bytes from in-memory store (saved nightly, so today may be partial)
    const todayStr = now.toISOString().slice(0, 10);
    const curMonth = todayStr.slice(0, 7);
    for (const days of Object.values(dailyTraffic)) {
      const t = days[todayStr];
      if (t) byMonth[curMonth] = (byMonth[curMonth] || 0) + (t.in || 0) + (t.out || 0);
    }
    const MONTHS_RU = ['Янв','Фев','Мар','Апр','Май','Июн','Июл','Авг','Сен','Окт','Ноя','Дек'];
    const result = [];
    for (let i = months - 1; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const mStr = d.toISOString().slice(0, 7);
      const totalGb = Math.round((byMonth[mStr] || 0) / 1e9 * 10) / 10;
      const entry = { month: mStr, label: MONTHS_RU[d.getMonth()], total_gb: totalGb };
      if (i === 0) {
        entry.is_current = true;
        const dom = now.getDate();
        const dim = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
        // Forecast: extrapolate from completed days (dom-1, since today is incomplete)
        const completedDays = Math.max(dom - 1, 1);
        if (completedDays >= 2 && totalGb > 0) {
          entry.forecast_gb = Math.round(totalGb / completedDays * dim * 10) / 10;
        } else {
          // Use previous month total as initial plan
          const prevMStr = new Date(now.getFullYear(), now.getMonth() - 1, 1).toISOString().slice(0, 7);
          const prevGb = Math.round((byMonth[prevMStr] || 0) / 1e9 * 10) / 10;
          if (prevGb > 0) entry.forecast_gb = prevGb;
        }
        // Include today's live bytes for current month when nothing recorded yet
        if (totalGb === 0) {
          let todayTotal = 0;
          for (const days of Object.values(dailyTraffic)) {
            const t = days[todayStr];
            if (t) todayTotal += (t.in || 0) + (t.out || 0);
          }
          if (todayTotal > 0) entry.total_gb = Math.round(todayTotal / 1e9 * 10) / 10;
        }
      }
      result.push(entry);
    }
    res.json(result);
  } catch (e) {
    logger.error('[monthly_traffic]', e.message);
    res.status(500).json({ error: e.message });
  }
});

r.get('/api/analytics/heatmap', authMiddleware, adminMiddleware, async (req, res) => {
  const { view = 'country', id = 'all' } = req.query;
  const days = Math.min(Math.max(parseInt(req.query.days) || 7, 1), 30);
  try {
    const idKey = id.toLowerCase().replace(/[\s.]+/g, '_');
    const mskOffset = getTzOffset('Europe/Moscow');
    const mskNow = new Date(Date.now() + mskOffset * 3600 * 1000);
    const liveHour = await _liveHour(view, id, idKey, mskNow);   // живая ячейка — вне SQL-кэша
    const cacheKey = `${view}|${id}|${days}`;
    const cached = _heatmapCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < HEATMAP_TTL_MS) {
      return res.json({ ...cached.data, live_hour: liveHour });
    }
    // Date list in Moscow time (dynamic offset via getTzOffset)
    const dateList = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(Date.UTC(mskNow.getUTCFullYear(), mskNow.getUTCMonth(), mskNow.getUTCDate() - i));
      dateList.push(d.toISOString().slice(0, 10));
    }
    const startDate = dateList[0];
    const utcFetchStartShifted = new Date(new Date(startDate + 'T00:00:00Z').getTime() - mskOffset * 3600 * 1000).toISOString().slice(0, 16).replace('T', ' ');
    const matrix = dateList.map(() => new Array(24).fill(0));
    const tzStr = tzModifier(mskOffset);

    const { sql, params } = analyticsDb.heatmapSql({
      tzStr, start: utcFetchStartShifted, view, idKey, id,
      servers: view === 'country' && idKey !== 'all' ? _serversForCountry(idKey) : [],
    });
    const rows = db.prepare(sql).all(...params);
    let hasData = false;
    const correctedCells = dateList.map(() => new Array(24).fill(false));
    const dateIdx = new Map(dateList.map((d, i) => [d, i]));
    for (const row of rows) {
      const di = dateIdx.get(row.day);
      if (di !== undefined && row.hour >= 0 && row.hour < 24) {
        matrix[di][row.hour] = row.bytes / 1e9;
        // 2026-10-03: полосы только при >5% скорректированных байтов ячейки
        if (row.corrected && row.bytes > 0 && (row.corrected_bytes || 0) / row.bytes > 0.05) correctedCells[di][row.hour] = true;
        hasData = true;
      }
    }

    // Per-operator breakdown for country and client views
    let operator_breakdown;
    if (view === 'country' || view === 'client') {
      operator_breakdown = dateList.map(() => Array.from({ length: 24 }, () => ({})));
      const { sql: opSql, params: opParams } = analyticsDb.heatmapOperatorSql({
        tzStr, start: utcFetchStartShifted, view, id,
        servers: view === 'country' && idKey !== 'all' ? _serversForCountry(idKey) : [],
      });
      const opRows = db.prepare(opSql).all(...opParams);
      for (const row of opRows) {
        const di = dateIdx.get(row.day);
        if (di !== undefined && row.hour >= 0 && row.hour < 24 && row.op) {
          operator_breakdown[di][row.hour][row.op] = { gb: row.bytes / 1e9, modems: row.modems };
        }
      }
    }

    const DAYS_RU = ['Вс','Пн','Вт','Ср','Чт','Пт','Сб'];
    const dayMeta = dateList.map(date => {
      const d = new Date(date + 'T00:00:00');
      return { date, label: DAYS_RU[d.getDay()], dateShort: date.slice(5) };
    });
    const resp = {
      meta: { id, days: dateList, day_meta: dayMeta, has_hourly: hasData, corrected: correctedCells },
      matrix,
      live_hour: liveHour,
    };
    if (operator_breakdown) resp.operator_breakdown = operator_breakdown;
    _heatmapCache.set(cacheKey, { ts: Date.now(), data: resp });
    if (_heatmapCache.size > 200) {
      const oldestKey = _heatmapCache.keys().next().value;
      _heatmapCache.delete(oldestKey);
    }
    res.json(resp);
  } catch (e) {
    logger.error('[heatmap]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Портал клиента: почасовой хитмап трафика самого клиента (как admin heatmap
// view='client', но идентичность берём из сессии — чужой id передать нельзя).
r.get('/api/client/hourly_traffic', authMiddleware, async (req, res) => {
  const clientInfo = clientByLogin.get(req.user.login);
  const portName = (clientInfo && clientInfo.portName) || req.user.portNameFilter;
  if (!portName || portName === '*') return res.status(400).json({ error: 'No portName bound to account' });
  const days = Math.min(Math.max(parseInt(req.query.days) || 7, 1), 30);
  try {
    const cacheKey = `portal|${portName}|${days}`;
    const cached = _heatmapCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < HEATMAP_TTL_MS) {
      return res.json(cached.data);
    }
    const now2 = new Date();
    const mskOffset = getTzOffset('Europe/Moscow');
    const mskNow = new Date(now2.getTime() + mskOffset * 3600 * 1000);
    const dateList = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(Date.UTC(mskNow.getUTCFullYear(), mskNow.getUTCMonth(), mskNow.getUTCDate() - i));
      dateList.push(d.toISOString().slice(0, 10));
    }
    const startDate = dateList[0];
    const utcFetchStartShifted = new Date(new Date(startDate + 'T00:00:00Z').getTime() - mskOffset * 3600 * 1000).toISOString().slice(0, 16).replace('T', ' ');
    const matrix = dateList.map(() => new Array(24).fill(0));
    const tzStr = tzModifier(mskOffset);

    const { sql, params } = analyticsDb.heatmapSql({
      tzStr, start: utcFetchStartShifted, view: 'client', idKey: portName, id: portName, servers: [],
    });
    const rows = db.prepare(sql).all(...params);
    let hasData = false;
    const correctedCells = dateList.map(() => new Array(24).fill(false));
    const dateIdx = new Map(dateList.map((d, i) => [d, i]));
    for (const row of rows) {
      const di = dateIdx.get(row.day);
      if (di !== undefined && row.hour >= 0 && row.hour < 24) {
        matrix[di][row.hour] = row.bytes / 1e9;
        // 2026-10-03: полосы только при >5% скорректированных байтов ячейки
        if (row.corrected && row.bytes > 0 && (row.corrected_bytes || 0) / row.bytes > 0.05) correctedCells[di][row.hour] = true;
        hasData = true;
      }
    }

    const DAYS_RU = ['Вс','Пн','Вт','Ср','Чт','Пт','Сб'];
    const dayMeta = dateList.map(date => {
      const d = new Date(date + 'T00:00:00');
      return { date, label: DAYS_RU[d.getDay()], dateShort: date.slice(5) };
    });
    const resp = { meta: { id: portName, days: dateList, day_meta: dayMeta, has_hourly: hasData, corrected: correctedCells }, matrix };
    _heatmapCache.set(cacheKey, { ts: Date.now(), data: resp });
    res.json(resp);
  } catch (e) {
    logger.error('[client/hourly_traffic]', e.message);
    res.status(500).json({ error: e.message });
  }
});

r.get('/api/analytics/modem_heatmap', authMiddleware, adminMiddleware, async (req, res) => {
  const { nick, serverName } = req.query;
  if (!nick || !serverName) return res.status(400).json({ error: 'nick and serverName required' });
  const days = Math.min(Math.max(parseInt(req.query.days) || 7, 1), 30);
  try {
    const mhCacheKey = `modem|${serverName}|${nick}|${days}`;
    const mhCached = _heatmapCache.get(mhCacheKey);
    if (mhCached && Date.now() - mhCached.ts < HEATMAP_TTL_MS) {
      return res.json(mhCached.data);
    }
    const now2 = new Date();
    const mskOffset2 = getTzOffset('Europe/Moscow');
    const mskNow = new Date(now2.getTime() + mskOffset2 * 3600 * 1000);
    const dateList = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(Date.UTC(mskNow.getUTCFullYear(), mskNow.getUTCMonth(), mskNow.getUTCDate() - i));
      dateList.push(d.toISOString().slice(0, 10));
    }
    const startDate = dateList[0];
    const utcStart = new Date(new Date(startDate + 'T00:00:00Z').getTime() - mskOffset2 * 3600 * 1000).toISOString().slice(0, 16).replace('T', ' ');

    // Per-CLIENT heatmap: a modem can serve several clients on separate ports.
    const result = {};
    const dateIdx2 = new Map(dateList.map((d, i) => [d, i]));
    const tzStr2 = tzModifier(mskOffset2);
    const rows = analyticsDb.modemHeatmap(tzStr2, nick, serverName, utcStart);
    const byClient = {};
    for (const row of rows) {
      const label = row.cn || nick;
      if (!byClient[label]) byClient[label] = dateList.map(() => new Array(24).fill(0));
      const di = dateIdx2.get(row.day);
      if (di !== undefined && row.hour >= 0 && row.hour < 24) byClient[label][di][row.hour] = row.bytes / 1e9;
    }
    for (const label of Object.keys(byClient)) {
      result[label] = { portId: nick, clientName: label, matrix: byClient[label] };
    }

    const DAYS_RU = ['Вс','Пн','Вт','Ср','Чт','Пт','Сб'];
    const dayMeta = dateList.map(date => {
      const d = new Date(date + 'T00:00:00');
      return { date, label: DAYS_RU[d.getDay()] };
    });
    const mhResp = { nick, serverName, days: dateList, day_meta: dayMeta, ports: result };
    _heatmapCache.set(mhCacheKey, { ts: Date.now(), data: mhResp });
    res.json(mhResp);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

r.get('/api/analytics/rotations', authMiddleware, adminMiddleware, (req, res) => {
  try {
    const days = Math.min(Math.max(parseInt(req.query.days) || 7, 1), 30);
    const sinceExpr = `datetime('now', '-${days} days')`;

    // Stage 18.8: exclude rotations of stale modems (offline > stale_modem_hours).
    const staleNicks = (typeof getStaleNicks === 'function') ? getStaleNicks() : new Set();
    const { clause: staleFilter, params: staleArgs } = analyticsDb.notInClause('nick', staleNicks);

    const totals = analyticsDb.rotationsTotals(sinceExpr, staleArgs, staleFilter);
    const perDay = analyticsDb.rotationsPerDay(sinceExpr, staleArgs, staleFilter);
    const perModem = analyticsDb.rotationsPerModem(sinceExpr, staleArgs, staleFilter.replace(/\bnick\b/g, 'r.nick'));
    const perOperator = analyticsDb.rotationsPerOperator(sinceExpr, staleArgs, staleFilter.replace(/\bnick\b/g, 'r.nick'));
    const perServer = analyticsDb.rotationsPerServer(sinceExpr, staleArgs, staleFilter);
    const recentFailed = analyticsDb.rotationsRecentFailed(sinceExpr, staleArgs, staleFilter);

    const success = totals.total > 0 ? ((totals.total - totals.failed) / totals.total) * 100 : 0;
    res.json({
      days,
      summary: {
        total: totals.total || 0,
        failed: totals.failed || 0,
        success_pct: Math.round(success * 10) / 10,
        avg_sec: totals.avg_sec != null ? Math.round(totals.avg_sec * 10) / 10 : null,
        max_sec: totals.max_sec != null ? Math.round(totals.max_sec * 10) / 10 : null,
        min_sec: totals.min_sec != null ? Math.round(totals.min_sec * 10) / 10 : null,
      },
      per_day: perDay,
      per_server: perServer,
      per_modem: perModem,
      per_operator: perOperator,
      recent_failed: recentFailed
    });
  } catch (e) {
    logger.error('[rotations]', e.message);
    res.status(500).json({ error: e.message });
  }
});

r.get('/api/analytics/ip_stats', authMiddleware, adminMiddleware, (req, res) => {
  try {
    const days = Math.min(Math.max(parseInt(req.query.days) || 30, 1), 90);
    const sinceExpr = `datetime('now', '-${days} days')`;

    // Stage 18.8: exclude IP history for stale modems. ip_history uses
    // key='S1_<imei>', so we use getStaleKeys() which keeps that format.
    const staleKeys = (typeof getStaleKeys === 'function') ? getStaleKeys() : new Set();
    const { clause: staleFilter, params: staleArgs } = analyticsDb.notInClause('key', staleKeys);

    const uniqueIps = analyticsDb.ipUnique(sinceExpr, staleArgs, staleFilter).c;
    const totalAssignments = analyticsDb.ipAssignments(sinceExpr, staleArgs, staleFilter).c;
    const reused = analyticsDb.ipReused(sinceExpr, staleArgs, staleFilter);
    const lifetimeAll = analyticsDb.ipLifetime(sinceExpr, staleArgs, staleFilter).avg_sec;
    const poolsRows = analyticsDb.ipPools(sinceExpr, staleArgs, staleFilter);
    const operatorRows = analyticsDb.ipOperatorRows(
      sinceExpr,
      staleArgs,
      staleFilter.replace(/\bkey\b/g, 'h.key')
    );

    // Aliases such as "MOLDCELL" and "Moldcell" are collapsed through the
    // same normalizer used by the rest of the dashboard. Sets preserve truly
    // unique IPs even when two raw operator names map to one canonical name.
    const operatorGroups = new Map();
    for (const row of operatorRows) {
      const isRO = ((SERVER_COUNTRIES[row.server] || {}).country || '') === 'RO';
      const operator = (typeof normalizeOperator === 'function'
        ? normalizeOperator(row.operator, isRO)
        : row.operator) || 'Неизвестный';
      if (!operatorGroups.has(operator)) {
        operatorGroups.set(operator, { ips: new Set(), modems: new Set() });
      }
      const group = operatorGroups.get(operator);
      if (row.ip) group.ips.add(row.ip);
      if (row.key) group.modems.add(row.key);
    }
    const operators = Array.from(operatorGroups, ([operator, group]) => ({
      operator,
      ip_count: group.ips.size,
      modems: group.modems.size,
    })).sort((a, b) => b.ip_count - a.ip_count || a.operator.localeCompare(b.operator, 'ru'));

    // Per-modem /24 subnet diversity
    const subRows = analyticsDb.ipSubnets(sinceExpr, staleArgs, staleFilter);
    const _nickByKey = {};
    try {
      for (const m of analyticsDb.modemNickByKey()) {
        _nickByKey[m.server_name + '_' + m.imei] = m.nick;
      }
    } catch (_) { /* modem_meta optional */ }
    const subnets = subRows.map(row => {
      const us = row.key.indexOf('_');
      return {
        server: us > 0 ? row.key.slice(0, us) : '',
        nick: _nickByKey[row.key] || (us > 0 ? row.key.slice(us + 1) : row.key),
        subnets: row.subnets,
        ips: row.ips
      };
    });
    const subnetSummary = {
      modems: subnets.length,
      avg: subnets.length ? Math.round(subnets.reduce((a, x) => a + x.subnets, 0) / subnets.length * 10) / 10 : 0,
      max: subnets.length ? subnets[0].subnets : 0
    };

    res.json({
      days,
      summary: {
        unique_ips: uniqueIps,
        total_assignments: totalAssignments,
        reuse_ratio: uniqueIps > 0 ? Math.round(totalAssignments / uniqueIps * 100) / 100 : 0,
        avg_lifetime_sec: lifetimeAll != null ? Math.round(lifetimeAll) : null,
        reused_count: reused.length
      },
      reused,
      pools: poolsRows,
      operators,
      subnets: subnets.slice(0, 50),
      subnet_summary: subnetSummary
    });
  } catch (e) {
    logger.error('[ip_stats]', e.message);
    res.status(500).json({ error: e.message });
  }
});

r.get('/api/analytics/traffic_forecast', authMiddleware, adminMiddleware, (req, res) => {
  try {
    const days = Math.min(Math.max(parseInt(req.query.days) || 30, 7), 60);
    const mskToday = getMoscowToday();
    const mskNow = getMoscowNow();
    const daysInMonth = new Date(mskNow.getFullYear(), mskNow.getMonth() + 1, 0).getDate();
    const dayOfMonth = mskNow.getDate();
    const daysLeftInMonth = daysInMonth - dayOfMonth;

    // Per-client per-day gb totals from daily_traffic
    const rows = analyticsDb.forecastDailyTraffic(-days);

    // Build client → port_names
    const portToClient = {};
    for (const c of clients) if (c.portName) portToClient[c.portName] = c;

    // Per-client aggregation (port_name in daily_traffic is the full port_id
    // like "S1_portXXX" — matched via the live portKey mapping).
    const perClient = {};
    for (const row of rows) {
      // 2026-09-17: client_name в daily_traffic — устойчивая атрибуция,
      // живая карта портов ломается при удалении портов клиента.
      const pnCandidate = row.client_name || portKeyToPortName[row.port_name] || row.port_name;
      const client = portToClient[pnCandidate];
      if (!client) continue;
      if (!perClient[client.id]) perClient[client.id] = { id: client.id, name: client.name, portName: client.portName, price: client.price || 0, currency: client.currency || 'RUB', balance: client.balance || 0, billingType: client.billingType || 'per_gb', days: {} };
      if (!perClient[client.id].days[row.date]) perClient[client.id].days[row.date] = 0;
      perClient[client.id].days[row.date] += row.bytes || 0;
    }

    const forecasts = Object.values(perClient).map(c => {
      const arr = Object.entries(c.days).sort((a, b) => a[0].localeCompare(b[0]));
      const xs = arr.map((_, i) => i);
      const ys = arr.map(a => a[1] / 1e9); // GB
      const n = xs.length;
      let slope = 0, mean = 0;
      if (n >= 2) {
        const sumX = xs.reduce((s, v) => s + v, 0);
        const sumY = ys.reduce((s, v) => s + v, 0);
        const sumXY = xs.reduce((s, v, i) => s + v * ys[i], 0);
        const sumX2 = xs.reduce((s, v) => s + v * v, 0);
        const meanX = sumX / n, meanY = sumY / n;
        const denom = sumX2 - n * meanX * meanX;
        slope = denom !== 0 ? (sumXY - n * meanX * meanY) / denom : 0;
        mean = meanY;
      } else if (n === 1) {
        mean = ys[0];
      }

      const avgDailyGb = mean;
      const thisMonthRows = arr.filter(a => a[0].startsWith(mskToday.slice(0, 7)));
      const monthGbSoFar = thisMonthRows.reduce((s, a) => s + a[1] / 1e9, 0);
      const forecastMonthGb = monthGbSoFar + avgDailyGb * daysLeftInMonth;

      // Runway: how many days current balance lasts at current rate
      let runwayDays = null;
      if (c.billingType === 'per_gb' && c.price > 0 && avgDailyGb > 0) {
        runwayDays = Math.max(0, Math.floor(c.balance / (avgDailyGb * c.price)));
      } else if (c.billingType === 'per_modem' && c.price > 0) {
        runwayDays = Math.floor(c.balance / (c.price / daysInMonth));
      }

      return {
        client_id: c.id,
        client_name: c.name,
        avg_daily_gb: Math.round(avgDailyGb * 100) / 100,
        trend_gb_per_day: Math.round(slope * 100) / 100,
        month_gb_so_far: Math.round(monthGbSoFar * 10) / 10,
        forecast_month_gb: Math.round(forecastMonthGb * 10) / 10,
        balance: c.balance,
        currency: c.currency,
        runway_days: runwayDays,
        low_balance_alert: runwayDays !== null && runwayDays <= 7
      };
    }).sort((a, b) => (a.runway_days || 9999) - (b.runway_days || 9999));

    res.json({
      days,
      mskToday,
      days_left_in_month: daysLeftInMonth,
      forecasts
    });
  } catch (e) {
    logger.error('[traffic_forecast]', e.message);
    res.status(500).json({ error: e.message });
  }
});

  return r;
};

// Exported for tests (2026-09-27): pure-часть живой ячейки часа.
module.exports.computeLiveCells = computeLiveCells;
