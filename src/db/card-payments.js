'use strict';
// src/db/card-payments.js — repository for the `card_payments` table (WP3, этап 4).
//
// Эквайринг физиков (Точка/ЮKassa). Зачёт ТОЛЬКО по webhook, идемпотентность —
// UNIQUE(order_id) + статусная машина created → paid → credited (+refunded/failed).
// Таблица создана миграцией 060 заранее; сам роут payments.js — этап 4.

let S = {};

function init(db) {
  S.byOrderId = db.prepare('SELECT * FROM card_payments WHERE order_id = ?');
  S.byClient = db.prepare('SELECT * FROM card_payments WHERE client_id = ? ORDER BY id DESC LIMIT 100');
  S.insertCreated = db.prepare(
    "INSERT OR IGNORE INTO card_payments (order_id, client_id, amount, method, status, created_at, promo_code) " +
    "VALUES (?, ?, ?, ?, 'created', datetime('now'), ?)"
  );
  S.markPaid = db.prepare(
    "UPDATE card_payments SET status='paid', provider_payment_id=?, raw_json=? " +
    "WHERE order_id=? AND status='created'"
  );
  S.markCredited = db.prepare(
    "UPDATE card_payments SET status='credited', credited_at=datetime('now') WHERE order_id=? AND status='paid'"
  );
  S.markStatus = db.prepare('UPDATE card_payments SET status=? WHERE order_id=?');
  S.recent = db.prepare('SELECT * FROM card_payments ORDER BY id DESC LIMIT ?');
  S.pendingPaid = db.prepare(
    "SELECT * FROM card_payments WHERE status='paid' " +
    "AND (next_recovery_at IS NULL OR next_recovery_at <= datetime('now')) ORDER BY id LIMIT ?"
  );
  S.markRecoveryFailure = db.prepare(
    "UPDATE card_payments SET recovery_attempts=recovery_attempts+1, next_recovery_at=?, recovery_error=? " +
    "WHERE order_id=? AND status='paid'"
  );
  // WP3: operationId провайдера привязываем к заказу сразу после create_payment
  // (до webhook) — по нему админ делает возврат.
  S.attachProvider = db.prepare(
    "UPDATE card_payments SET provider_payment_id=? WHERE order_id=? AND status='created'"
  );
}

function byOrderId(orderId) { return S.byOrderId.get(orderId); }
function byClient(clientId) { return S.byClient.all(clientId); }
// INSERT OR IGNORE: дубль webhook по order_id → changes=0 (идемпотентность).
// promo_code (WP6) — применённый промокод; бонус зачисляется в webhook.
function insertCreated(orderId, clientId, amount, method, promoCode) {
  return S.insertCreated.run(orderId, clientId, amount, method || null, promoCode || null);
}
function markPaid(orderId, providerPaymentId, rawJson) {
  return S.markPaid.run(providerPaymentId || null, rawJson || null, orderId);
}
function markCredited(orderId) { return S.markCredited.run(orderId); }
function markStatus(orderId, status) { return S.markStatus.run(status, orderId); }
function recent(limit) { return S.recent.all(limit || 100); }
function pendingPaid(limit) { return S.pendingPaid.all(limit || 50); }
function markRecoveryFailure(orderId, error, nowMs = Date.now()) {
  const row = S.byOrderId.get(orderId);
  const delays = [1, 5, 15, 60];
  const attempts = Number(row && row.recovery_attempts) || 0;
  const delayMin = delays[Math.min(attempts, delays.length - 1)];
  // SQLite UTC-формат ('YYYY-MM-DD HH:MM:SS'), как datetime('now') в pendingPaid:
  // toISOString() с 'T' лексикографически БОЛЬШЕ даты с пробелом в тот же день,
  // и ретрай не выбирался бы до завтра (DEEP-01).
  const next = new Date(nowMs + delayMin * 60000).toISOString().slice(0, 19).replace('T', ' ');
  return S.markRecoveryFailure.run(next, String(error || '').slice(0, 1000), orderId);
}
function attachProvider(orderId, providerPaymentId) { return S.attachProvider.run(providerPaymentId, orderId); }

module.exports = { init, byOrderId, byClient, insertCreated, markPaid, markCredited, markStatus,
  recent, pendingPaid, markRecoveryFailure, attachProvider };
