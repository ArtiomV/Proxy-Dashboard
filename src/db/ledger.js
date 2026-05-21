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
}

function deleteByClient(clientId) { return S.deleteByClient.run(clientId); }
function deleteById(id) { return S.deleteById.run(id); }

// Hot-path: passed to billing.init() so atomicCredit/atomicDebit reuse
// the same prepared statement.
function insertStmt() { return S.insert; }

module.exports = { init, deleteByClient, deleteById, insertStmt };
