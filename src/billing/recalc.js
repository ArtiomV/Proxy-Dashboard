'use strict';
// Full-ledger balance recompute — THE canonical formula (extracted from
// src/routes/clients.js, Stage 18.8, so the reconcile job (WP5) and the
// delete-entry routes share one implementation).
//
// Walks every entry by id ASC, summing the authoritative
// (balance_after − balance_before) snapshot deltas, falling back to
// type-based signs for legacy rows without snapshots.
const DEBIT_TYPES = new Set(['charge', 'debit', 'traffic_charge', 'daily_charge', 'expense']);

function recalcFromLedger(db, clientId) {
  const rows = db.prepare(`
    SELECT type, amount, balance_before, balance_after
    FROM billing_ledger WHERE client_id = ? ORDER BY id ASC
  `).all(clientId);
  if (!rows.length) return 0;
  // P1-1: anchor on the FIRST entry's balance_before instead of assuming 0.
  // If a client had an opening balance set outside the ledger (import, manual
  // SQL, pre-ledger era), starting from 0 would silently wipe that remainder.
  // balance_before of the earliest row captures it; we then apply every delta
  // (including the first row's) on top.
  let bal = (rows[0].balance_before != null) ? rows[0].balance_before : 0;
  for (const r of rows) {
    if (r.balance_before != null && r.balance_after != null) {
      bal += (r.balance_after - r.balance_before);   // authoritative snapshot delta
    } else {
      const a = r.amount || 0;
      if (DEBIT_TYPES.has(r.type)) bal -= a; else bal += a;
    }
  }
  return Math.round(bal * 100) / 100;
}

module.exports = { recalcFromLedger, DEBIT_TYPES };
