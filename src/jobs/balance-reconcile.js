'use strict';
// src/jobs/balance-reconcile.js — daily balance-vs-ledger reconciliation (WP5).
//
// The client balance is maintained incrementally (memory + clients.balance);
// billing_ledger is the audit trail. Before this job, only the CI test
// checked that balance == Σledger — production drift was invisible.
//
// OBSERVATION ONLY — never auto-corrects money:
//   drift > 0.01 ₽ → logActivity('billing','critical','balance_drift')
//   + TG alert (rule 'balance_drift', 24h cooldown)
//   + lastResult exposed to /api/admin/health (balance_divergent_clients).
const { recalcFromLedger } = require('../billing/recalc');

const DRIFT_EPSILON = 0.01;

function create(deps) {
  const { db, clients, logActivity, logger, alerts } = deps;
  let lastResult = { checkedAt: null, divergent: 0, total: 0, offenders: [] };

  function runOnce() {
    let divergent = 0, total = 0;
    const offenders = [];
    for (const c of (clients || [])) {
      total++;
      let expected;
      try { expected = recalcFromLedger(db, c.id); }
      catch (e) { logger.warn('[BalanceReconcile] recalc failed for ' + c.id + ': ' + e.message); continue; }
      const actual = typeof c.balance === 'number' ? c.balance : 0;
      const diff = Math.round((actual - expected) * 100) / 100;
      if (Math.abs(diff) > DRIFT_EPSILON) {
        divergent++;
        offenders.push({ id: c.id, name: c.name, actual, expected, diff });
      }
    }
    lastResult = { checkedAt: new Date().toISOString(), divergent, total, offenders: offenders.slice(0, 20) };
    if (divergent > 0) {
      logger.error(`[BalanceReconcile] ${divergent}/${total} client(s) diverge from ledger`);
      try {
        logActivity('billing', 'critical', 'balance_drift', null,
          `${divergent} клиент(ов): баланс ≠ SUM(ledger)`,
          { divergent, total, offenders: offenders.slice(0, 10) });
      } catch (_) { /* best-effort */ }
      try {
        alerts.trigger('balance_drift', {
          count: divergent, total,
          offenders: offenders.slice(0, 5).map(o => `${o.name}: ${o.actual} ≠ ${o.expected} (${o.diff > 0 ? '+' : ''}${o.diff})`).join('\n'),
        });
      } catch (_) { /* best-effort */ }
    } else {
      logger.info(`[BalanceReconcile] OK — ${total} client(s) match ledger`);
    }
    return lastResult;
  }

  return { runOnce, getLastResult: () => lastResult, DRIFT_EPSILON };
}

module.exports = { create };
