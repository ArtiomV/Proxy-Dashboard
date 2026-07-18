'use strict';
// Canonical revenue metric (WP8): revenue_30d = Σ ledgerExpense over
// charge + correction for a rolling N-MSK-day window. ONE implementation
// shared by /api/admin/data, /api/admin/finance_dashboard and every
// frontend consumer — the two historic definitions (rolling-30d
// charge-only vs calendar month-to-date charge+correction) disagreed on
// every screen («MRR 443k» vs «MRR 467k»).
//
// MSK dates: billing_ledger.date is an MSK 'YYYY-MM-DD' string, so window
// edges are computed from the MSK `today` passed in — NEVER from
// Date#toISOString (UTC), which flips the day between 00:00 and 03:00 MSK.

function _mskDayShift(today, daysBack) {
  const d = new Date(today + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - daysBack);
  return d.toISOString().slice(0, 10);
}

// computeRevenueWindow({ db, ledgerExpense, today, days, fromDays })
//   today    — 'YYYY-MM-DD' (MSK), the reference date.
//   days     — window length in days (default 30): rows with date >= today−days.
//   fromDays — when set, computes the PREVIOUS window instead:
//              rows with today−fromDays <= date < today−days
//              (e.g. days=30, fromDays=60 → the 30 days before the current 30).
// Returns { byClient, total, windowDays, asOf }.
function computeRevenueWindow({ db, ledgerExpense, today, days = 30, fromDays = null }) {
  if (!today) throw new Error('computeRevenueWindow: today (MSK) required');
  const since = _mskDayShift(today, fromDays != null ? fromDays : days);
  const until = fromDays != null ? _mskDayShift(today, days) : null;
  const sql = "SELECT client_id, type, amount, balance_before, balance_after FROM billing_ledger " +
    "WHERE (type = 'charge' OR type = 'correction') AND date >= ?" + (until ? " AND date < ?" : "");
  const rows = until ? db.prepare(sql).all(since, until) : db.prepare(sql).all(since);
  const byClient = {};
  for (const r of rows) {
    // Rehydrate the minimal shape ledgerExpense() expects (cost vs amount):
    // charge → cost = amount; correction → sign from balance delta (refund < 0).
    const entry = r.type === 'charge'
      ? { type: r.type, cost: r.amount }
      : { type: r.type, amount: r.amount, balance_before: r.balance_before, balance_after: r.balance_after };
    const exp = ledgerExpense(entry);
    if (exp !== 0) byClient[r.client_id] = (byClient[r.client_id] || 0) + exp;
  }
  let total = 0;
  for (const k of Object.keys(byClient)) { byClient[k] = Math.round(byClient[k] * 100) / 100; total += byClient[k]; }
  return { byClient, total: Math.round(total * 100) / 100, windowDays: days, asOf: today };
}

module.exports = { computeRevenueWindow };
