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
let _clientUpdateReferralBalance; // Stage 13.1
let getClientById;

function init(deps) {
  db = deps.db;
  _clientGetBalance = deps._clientGetBalance;
  _clientUpdateBalance = deps._clientUpdateBalance;
  _ledgerInsert = deps._ledgerInsert;
  _ledgerEntryParams = deps._ledgerEntryParams;
  // Stage 13.1: referral commission must land in the same transaction as
  // the payment that triggered it. atomic.js owns the stmt so every credit
  // path goes through one entry point — no more route-side `.run()` calls
  // sitting OUTSIDE the txn (the original /payment bug).
  _clientUpdateReferralBalance = deps._clientUpdateReferralBalance;

  // Accept either a getter (preferred) or the raw object/map (legacy).
  if (typeof deps.getClientById === 'function') {
    getClientById = deps.getClientById;
  } else if (deps.clientById) {
    const map = deps.clientById;
    getClientById = (id) => map.get(id);
  }
}

/**
 * applyReferralInsideTx — internal helper called inside the same txn as
 * the balance update. Loads the referrer's current referral_balance,
 * applies `delta` (positive = credit, negative = reversal), updates the
 * DB row, and returns { referrerId, newBalance } so the caller can sync
 * in-memory state ONLY after the outer transaction commits.
 *
 * Throws if referrerId is set but no such row exists — caller's choice
 * of catching that defines the failure mode (rolls back the whole txn).
 */
let _clientGetReferralBalance = null;
function _applyReferralInsideTx(referrerId, delta) {
  if (!_clientUpdateReferralBalance) {
    throw new Error('atomic.init() not given _clientUpdateReferralBalance');
  }
  if (!_clientGetReferralBalance) {
    _clientGetReferralBalance = db.prepare('SELECT referral_balance FROM clients WHERE id = ?');
  }
  // One-shot SELECT inside the active SQLite write txn — sees committed
  // values only, so concurrent writers can't interleave and we always
  // base the +/- on the freshest balance.
  const row = _clientGetReferralBalance.get(referrerId);
  const current = row && row.referral_balance != null ? row.referral_balance : 0;
  const newBalance = Math.round((current + delta) * 100) / 100;
  _clientUpdateReferralBalance.run(newBalance, referrerId);
  return { referrerId, newBalance };
}

/**
 * atomicCredit — atomically add amount to client balance AND insert ledger entry
 * BUG-02 fix: balance + ledger in single transaction (no partial state)
 * BUG-03 fix: uses clientById.get() for O(1) in-memory sync
 * Stage 13.1: opts.referral — if set, applies a referral commission
 *   delta inside the SAME txn. Shape: { referrerId: string, delta: number }
 *   (positive credit for a new payment; negative for a reversal). Returns
 *   the new referrer balance so the caller can sync in-memory state ONLY
 *   after the outer transaction commits.
 * @param {string} clientId
 * @param {number} amount
 * @param {object} [ledgerEntry] — if provided, inserted in same transaction
 * @param {object} [opts] — { referral: { referrerId, delta } }
 * Returns { balanceBefore, balanceAfter, ledgerDbId, referral? }
 */
function atomicCredit(clientId, amount, ledgerEntry, opts) {
  opts = opts || {};
  amount = Math.round(parseFloat(amount) * 100) / 100;
  if (isNaN(amount)) throw new Error('atomicCredit: invalid amount');
  if (amount === 0) { const row = _clientGetBalance.get(clientId); const b = row ? row.balance : 0; return { balanceBefore: b, balanceAfter: b }; }
  let balanceBefore, balanceAfter, ledgerDbId;
  let referralResult = null;
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
    if (opts.referral && opts.referral.referrerId && opts.referral.delta) {
      referralResult = _applyReferralInsideTx(opts.referral.referrerId, opts.referral.delta);
    }
  })();
  const client = getClientById && getClientById(clientId);
  if (client) client.balance = balanceAfter;
  // Sync referrer in-memory ONLY after the txn committed successfully.
  if (referralResult) {
    const referrer = getClientById && getClientById(referralResult.referrerId);
    if (referrer) referrer.referral_balance = referralResult.newBalance;
  }
  return { balanceBefore, balanceAfter, ledgerDbId, referral: referralResult };
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
  let referralResult = null;
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
      if (opts.referral && opts.referral.referrerId && opts.referral.delta) {
        referralResult = _applyReferralInsideTx(opts.referral.referrerId, opts.referral.delta);
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
  if (referralResult) {
    const referrer = getClientById && getClientById(referralResult.referrerId);
    if (referrer) referrer.referral_balance = referralResult.newBalance;
  }
  return { balanceBefore, balanceAfter, ledgerDbId, duplicate, referral: referralResult };
}

module.exports = { init, atomicCredit, atomicDebit };
