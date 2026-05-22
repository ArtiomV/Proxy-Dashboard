'use strict';
// src/db/ledger.js — repository for billing_ledger.
//
// The hot path (insert via atomicCredit/atomicDebit) keeps a prepared
// statement reference + uses _ledgerEntryParams to map JS objects to
// positional args. We expose those raw to billing.init() to avoid a
// per-credit function call. Bulk read paths use named functions.

let S = {};

function init(db) {
  S.deleteByClient = db.prepare('DELETE FROM billing_ledger WHERE client_id = ?');
  S.deleteById = db.prepare('DELETE FROM billing_ledger WHERE id = ?');
  S.insert = db.prepare(`INSERT INTO billing_ledger
    (client_id, type, date, timestamp, amount, currency, balance_before, balance_after,
     gb_used, modem_count, days_in_month, note, source, payment_id, details)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  S.byClient = db.prepare(`SELECT id, type, date, timestamp, amount, currency,
    balance_before, balance_after, gb_used, modem_count, days_in_month,
    note, source, payment_id, details
    FROM billing_ledger WHERE client_id = ? ORDER BY id`);
}

// listByClient — reads billing_ledger rows and rehydrates them into the
// same JS shape that the in-memory `billingLedger[clientId]` array used
// to hold. Stage 4 removed the in-memory mirror; this is the one
// authoritative read path.
//
// IMPORTANT: shape must match exactly what the startup loader produced
// (charges store `cost`, others store `amount`; `delta_gb` not `gb_used`;
// camelCase `paymentId`; skip null fields). Route bodies depend on this.
function listByClient(clientId) {
  return S.byClient.all(clientId).map(r => {
    const entry = { type: r.type, date: r.date, timestamp: r.timestamp || '' };
    if (r.type === 'charge') { entry.cost = r.amount; } else { entry.amount = r.amount; }
    entry.currency = r.currency || 'RUB';
    if (r.balance_before != null) entry.balance_before = r.balance_before;
    if (r.balance_after != null) entry.balance_after = r.balance_after;
    if (r.gb_used != null) entry.delta_gb = r.gb_used;
    if (r.modem_count != null) entry.modem_count = r.modem_count;
    if (r.days_in_month != null) entry.days_in_month = r.days_in_month;
    if (r.note) entry.note = r.note;
    if (r.source) entry.source = r.source;
    if (r.payment_id) entry.paymentId = r.payment_id;
    if (r.details && r.details !== '{}') {
      try { Object.assign(entry, JSON.parse(r.details)); } catch (_) { /* best-effort */ }
    }
    entry.db_id = r.id;
    return entry;
  });
}

function deleteByClient(clientId) { return S.deleteByClient.run(clientId); }
function deleteById(id) { return S.deleteById.run(id); }

// Hot-path: passed to billing.init() so atomicCredit/atomicDebit reuse
// the same prepared statement.
function insertStmt() { return S.insert; }

module.exports = { init, deleteByClient, deleteById, insertStmt, listByClient };
