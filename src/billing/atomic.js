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

// Ленивые prepared statements привязаны к конкретной БД — init() их сбрасывает,
// иначе повторный init (честные тесты на нескольких БД) молча писал бы в прежнюю.
let _clientGetReferralBalance = null;
let _idempotencyInsert = null;
let _idempotencyClaimGet = null;

// Число и ТОЛЬКО число: Number, не parseFloat — мусорные строки вида '100abc'
// отклоняются, как и NaN/Infinity и переполнение диапазона копеек (DEEP-05).
function _normalizeAmount(raw, fnName) {
  if (raw == null || (typeof raw === 'string' && raw.trim() === '')) {
    throw new Error(`${fnName}: invalid amount`);
  }
  const num = Number(raw);
  if (!Number.isFinite(num) || Math.abs(num) > Number.MAX_SAFE_INTEGER / 100) {
    throw new Error(`${fnName}: invalid amount`);
  }
  return Math.round(num * 100) / 100;
}

// WP7.2: every successful ledger write emits 'finance-write' so caches
// (finance dashboard) invalidate through ONE hook, not per-endpoint resets.
const financeEvents = require('./events');
function _emitFinanceWrite() {
  try { financeEvents.emit('finance-write'); } catch (_) { /* best-effort */ }
}

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
  _clientGetReferralBalance = null;
  _idempotencyInsert = null;
  _idempotencyClaimGet = null;

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
 * @param {object} [opts] — { referral: { referrerId, delta },
 *   idempotencyKey: durable-claim в finance_idempotency той же транзакцией;
 *   повтор с теми же клиентом/суммой → { duplicate: true } без денег, повтор
 *   с ДРУГИМИ клиентом/суммой → ошибка IDEMPOTENCY_CONFLICT (DEEP-04);
 *   insideTx: fn() — доп. запись внутри той же транзакции (напр. markCredited) }
 * Returns { balanceBefore, balanceAfter, ledgerDbId, referral?, duplicate }
 */
function atomicCredit(clientId, amount, ledgerEntry, opts) {
  opts = opts || {};
  amount = _normalizeAmount(amount, 'atomicCredit');
  // Stage 16: intentional early-return — amount=0 is a no-op (no balance
  // change, no ledger entry). Some refresh paths call with 0 just to
  // re-read the current balance. If a future caller needs amount=0
  // WITH an audit trail, add an explicit `opts.forceLog` flag rather
  // than removing this short-circuit.
  if (amount === 0) { const row = _clientGetBalance.get(clientId); const b = row ? row.balance : 0; return { balanceBefore: b, balanceAfter: b }; }
  let balanceBefore, balanceAfter, ledgerDbId, duplicate = false;
  let referralResult = null;
  try {
    db.transaction(() => {
      if (opts.idempotencyKey) {
        if (!_idempotencyInsert) _idempotencyInsert = db.prepare(
          'INSERT INTO finance_idempotency (event_key, client_id, amount) VALUES (?, ?, ?)'
        );
        _idempotencyInsert.run(String(opts.idempotencyKey), clientId, amount);
      }
      if (typeof opts.insideTx === 'function') opts.insideTx();
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
  } catch (e) {
    // Только конфликт ИМЕННО нашего claim-ключа. Любой другой UNIQUE/PK
    // (insideTx callback, ledger) — обычная ошибка: транзакция уже откачена,
    // пробрасываем вызывающему (§14.3 FIX-SPEC).
    if (opts.idempotencyKey && e && /UNIQUE constraint failed: finance_idempotency\./i.test(e.message || '')) {
      if (!_idempotencyClaimGet) _idempotencyClaimGet = db.prepare(
        'SELECT client_id, amount FROM finance_idempotency WHERE event_key = ?'
      );
      const claim = _idempotencyClaimGet.get(String(opts.idempotencyKey));
      // Тот же ключ с ДРУГИМИ клиентом/суммой — это конфликт, а не дубль:
      // молчаливый duplicate здесь прятал бы финансовую ошибку (DEEP-04).
      if (!claim || claim.client_id !== clientId || Math.abs(claim.amount - amount) > 0.005) {
        const err = new Error(`atomicCredit: idempotency key conflict: ${opts.idempotencyKey}`);
        err.code = 'IDEMPOTENCY_CONFLICT';
        throw err;
      }
      const row = _clientGetBalance.get(clientId);
      const current = row ? row.balance : 0;
      return { duplicate: true, balanceBefore: current, balanceAfter: current };
    }
    throw e;
  }
  const client = getClientById && getClientById(clientId);
  if (client) client.balance = balanceAfter;
  // Sync referrer in-memory ONLY after the txn committed successfully.
  if (referralResult) {
    const referrer = getClientById && getClientById(referralResult.referrerId);
    if (referrer) referrer.referral_balance = referralResult.newBalance;
  }
  _emitFinanceWrite();
  // B3 (Р13): восстановление после оплаты — слушатель (debt-block) продлевает
  // «дата до» портов, если клиент был погашен автоблоком. Эмитим после коммита;
  // покрывает все пути зачисления разом (ручной платёж, webhook, sync, ручная
  // привязка) — до ~30 мин задержки для банковского sync (цикл TochkaSync).
  try { financeEvents.emit('client-credit', { clientId, amount, balanceBefore, balanceAfter }); } catch (_) { /* best-effort */ }
  return { balanceBefore, balanceAfter, ledgerDbId, referral: referralResult, duplicate };
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
 *   - 2026-09-18 (DEEP-03): opts.insideTx fn() — доп. запись внутри той же
 *     транзакции (напр. markRefunded при возврате), как у atomicCredit.
 */
function atomicDebit(clientId, amount, ledgerEntry, opts) {
  opts = opts || {};
  amount = _normalizeAmount(amount, 'atomicDebit');
  // Stage 16: same intentional no-op as atomicCredit — amount=0 returns
  // current balance without writing a ledger entry. See atomicCredit
  // comment above for the design rationale.
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
      if (typeof opts.insideTx === 'function') opts.insideTx();
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
  _emitFinanceWrite();
  return { balanceBefore, balanceAfter, ledgerDbId, duplicate, referral: referralResult };
}

module.exports = { init, atomicCredit, atomicDebit };
