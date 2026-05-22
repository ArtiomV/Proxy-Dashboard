'use strict';
// Stage 4 fix #1: the previous init() captured the `clientById` Map by value.
// server.js then ran `rebuildClientMaps()` which reassigns the *binding*
// `clientById = new Map(...)`, so this module's reference pointed at the
// stale (now-empty) Map. The `if (client) client.balance = balanceAfter`
// line below was effectively dead code after any client create/update.
//
// Net effect in prod: HTTP responses from /api/admin/clients/:id/payment
// returned `balance: 0` even though the DB row updated correctly — the
// stale in-memory client object never got its balance synced. See
// FOLLOWUP.md → "billing/atomic.js stale clientById reference".
//
// Fix: take a `getClientById` getter (read on every call) instead of the
// Map directly. Backwards-compatible: callers can still pass
// `clientById: someMap` and we'll wrap it in a getter.
//
// Stage 4 finish: the in-memory `billingLedger` mirror is gone — every
// reader now calls `ledgerDb.listByClient()` which reads fresh DB rows.
// We dropped the `getBillingLedger` dep entirely; `_ledgerInsert.run()`
// inside the same txn is still the canonical write.

let db, _clientGetBalance, _clientUpdateBalance, _ledgerInsert, _ledgerEntryParams;
let getClientById;

function init(deps) {
  db = deps.db;
  _clientGetBalance = deps._clientGetBalance;
  _clientUpdateBalance = deps._clientUpdateBalance;
  _ledgerInsert = deps._ledgerInsert;
  _ledgerEntryParams = deps._ledgerEntryParams;

  // Accept either a getter (preferred) or the raw object/map (legacy).
  if (typeof deps.getClientById === 'function') {
    getClientById = deps.getClientById;
  } else if (deps.clientById) {
    const map = deps.clientById;
    getClientById = (id) => map.get(id);
  }
}

/**
 * atomicCredit — atomically add amount to client balance AND insert ledger entry
 * BUG-02 fix: balance + ledger in single transaction (no partial state)
 * BUG-03 fix: uses clientById.get() for O(1) in-memory sync
 * @param {string} clientId
 * @param {number} amount
 * @param {object} [ledgerEntry] — if provided, inserted in same transaction
 * Returns { balanceBefore, balanceAfter }
 */
function atomicCredit(clientId, amount, ledgerEntry) {
  amount = Math.round(parseFloat(amount) * 100) / 100;
  if (isNaN(amount)) throw new Error('atomicCredit: invalid amount');
  if (amount === 0) { const row = _clientGetBalance.get(clientId); const b = row ? row.balance : 0; return { balanceBefore: b, balanceAfter: b }; }
  let balanceBefore, balanceAfter, ledgerDbId;
  db.transaction(() => {
    const row = _clientGetBalance.get(clientId);
    if (!row) throw new Error(`atomicCredit: client ${clientId} not found`);
    balanceBefore = row.balance || 0;
    balanceAfter = Math.round((balanceBefore + amount) * 100) / 100;
    _clientUpdateBalance.run(balanceAfter, clientId);
    if (ledgerEntry) {
      const entry = { ...ledgerEntry, balance_before: balanceBefore, balance_after: balanceAfter };
      const result = _ledgerInsert.run(..._ledgerEntryParams(clientId, entry));
      ledgerDbId = result.lastInsertRowid;
    }
  })();
  const client = getClientById && getClientById(clientId);
  if (client) client.balance = balanceAfter;
  return { balanceBefore, balanceAfter, ledgerDbId };
}

/**
 * atomicDebit — atomically subtract amount from client balance AND insert ledger entry
 * Same BUG-02/03/05 fixes as atomicCredit.
 * Options:
 *   - minBalance (number, default null) — if set, transaction aborts if balanceAfter < minBalance
 *     → throws Error('insufficient_balance') with balanceBefore attached.
 * Duplicate-charge protection:
 *   - If UNIQUE index idx_ledger_unique_charge rejects insert (migration 015),
 *     returns { duplicate: true, balanceBefore } without modifying balance.
 */
function atomicDebit(clientId, amount, ledgerEntry, opts) {
  opts = opts || {};
  amount = Math.round(parseFloat(amount) * 100) / 100;
  if (isNaN(amount)) throw new Error('atomicDebit: invalid amount');
  if (amount === 0) { const row = _clientGetBalance.get(clientId); const b = row ? row.balance : 0; return { balanceBefore: b, balanceAfter: b }; }
  let balanceBefore, balanceAfter, ledgerDbId, duplicate = false;
  try {
    db.transaction(() => {
      const row = _clientGetBalance.get(clientId);
      if (!row) throw new Error(`atomicDebit: client ${clientId} not found`);
      balanceBefore = row.balance || 0;
      balanceAfter = Math.round((balanceBefore - amount) * 100) / 100;
      if (opts.minBalance != null && balanceAfter < opts.minBalance) {
        const err = new Error('insufficient_balance');
        err.code = 'INSUFFICIENT_BALANCE';
        err.balanceBefore = balanceBefore;
        err.balanceAfter = balanceAfter;
        err.minBalance = opts.minBalance;
        throw err;
      }
      _clientUpdateBalance.run(balanceAfter, clientId);
      if (ledgerEntry) {
        const entry = { ...ledgerEntry, balance_before: balanceBefore, balance_after: balanceAfter };
        const result = _ledgerInsert.run(..._ledgerEntryParams(clientId, entry));
        ledgerDbId = result.lastInsertRowid;
      }
    })();
  } catch (e) {
    // SQLite raises SQLITE_CONSTRAINT_UNIQUE if the partial unique index on
    // billing_ledger(client_id, date, type) WHERE type='charge' matches an
    // existing row. That means the charge for this day already posted;
    // skip without retry/double-billing.
    if (e && (e.code === 'SQLITE_CONSTRAINT_UNIQUE' || /UNIQUE constraint/i.test(e.message || ''))) {
      const row = _clientGetBalance.get(clientId);
      return { duplicate: true, balanceBefore: row ? row.balance : 0, balanceAfter: row ? row.balance : 0 };
    }
    throw e;
  }
  const client = getClientById && getClientById(clientId);
  if (client) client.balance = balanceAfter;
  return { balanceBefore, balanceAfter, ledgerDbId, duplicate };
}

module.exports = { init, atomicCredit, atomicDebit };
