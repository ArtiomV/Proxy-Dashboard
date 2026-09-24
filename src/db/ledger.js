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
     gb_used, modem_count, days_in_month, note, source, payment_id, details, purchase_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  S.byClient = db.prepare(`SELECT id, type, date, timestamp, amount, currency,
    balance_before, balance_after, gb_used, modem_count, days_in_month,
    note, source, payment_id, details, purchase_id
    FROM billing_ledger WHERE client_id = ? ORDER BY id`);
  // Stage 8: duplicate-detection helpers used by the daily-billing
  // skip-guard. existsChargeOnDate trips when any client was already billed
  // on the given date; chargedClientIdsForDate returns the set of client IDs
  // that DID get billed (for retry-mode filtering).
  // 2026-09-18 · DEEP-20: строки покупки (purchase_id NOT NULL — первые сутки
  // /тест-день) НЕ считаются суточным расчётом: раньше одна first_day-строка
  // за расчётную дату удовлетворяла гварду и останавливала биллинг всех
  // клиентов. Предикат зеркалит частичный idx_ledger_unique_chargelike.
  S.existsChargeOnDate = db.prepare(
    "SELECT id FROM billing_ledger WHERE date = ? AND type = 'charge' AND purchase_id IS NULL LIMIT 1"
  );
  S.chargedClientIdsForDate = db.prepare(
    "SELECT DISTINCT client_id FROM billing_ledger WHERE date = ? AND type = 'charge' AND purchase_id IS NULL"
  );
  // DEEP-23: базовая линия catch-up при пустой истории billing_runs (первый
  // запуск после миграции) — последняя дата суточного списания в ledger.
  S.lastChargeDate = db.prepare(
    "SELECT MAX(date) AS d FROM billing_ledger WHERE type = 'charge' AND purchase_id IS NULL"
  );
  // 2026-09-24 · §17.3.2: семидневное среднее одним SUM по индексу
  // (client_id/type/date) вместо материализации всей истории клиента.
  // Семантика совпадает с JS-вариантом: type='charge', полуинтервал
  // [from; today) московских дат, деление на 7 у вызывающего.
  S.chargeSumForDates = db.prepare(
    "SELECT COALESCE(SUM(amount), 0) AS total FROM billing_ledger " +
    "WHERE client_id = ? AND type = 'charge' AND date >= ? AND date < ?"
  );
  S.count = db.prepare('SELECT COUNT(*) AS n FROM billing_ledger');
  // 2026-09-18 · FIX-01 п.7 / §14.2/§17.3.1: сверка событий по идентификатору
  // платежа ГЛОБАЛЬНО (без привязки к текущему клиенту — платёж мог быть
  // исторически записан другому). Индекс idx_ledger_payment — миграция 091.
  S.byPayment = db.prepare(`SELECT id, client_id, type, date, timestamp, amount,
    currency, note, source, payment_id
    FROM billing_ledger WHERE payment_id = ? AND type = ? ORDER BY id`);
  // C5: recorded payments minus reversals per client — the ledger-based
  // replacement for the legacy in-memory client.payments[] sum.
  // WP3 (B2C Э4): 'card_payment' (эквайринг) — тот же «платёж», включаем.
  S.paymentsTotal = db.prepare(
    "SELECT COALESCE(SUM(CASE WHEN type IN ('payment','bank_payment','card_payment') THEN amount " +
    "WHEN type = 'payment_reversal' THEN -amount ELSE 0 END), 0) AS total " +
    "FROM billing_ledger WHERE client_id = ?"
  );
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
    if (r.purchase_id) entry.purchaseId = r.purchase_id;   // DEEP-20: идемпотентность покупки
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

// Stage 8 — daily-billing skip-guard helpers.
function existsChargeOnDate(date) { return S.existsChargeOnDate.get(date); }
function chargedClientIdsForDate(date) {
  return S.chargedClientIdsForDate.all(date).map(r => r.client_id);
}
function rowCount() { return S.count.get().n; }
// §17.3.2: SUM по диапазону дат без чтения истории (см. avgDailyCharge7d).
function chargeSumForDates(clientId, fromDate, toDate) {
  return S.chargeSumForDates.get(clientId, fromDate, toDate).total;
}
function listByPayment(paymentId, type) { return S.byPayment.all(String(paymentId), String(type)); }
function lastChargeDate() { const r = S.lastChargeDate.get(); return r ? r.d : null; }

// C5: total recorded payments minus reversals from listByClient-shaped
// entries (payment + bank_payment + card_payment − payment_reversal).
// One-shot SQL variant is paymentsTotalByClient — use it when the full
// entry list isn't needed.
function paymentsTotal(entries) {
  let total = 0;
  for (const e of entries || []) {
    const amt = parseFloat(e.amount) || 0;
    if (e.type === 'payment' || e.type === 'bank_payment' || e.type === 'card_payment') total += amt;
    else if (e.type === 'payment_reversal') total -= amt;
  }
  return Math.round(total * 100) / 100;
}
function paymentsTotalByClient(clientId) { return S.paymentsTotal.get(clientId).total; }

module.exports = {
  init, deleteByClient, deleteById, insertStmt, listByClient,
  existsChargeOnDate, chargedClientIdsForDate, rowCount,
  paymentsTotal, paymentsTotalByClient, listByPayment, lastChargeDate,
  chargeSumForDates,
};
