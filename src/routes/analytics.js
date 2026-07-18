'use strict';
//
// src/routes/analytics.js — read-only analytics endpoints.
//
// WP6.1: modem_health*/capacity/latency/logs_domains_full carved out to
// analytics-health.js / analytics-capacity.js / analytics-latency.js /
// analytics-domains.js. ALL SQL lives in src/db/analytics.js — routes here
// only shape parameters and responses.

const express = require('express');
const analyticsDb = require('../db/analytics');
const { tzModifier } = require('../utils/time');  // P2-3: shared "+N hours" builder

module.exports = function createAnalyticsRouter(deps) {
  const {
    db, logger, authMiddleware, adminMiddleware,
    getMoscowToday, getMoscowNow,
    clients,
    dailyTraffic,
    apiServers,
    SERVER_COUNTRIES,
    portKeyToPortName,
    getStaleNicks, getStaleKeys,
    getTzOffset,
  } = deps;
  const r = express.Router();
  // Stage 4 finish: heatmap response cache is local to the router. Period →
  // {data, ts}; TTL keeps the dashboard cheap to refresh.
  const _heatmapCache = new Map();
  const HEATMAP_TTL_MS = 5 * 60 * 1000;

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
    const cacheKey = `${view}|${id}|${days}`;
    const cached = _heatmapCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < HEATMAP_TTL_MS) {
      return res.json(cached.data);
    }
    const idKey = id.toLowerCase().replace(/[\s.]+/g, '_');
    // Date list in Moscow time (dynamic offset via getTzOffset)
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
        if (row.corrected) correctedCells[di][row.hour] = true;
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
      matrix
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
      const pnCandidate = portKeyToPortName[row.port_name] || row.port_name;
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
