'use strict';
//
// src/routes/billing-ext.js — billing analytics / monthly costs (Stage 3 finish).
//
// 4 admin-only routes that round out the billing surface. Late-mounted
// in server.js, getter pattern for forward-referenced helpers.

const express = require('express');
const { COST_CATEGORIES } = require('../billing/cost-categories');  // P2-2: was a server.js dep

module.exports = function createBillingExtRouter(deps) {
  const {
    db, logger, authMiddleware, adminMiddleware,
    getClients, clientById,
    getFetchAllServersDataCached, getMergeServerData,
    getPortKeyToPortName, getDailyTraffic, ledgerDb,
    getMoscowToday, trafficBytesToGb, parseBwToBytes, ledgerExpense,
    getClientStoredMonthBytes,
    refreshPortKeyMapping,
    getApiServers, getServerCountries,
    normalizeOperator,
    appSettings,
    auditLog, logActivity,
  } = deps;
  const r = express.Router();

  // Stage 4 finish: finance_dashboard response cache moved into the router.
  // server.js no longer needs to own this — only billing-ext.js reads/writes.
  // Cache key is the period (YYYY-MM); TTL keeps the dashboard cheap to refresh.
  let _financeCache = null;
  let _financeCacheTs = 0;
  let _financeCacheKey = '';
  const FINANCE_CACHE_TTL_MS = 60 * 1000;

r.get('/api/admin/monthly_costs', authMiddleware, adminMiddleware, (req, res) => {
  try {
    const period = String(req.query.period || '').match(/^\d{4}-\d{2}$/) ? req.query.period
                 : new Date().toISOString().slice(0, 7);
    const rows = db.prepare(`SELECT id, period, category, subkey, amount, notes, updated_at
      FROM monthly_costs WHERE period = ? ORDER BY category, subkey`).all(period);
    // Если за период пусто — auto-fill из предыдущего месяца (как шаблон, без сохранения)
    let template = null;
    if (rows.length === 0) {
      const prev = db.prepare("SELECT MAX(period) as p FROM monthly_costs WHERE period < ?").get(period).p;
      if (prev) {
        template = db.prepare(`SELECT category, subkey, amount, notes
          FROM monthly_costs WHERE period = ?`).all(prev);
      }
    }
    // Список операторов (для SIM): из live ProxySmart
    const operators = db.prepare(`SELECT DISTINCT operator FROM modem_meta
      WHERE operator != '' ORDER BY operator`).all().map(r => r.operator);
    const servers = getApiServers().map(s => s.name);
    res.json({
      period, rows, template,
      categories: COST_CATEGORIES,
      meta: { operators, servers }
    });
  } catch (e) {
    logger.error('[monthly_costs/get]', e.message);
    res.status(500).json({ error: e.message });
  }
});

r.post('/api/admin/monthly_costs', authMiddleware, adminMiddleware, (req, res) => {
  try {
    const period = String(req.body?.period || '');
    if (!/^\d{4}-\d{2}$/.test(period)) return res.status(400).json({ error: 'period YYYY-MM required' });
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    db.transaction(() => {
      db.prepare('DELETE FROM monthly_costs WHERE period = ?').run(period);
      const ins = db.prepare(`INSERT INTO monthly_costs (period, category, subkey, amount, notes)
        VALUES (?, ?, ?, ?, ?)`);
      for (const it of items) {
        if (!it || !it.category) continue;
        const amount = Number(it.amount);
        if (!Number.isFinite(amount) || amount < 0) continue;
        if (!COST_CATEGORIES[it.category]) continue;
        ins.run(period, it.category, it.subkey || null, amount, (it.notes || '').slice(0, 500));
      }
    })();
    auditLog(req.user.login, 'monthly_costs_save', { period, count: items.length });
    _financeCacheKey = '';   // сброс кэша finance_dashboard — иначе Обзор до 60с показывает старые затраты
    res.json({ ok: true, period, saved: items.length });
  } catch (e) {
    logger.error('[monthly_costs/post]', e.message);
    res.status(500).json({ error: e.message });
  }
});

r.get('/api/admin/finance_dashboard', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const now = new Date();
    const todayStr = now.toISOString().slice(0, 10);
    const period = String(req.query.period || '').match(/^\d{4}-\d{2}$/) ? req.query.period
                 : todayStr.slice(0, 7);
    const cacheKey = period;
    if (_financeCache && _financeCacheKey === cacheKey && (Date.now() - _financeCacheTs) < FINANCE_CACHE_TTL_MS) {
      return res.json(_financeCache);
    }

    // Date helpers
    const isoDay = d => d.toISOString().slice(0, 10);
    const dayMs = 86400000;
    const since30 = isoDay(new Date(now.getTime() - 30 * dayMs));
    const since60 = isoDay(new Date(now.getTime() - 60 * dayMs));
    const since90 = isoDay(new Date(now.getTime() - 90 * dayMs));
    const since120 = isoDay(new Date(now.getTime() - 120 * dayMs));
    const since365 = isoDay(new Date(now.getTime() - 365 * dayMs));

    // -- per-client MRR (trailing 30d revenue) --
    const mrrRows = db.prepare(`SELECT client_id, SUM(amount) as mrr
      FROM billing_ledger WHERE type='charge' AND date >= ? GROUP BY client_id`).all(since30);
    const mrrByClient = Object.fromEntries(mrrRows.map(r => [r.client_id, Math.round(r.mrr * 100) / 100]));

    // -- per-client previous 30d (60..30 days ago) --
    const prevMrrRows = db.prepare(`SELECT client_id, SUM(amount) as mrr
      FROM billing_ledger WHERE type='charge' AND date >= ? AND date < ? GROUP BY client_id`).all(since60, since30);
    const prevMrrByClient = Object.fromEntries(prevMrrRows.map(r => [r.client_id, Math.round(r.mrr * 100) / 100]));

    // -- 3 months ago window (120..90 days ago) for NRR baseline --
    const baseRows = db.prepare(`SELECT client_id, SUM(amount) as rev
      FROM billing_ledger WHERE type='charge' AND date >= ? AND date < ? GROUP BY client_id`).all(since120, since90);
    const baseByClient = Object.fromEntries(baseRows.map(r => [r.client_id, Math.round(r.rev * 100) / 100]));

    // -- per-tariff split --
    const totalMrr = Object.values(mrrByClient).reduce((s, v) => s + v, 0);
    const prevTotalMrr = Object.values(prevMrrByClient).reduce((s, v) => s + v, 0);
    const mrrGrowthPct = prevTotalMrr > 0 ? Math.round(((totalMrr - prevTotalMrr) / prevTotalMrr) * 1000) / 10 : null;

    // Per-tariff revenue
    const perTariffRows = db.prepare(`SELECT
      COALESCE(json_extract(details, '$.billing_type'), 'per_gb') as bt,
      SUM(amount) as rev
      FROM billing_ledger WHERE type='charge' AND date >= ? GROUP BY bt`).all(since30);
    const perTariff = {};
    perTariffRows.forEach(r => { perTariff[r.bt || 'per_gb'] = Math.round(r.rev * 100) / 100; });

    // -- ARR --
    const arr = Math.round(totalMrr * 12);

    // -- Active / new / churned --
    const activeClients = getClients().filter(c => !c.billingPaused && (mrrByClient[c.id] || 0) > 0);
    const periodFirstDay = period + '-01';
    const newClients = getClients().filter(c => (c.createdAt || '').slice(0, 10) >= periodFirstDay
                                          && (c.createdAt || '').slice(0, 7) === period);
    // Churned: had revenue in [60..30d ago], no revenue in last 30d, and (paused OR balance < 0)
    const churnedClients = getClients().filter(c => {
      const had = (prevMrrByClient[c.id] || 0) > 0;
      const has = (mrrByClient[c.id] || 0) > 0;
      return had && !has;
    });

    // -- ARPU --
    const arpu = activeClients.length > 0 ? Math.round(totalMrr / activeClients.length) : 0;

    // -- Top-N concentration --
    const sortedByMrr = Object.entries(mrrByClient)
      .map(([cid, mrr]) => ({ cid, mrr, name: (clientById.get(cid) || {}).name || cid }))
      .sort((a, b) => b.mrr - a.mrr);
    const topN = (n) => sortedByMrr.slice(0, n).reduce((s, x) => s + x.mrr, 0);
    const top1 = sortedByMrr[0] || null;
    const concentration = totalMrr > 0 ? {
      top1_pct:  Math.round((topN(1) / totalMrr) * 1000) / 10,
      top1_name: top1 ? top1.name : '—',
      top3_pct:  Math.round((topN(3) / totalMrr) * 1000) / 10,
      top5_pct:  Math.round((topN(5) / totalMrr) * 1000) / 10
    } : { top1_pct: 0, top1_name: '—', top3_pct: 0, top5_pct: 0 };

    // -- NRR (3-month cohort) --
    // Cohort = clients that had revenue in [120..90d ago].
    // Their revenue then vs their revenue now (last 30d).
    const cohortIds = Object.keys(baseByClient);
    const cohortRevenueThen = cohortIds.reduce((s, id) => s + (baseByClient[id] || 0), 0);
    // Their CURRENT 30-day revenue (only the same cohort, including expansions)
    const cohortRevenueNow = cohortIds.reduce((s, id) => s + (mrrByClient[id] || 0), 0);
    // Normalize "then" to a 30-day window (the baseRows window is also 30 days, so direct ratio)
    const nrrPct = cohortRevenueThen > 0 ? Math.round((cohortRevenueNow / cohortRevenueThen) * 1000) / 10 : null;

    // -- Churn rate --
    const startOfPeriodActive = getClients().filter(c => (prevMrrByClient[c.id] || 0) > 0).length;
    const churnRatePct = startOfPeriodActive > 0
      ? Math.round((churnedClients.length / startOfPeriodActive) * 1000) / 10
      : 0;

    // -- Modem utilization (live data) --
    let liveResults = [];
    try { liveResults = await getFetchAllServersDataCached()(); } catch (_) { /* best-effort: error intentionally swallowed */ }
    let totalModems = 0, rentedModems = 0;
    const modemsByServer = {};
    const modemsByOperator = {};
    const modemsByPortName = {};
    for (const data of liveResults) {
      const srv = data.serverName;
      if (typeof data.bw !== 'object') continue;
      modemsByServer[srv] = modemsByServer[srv] || { total: 0, rented: 0 };
      const isRO = (getServerCountries()[srv] || {}).country === 'RO';
      const statusArr = Array.isArray(data.status) ? data.status : [];
      const opByImei = {};
      for (const m of statusArr) {
        const md = m.modem_details || {};
        if (md.IMEI) {
          const op = normalizeOperator(((m.net_details || {}).CELLOP || md.OPERATOR || ''), isRO);
          opByImei[md.IMEI] = op;
        }
      }
      const portsMap = data.ports || {};
      for (const [portId, b] of Object.entries(data.bw)) {
        totalModems++;
        modemsByServer[srv].total++;
        if (b.portName) {
          rentedModems++;
          modemsByServer[srv].rented++;
          modemsByPortName[b.portName] = modemsByPortName[b.portName] || { count: 0, server: srv };
          modemsByPortName[b.portName].count++;
        }
        // Operator from status
        // Find IMEI for this portId
        for (const imei in portsMap) {
          if (Array.isArray(portsMap[imei])) {
            for (const p of portsMap[imei]) {
              if (p.portID === portId) {
                const op = opByImei[imei];
                if (op) {
                  modemsByOperator[op] = modemsByOperator[op] || { total: 0, rented: 0 };
                  modemsByOperator[op].total++;
                  if (b.portName) modemsByOperator[op].rented++;
                }
                break;
              }
            }
          }
        }
      }
    }
    const utilPct = totalModems > 0 ? Math.round((rentedModems / totalModems) * 1000) / 10 : 0;

    // -- Costs (current period) --
    // Затраты фиксированные помесячные: если месяц ещё не заполнен, подтягиваем
    // последний заполненный как типовые (cost_carried_from сообщает фронту источник).
    let costRows = db.prepare(`SELECT category, subkey, amount FROM monthly_costs WHERE period = ?`).all(period);
    let costCarriedFrom = null;
    if (!costRows.length) {
      const prev = db.prepare(`SELECT MAX(period) AS p FROM monthly_costs WHERE period < ?`).get(period).p;
      if (prev) {
        costRows = db.prepare(`SELECT category, subkey, amount FROM monthly_costs WHERE period = ?`).all(prev);
        costCarriedFrom = prev;
      }
    }
    const totalCost = costRows.reduce((s, r) => s + (r.amount || 0), 0);
    const costByCategory = {};
    costRows.forEach(r => {
      costByCategory[r.category] = (costByCategory[r.category] || 0) + (r.amount || 0);
    });
    const costPerModem = totalModems > 0 ? Math.round((totalCost / totalModems) * 100) / 100 : 0;

    // -- RPM (revenue per rented modem) --
    const rpm = rentedModems > 0 ? Math.round((totalMrr / rentedModems) * 100) / 100 : 0;
    const marginPerModem = Math.round((rpm - costPerModem) * 100) / 100;

    // -- Revenue per server / per operator (revenue allocated by client portName→server) --
    const portKeyToClient = {};
    for (const c of getClients()) if (c.portName) portKeyToClient[c.portName] = c.id;
    const revBySrv = {}, revByOp = {};
    for (const data of liveResults) {
      const srv = data.serverName;
      if (typeof data.bw !== 'object') continue;
      const portClientCount = {};
      for (const b of Object.values(data.bw)) {
        if (b.portName) portClientCount[b.portName] = (portClientCount[b.portName] || 0) + 1;
      }
      // For each client on this server: their MRR proportional to number of modems on this server
      for (const [pn, modemCount] of Object.entries(portClientCount)) {
        const cid = portKeyToClient[pn];
        if (!cid) continue;
        const cMrr = mrrByClient[cid] || 0;
        const totalModemsOfClient = (modemsByPortName[pn] || {}).count || modemCount;
        const portion = totalModemsOfClient > 0 ? cMrr * (modemCount / totalModemsOfClient) : 0;
        revBySrv[srv] = (revBySrv[srv] || 0) + portion;
      }
    }
    // Per-server table
    const perServer = Object.keys(modemsByServer).sort().map(s => {
      const total = modemsByServer[s].total;
      const rented = modemsByServer[s].rented;
      const rev = Math.round(revBySrv[s] || 0);
      return {
        server: s,
        total, rented,
        utilization_pct: total > 0 ? Math.round((rented / total) * 1000) / 10 : 0,
        revenue: rev,
        revenue_per_modem: rented > 0 ? Math.round((rev / rented) * 100) / 100 : 0
      };
    });
    const perOperator = Object.keys(modemsByOperator).sort().map(op => ({
      operator: op,
      total:    modemsByOperator[op].total,
      rented:   modemsByOperator[op].rented,
      utilization_pct: modemsByOperator[op].total > 0
        ? Math.round((modemsByOperator[op].rented / modemsByOperator[op].total) * 1000) / 10 : 0
    }));

    // -- Per-client breakdown --
    const perClient = getClients()
      .map(c => {
        const cMrr  = mrrByClient[c.id]     || 0;
        const cPrev = prevMrrByClient[c.id] || 0;
        const delta = cPrev > 0 ? Math.round(((cMrr - cPrev) / cPrev) * 1000) / 10 : null;
        const sharePct = totalMrr > 0 ? Math.round((cMrr / totalMrr) * 1000) / 10 : 0;
        return {
          id: c.id,
          name: c.name,
          billingType: c.billingType || 'per_gb',
          price: c.price || 0,
          balance: c.balance || 0,
          mrr: cMrr,
          mrr_prev: cPrev,
          mrr_delta_pct: delta,
          share_pct: sharePct,
          paused: !!c.billingPaused
        };
      })
      .sort((a, b) => b.mrr - a.mrr);

    // -- Pricing variance --
    const perGbPrices = getClients().filter(c => c.billingType === 'per_gb' && c.price > 0).map(c => c.price);
    const perModemPrices = getClients().filter(c => c.billingType === 'per_modem' && c.price > 0).map(c => c.price);
    function stats(arr) {
      if (arr.length === 0) return null;
      const min = Math.min(...arr), max = Math.max(...arr);
      const avg = Math.round(arr.reduce((s, v) => s + v, 0) / arr.length * 100) / 100;
      return { count: arr.length, min, max, avg };
    }

    // -- MRR trend (last 12 months) --
    const trendRows = db.prepare(`SELECT substr(date, 1, 7) as month, SUM(amount) as revenue
      FROM billing_ledger WHERE type='charge' AND date >= ? GROUP BY month ORDER BY month`).all(since365);
    const trend = [];
    // Also detail by tariff
    const trendTariffRows = db.prepare(`SELECT substr(date, 1, 7) as month,
      COALESCE(json_extract(details, '$.billing_type'), 'per_gb') as bt, SUM(amount) as revenue
      FROM billing_ledger WHERE type='charge' AND date >= ? GROUP BY month, bt ORDER BY month`).all(since365);
    const trendIdx = {};
    for (const r of trendRows) {
      const o = { month: r.month, total: Math.round(r.revenue), per_gb: 0, per_modem: 0 };
      trendIdx[r.month] = o; trend.push(o);
    }
    for (const r of trendTariffRows) {
      if (trendIdx[r.month]) trendIdx[r.month][r.bt] = Math.round(r.revenue);
    }

    // -- EOM forecast for current month --
    const monthStart = todayStr.slice(0, 7) + '-01';
    const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    const dayOfMonth = now.getDate();
    const daysLeft = daysInMonth - dayOfMonth;
    const monthRevenueSoFar = db.prepare(`SELECT SUM(amount) s FROM billing_ledger
      WHERE type='charge' AND date >= ? AND date <= ?`).get(monthStart, todayStr).s || 0;
    // Per-day average rate from current month so far
    const dailyRateSoFar = dayOfMonth > 0 ? monthRevenueSoFar / dayOfMonth : 0;
    const forecastEOM = Math.round(monthRevenueSoFar + dailyRateSoFar * daysLeft);

    // -- Daily revenue last 30 days for sparkline --
    const dailyRows = db.prepare(`SELECT date, SUM(amount) as rev FROM billing_ledger
      WHERE type='charge' AND date >= ? GROUP BY date ORDER BY date`).all(since30);

    // -- Recent payments / balance movements (everything except the daily auto-charge) --
    const recentPayments = db.prepare(`
      SELECT l.client_id, l.type, l.date, l.amount, l.source, c.name AS client_name
        FROM billing_ledger l LEFT JOIN clients c ON c.id = l.client_id
       WHERE l.type IN ('payment','bank_payment','adjustment','correction','manual_charge')
       ORDER BY l.date DESC, l.id DESC LIMIT 6`).all().map(r => ({
      client: r.client_name || r.client_id,
      date: r.date,
      amount: Math.round(r.amount),
      source: (r.source && String(r.source).indexOf('tochka') === 0) ? 'Точка' : 'вручную'
    }));

    const payload = {
      period,
      now: now.toISOString(),
      summary: {
        mrr: Math.round(totalMrr),
        mrr_prev: Math.round(prevTotalMrr),
        mrr_growth_pct: mrrGrowthPct,
        arr,
        active_clients: activeClients.length,
        new_clients: newClients.length,
        churned_clients: churnedClients.length,
        churn_rate_pct: churnRatePct,
        arpu,
        nrr_pct: nrrPct,
        nrr_cohort_size: cohortIds.length,
        utilization_pct: utilPct,
        total_modems: totalModems,
        rented_modems: rentedModems,
        rpm,
        cpm: costPerModem,
        margin_per_modem: marginPerModem,
        total_cost: Math.round(totalCost),
        cost_carried_from: costCarriedFrom,
        forecast_eom: forecastEOM,
        forecast_so_far: Math.round(monthRevenueSoFar)
      },
      concentration,
      per_tariff_revenue: perTariff,
      pricing: {
        per_gb: stats(perGbPrices),
        per_modem: stats(perModemPrices)
      },
      cost_by_category: costByCategory,
      per_server: perServer,
      per_operator: perOperator,
      per_client: perClient,
      trend,
      churned: churnedClients.map(c => ({ id: c.id, name: c.name, last_mrr: prevMrrByClient[c.id] || 0 })),
      new: newClients.map(c => ({ id: c.id, name: c.name, created: c.createdAt, mrr: mrrByClient[c.id] || 0 })),
      daily_revenue: dailyRows.map(r => ({ date: r.date, revenue: Math.round(r.rev) })),
      recent_payments: recentPayments
    };
    _financeCache = payload; _financeCacheKey = cacheKey; _financeCacheTs = Date.now();
    res.json(payload);
  } catch (e) {
    logger.error('[finance_dashboard] ' + (e.stack || e.message));
    res.status(500).json({ error: 'Finance dashboard failed' });
  }
});

