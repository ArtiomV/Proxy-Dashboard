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
    "INSERT OR IGNORE INTO card_payments (order_id, client_id, amount, method, status, created_at) " +
    "VALUES (?, ?, ?, ?, 'created', datetime('now'))"
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
  // WP3: operationId провайдера привязываем к заказу сразу после create_payment
  // (до webhook) — по нему админ делает возврат.
  S.attachProvider = db.prepare(
    "UPDATE card_payments SET provider_payment_id=? WHERE order_id=? AND status='created'"
  );
}

function byOrderId(orderId) { return S.byOrderId.get(orderId); }
function byClient(clientId) { return S.byClient.all(clientId); }
// INSERT OR IGNORE: дубль webhook по order_id → changes=0 (идемпотентность).
function insertCreated(orderId, clientId, amount, method) {
  return S.insertCreated.run(orderId, clientId, amount, method || null);
}
function markPaid(orderId, providerPaymentId, rawJson) {
  return S.markPaid.run(providerPaymentId || null, rawJson || null, orderId);
}
function markCredited(orderId) { return S.markCredited.run(orderId); }
function markStatus(orderId, status) { return S.markStatus.run(status, orderId); }
function recent(limit) { return S.recent.all(limit || 100); }
function attachProvider(orderId, providerPaymentId) { return S.attachProvider.run(providerPaymentId, orderId); }

module.exports = { init, byOrderId, byClient, insertCreated, markPaid, markCredited, markStatus, recent, attachProvider };
