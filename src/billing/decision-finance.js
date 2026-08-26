'use strict';

const DAY_MS = 86400e3;

function key(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function activeDays(validBefore, now, horizonDays) {
  if (!validBefore) return horizonDays;
  const raw = String(validBefore).slice(0, 10);
  const end = Date.parse(raw + 'T23:59:59.999Z');
  if (!Number.isFinite(end)) return horizonDays;
  return Math.max(0, Math.min(horizonDays, Math.ceil((end - now.getTime()) / DAY_MS)));
}

function forecastRevenue30d(clients, now = new Date(), horizonDays = 30) {
  const perClient = [];
  let expected = 0, runRate = 0;
  for (const c of clients || []) {
    if (c.paused) continue;
    const assets = Array.isArray(c.assets) ? c.assets : [];
    const price = Math.max(0, Number(c.price) || 0);
    let withRenewals = 0, withoutRenewals = 0;
    if (c.billingType === 'per_modem') {
      withRenewals = price * assets.length;
      withoutRenewals = assets.reduce((sum, a) => sum + price * activeDays(a.validBefore, now, horizonDays) / horizonDays, 0);
    } else {
      const daily = Math.max(0, Number(c.avgDailyRevenue) || 0);
      withRenewals = daily * horizonDays;
      const assetDays = assets.reduce((sum, a) => sum + activeDays(a.validBefore, now, horizonDays), 0);
      const effectiveDays = assets.length ? assetDays / assets.length : 0;
      withoutRenewals = daily * effectiveDays;
    }
    withRenewals = Math.round(withRenewals * 100) / 100;
    withoutRenewals = Math.round(withoutRenewals * 100) / 100;
    const atRisk = Math.max(0, Math.round((withRenewals - withoutRenewals) * 100) / 100);
    runRate += withRenewals; expected += withoutRenewals;
    perClient.push({
      id: c.id, name: c.name, with_renewals: withRenewals,
      without_renewals: withoutRenewals, revenue_at_risk: atRisk,
      expiring_assets: assets.filter(a => activeDays(a.validBefore, now, horizonDays) < horizonDays).length,
    });
  }
  perClient.sort((a, b) => b.revenue_at_risk - a.revenue_at_risk);
  return {
    horizon_days: horizonDays,
    with_renewals: Math.round(runRate),
    without_renewals: Math.round(expected),
    revenue_at_risk: Math.round(Math.max(0, runRate - expected)),
    per_client: perClient,
  };
}

function buildReceivablesAging(clients, now = new Date()) {
  const buckets = {
    current: { label: '0–7 дней', count: 0, amount: 0 },
    days_8_14: { label: '8–14 дней', count: 0, amount: 0 },
    days_15_30: { label: '15–30 дней', count: 0, amount: 0 },
    days_31_plus: { label: '31+ дней', count: 0, amount: 0 },
  };
  const rows = [];
  for (const c of clients || []) {
    const amount = Math.max(0, -Number(c.balance || 0));
    if (!(amount > 0) || c.paused) continue;
    const unpaid = (c.bills || []).filter(b => b && b.status !== 'paid').sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
    const sinceRaw = c.balanceNegativeSince || (unpaid[0] && unpaid[0].createdAt) || now.toISOString();
    const since = Date.parse(sinceRaw);
    const ageDays = Number.isFinite(since) ? Math.max(0, Math.floor((now.getTime() - since) / DAY_MS)) : 0;
    const bucket = ageDays > 30 ? 'days_31_plus' : ageDays > 14 ? 'days_15_30' : ageDays > 7 ? 'days_8_14' : 'current';
    buckets[bucket].count += 1; buckets[bucket].amount += amount;
    rows.push({ id: c.id, name: c.name, amount: Math.round(amount * 100) / 100, age_days: ageDays, since: Number.isFinite(since) ? new Date(since).toISOString() : null, bucket, unpaid_bills: unpaid.length });
  }
  for (const b of Object.values(buckets)) b.amount = Math.round(b.amount * 100) / 100;
  rows.sort((a, b) => b.age_days - a.age_days || b.amount - a.amount);
  return { total: Math.round(rows.reduce((s, r) => s + r.amount, 0) * 100) / 100, clients: rows.length, buckets, rows };
}

// Распределяет каждую фактическую статью затрат, а не просто делит общий
// расход поровну. SIM — по модемам соответствующего оператора; расходы
// площадки — по клиентским модемам этой локации; общие — по доле выручки.
function allocateUnitEconomics(clients, costRows, locationByServer) {
  const out = (clients || []).map(c => ({ ...c, allocated_cost: 0 }));
  let unallocated = 0;
  const allocate = (row, weightFn) => {
    const amount = Math.max(0, Number(row.amount_rub) || 0);
    if (!(amount > 0)) return;
    const weights = out.map(weightFn);
    const total = weights.reduce((s, v) => s + v, 0);
    if (!(total > 0)) { unallocated += amount; return; }
    out.forEach((c, i) => { c.allocated_cost += amount * weights[i] / total; });
  };
  for (const row of costRows || []) {
    if (row.category === 'sim') {
      const op = key(row.subkey);
      allocate(row, c => (c.assets || []).filter(a => {
        const actual = key(a.operator);
        return op && (actual === op || actual.startsWith(op) || op.startsWith(actual));
      }).length);
    } else if (['server', 'electricity', 'hosting', 'salary'].includes(row.category) && row.subkey) {
      const target = String(row.subkey);
      allocate(row, c => (c.assets || []).filter(a => {
        const location = locationByServer && locationByServer[a.server];
        return location === target || a.server === target || ('server:' + a.server) === target;
      }).length);
    } else {
      allocate(row, c => Math.max(0, Number(c.revenue) || 0));
    }
  }
  const rows = out.map(c => {
    const revenue = Math.max(0, Number(c.revenue) || 0);
    const cost = Math.round(c.allocated_cost * 100) / 100;
    const margin = Math.round((revenue - cost) * 100) / 100;
    return {
      id: c.id, name: c.name, revenue: Math.round(revenue * 100) / 100,
      allocated_cost: cost, margin,
      margin_pct: revenue > 0 ? Math.round(margin / revenue * 1000) / 10 : null,
      modems: (c.assets || []).length,
    };
  }).sort((a, b) => a.margin - b.margin);
  return { rows, unallocated_cost: Math.round(unallocated * 100) / 100 };
}

module.exports = { activeDays, forecastRevenue30d, buildReceivablesAging, allocateUnitEconomics };