r.get('/api/admin/billing/reconciliation', authMiddleware, adminMiddleware, async (req, res) => {
  const period = req.query.period || getMoscowToday().slice(0, 7); // "YYYY-MM"

  // Ensure portKey mapping is populated for matching dailyTraffic → clients
  if (Object.keys(getPortKeyToPortName()).length === 0) {
    try {
      const cachedResults = await getFetchAllServersDataCached()();
      refreshPortKeyMapping(cachedResults);
    } catch (e) { logger.warn('[Reconciliation] Failed to refresh port mapping:', e.message); }
  }

  const results = [];

  for (const client of getClients()) {
    if (!client.portName || !client.price || client.price <= 0) continue;

    // Sum stored daily_traffic bytes for this month
    const storedBytes = getClientStoredMonthBytes(client.portName, period);
    const storedGb = trafficBytesToGb(storedBytes);

    // Sum ledger charges for this month
    const entries = ledgerDb.listByClient(client.id);
    const monthCharges = entries.filter(e => (e.type === 'charge' || e.type === 'correction') && e.date && e.date.startsWith(period));
    const billedGb = Math.round(monthCharges.reduce((s, e) => s + (e.delta_gb || 0), 0) * 1000) / 1000;
    const billedCost = Math.round(monthCharges.reduce((s, e) => s + ledgerExpense(e), 0) * 100) / 100;

    // Count days with traffic vs days with billing
    const trafficDays = new Set();
    for (const [portKey, days] of Object.entries(getDailyTraffic())) {
      const firstDay = Object.values(days)[0];
      const pn = (firstDay && firstDay.portName) || getPortKeyToPortName()[portKey] || '';
      if (pn !== client.portName) continue;
      for (const date of Object.keys(days)) {
        if (date.startsWith(period)) trafficDays.add(date);
      }
    }
    const billingDays = new Set(monthCharges.map(e => e.date));

    const diffGb = Math.round((storedGb - billedGb) * 1000) / 1000;
    let status = 'ok';
    if (Math.abs(diffGb) > 0.01) status = 'mismatch';
    if (trafficDays.size > 0 && billingDays.size === 0) status = 'missing_billing';
    if (trafficDays.size === 0 && billingDays.size > 0) status = 'missing_traffic';

    // Find missing days (traffic recorded but no charge)
    const missingDays = [...trafficDays].filter(d => !billingDays.has(d)).sort((a, b) => a.localeCompare(b));

    results.push({
      client_id: client.id,
      client_name: client.name,
      billing_type: client.billingType || 'per_gb',
      stored_gb: storedGb,
      billed_gb: billedGb,
      diff_gb: diffGb,
      billed_cost: billedCost,
      traffic_days: trafficDays.size,
      billing_days: billingDays.size,
      missing_days: missingDays,
      status
    });
  }

  res.json({ period, clients: results });
});

  return r;
};
