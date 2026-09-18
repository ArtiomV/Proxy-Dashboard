'use strict';
// src/db/card-payments.js — repository for the `card_payments` table (WP3, этап 4).
//
// Эквайринг физиков (Точка/ЮKassa). Зачёт ТОЛЬКО по webhook, идемпотентность —
// UNIQUE(order_id) + статусная машина created → paid → credited (+refunded/failed).
// Таблица создана миграцией 060 заранее; сам роут payments.js — этап 4.

let S = {};
let _db = null;

function init(db) {
  _db = db;
  S.byOrderId = db.prepare('SELECT * FROM card_payments WHERE order_id = ?');
  S.byClient = db.prepare('SELECT * FROM card_payments WHERE client_id = ? ORDER BY id DESC LIMIT 100');
  S.insertCreated = db.prepare(
    "INSERT OR IGNORE INTO card_payments (order_id, client_id, amount, method, status, created_at, promo_code, promo_bonus_amount) " +
    "VALUES (?, ?, ?, ?, 'created', datetime('now'), ?, ?)"
  );
  // 2026-09-18 · DEEP-17 (§14.1): paid_at — время ПЕРВОГО проверенного
  // подтверждения оплаты банком (переход created → paid по верифицированному
  // webhook). Возраст незавершённого зачисления считается от paid_at,
  // а не от created_at (миграция 094).
  S.markPaid = db.prepare(
    "UPDATE card_payments SET status='paid', provider_payment_id=?, raw_json=?, paid_at=datetime('now') " +
    "WHERE order_id=? AND status='created'"
  );
  // Повторный верифицированный webhook по legacy-строке (paid без paid_at):
  // это реальное подтверждение банка — фиксируем его время, но не перезаписываем
  // уже сохранённое и не приписываем ничего строкам вне статуса 'paid'.
  S.confirmPaidAt = db.prepare(
    "UPDATE card_payments SET paid_at=datetime('now') WHERE order_id=? AND status='paid' AND paid_at IS NULL"
  );
  S.markCredited = db.prepare(
    "UPDATE card_payments SET status='credited', credited_at=datetime('now') WHERE order_id=? AND status='paid'"
  );
  S.markStatus = db.prepare('UPDATE card_payments SET status=? WHERE order_id=?');
  S.recent = db.prepare('SELECT * FROM card_payments ORDER BY id DESC LIMIT ?');
  S.pendingPaid = db.prepare(
    "SELECT * FROM card_payments WHERE status='paid' " +
    "AND (next_recovery_at IS NULL OR next_recovery_at <= datetime('now') " +
    // 2026-09-18 · DEEP-01/§14.1: legacy-значения могли быть записаны в ISO
    // с 'T' — лексикографически 'T' > ' ' в тот же день, и просроченный retry
    // не выбирался. Нормализованное сравнение подхватывает оба формата.
    "OR replace(substr(next_recovery_at, 1, 19), 'T', ' ') <= datetime('now')) " +
    "ORDER BY id LIMIT ?"
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
  // 2026-09-18 · DEEP-02 (§14.2): статус бонуса — отдельно от статуса оплаты.
  // promo_status не затираем, если уже выставлен (review важнее applied-дубля).
  S.setPromoStatus = db.prepare(
    'UPDATE card_payments SET promo_status=? WHERE order_id=? AND promo_status IS NULL'
  );
  // 2026-09-18 · DEEP-03 (§14.3): устойчивый возврат. Фазы статуса:
  // credited → refund_pending (захват ДО вызова провайдера) →
  // refund_provider_ok (банк подтвердил, сторно ещё не записано) → refunded.
  S.claimRefund = db.prepare(
    "UPDATE card_payments SET status='refund_pending' WHERE order_id=? AND status='credited'"
  );
  S.refundProviderOk = db.prepare(
    "UPDATE card_payments SET status='refund_provider_ok' WHERE order_id=? AND status='refund_pending'"
  );
  S.markRefunded = db.prepare(
    "UPDATE card_payments SET status='refunded' WHERE order_id=? AND status IN ('refund_pending','refund_provider_ok')"
  );
  S.releaseRefund = db.prepare(
    "UPDATE card_payments SET status='credited' WHERE order_id=? AND status='refund_pending'"
  );
  S.claimIdempotency = db.prepare(
    'INSERT INTO finance_idempotency (event_key, client_id, amount) VALUES (?, ?, ?)'
  );
  S.releaseIdempotency = db.prepare(
    'DELETE FROM finance_idempotency WHERE event_key = ?'
  );
  S.pendingRefundFinalize = db.prepare(
    "SELECT * FROM card_payments WHERE status='refund_provider_ok' ORDER BY id LIMIT ?"
  );
}

function byOrderId(orderId) { return S.byOrderId.get(orderId); }
function byClient(clientId) { return S.byClient.all(clientId); }
// INSERT OR IGNORE: дубль webhook по order_id → changes=0 (идемпотентность).
// promo_code (WP6) — применённый промокод; бонус зачисляется в webhook.
// promoBonusAmount (2026-09-18, DEEP-02) — снимок суммы бонуса на момент заказа.
function insertCreated(orderId, clientId, amount, method, promoCode, promoBonusAmount) {
  return S.insertCreated.run(orderId, clientId, amount, method || null, promoCode || null,
    Number.isFinite(promoBonusAmount) && promoBonusAmount > 0 ? promoBonusAmount : null);
}
function markPaid(orderId, providerPaymentId, rawJson) {
  return S.markPaid.run(providerPaymentId || null, rawJson || null, orderId);
}
// DEEP-17: сохранить paid_at при проверенном подтверждении банка для строк,
// оплаченных до появления колонки (миграция 094). changes=0 — paid_at уже
// есть или заказ не в статусе paid: вымышленное время не приписываем.
function confirmPaidAt(orderId) { return S.confirmPaidAt.run(orderId); }
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
function setPromoStatus(orderId, status) { return S.setPromoStatus.run(status, orderId); }

// 2026-09-18 · DEEP-02: завершение заказа одной транзакцией — статус credited
// плюс (для заказов с промокодом) итоговый статус бонуса.
function completeOrder(orderId, promoStatus) {
  return _db.transaction(() => {
    const r = S.markCredited.run(orderId);
    if (promoStatus) S.setPromoStatus.run(promoStatus, orderId);
    return r;
  })();
}

// 2026-09-18 · DEEP-03 (§14.3): захват возврата ДО внешнего вызова — условный
// переход credited → refund_pending + durable-ключ refund:<order_id> в одной
// транзакции. changes=0 → возврат уже захвачен (гонка) или заказ не credited.
function claimRefund(orderId, clientId, amount) {
  return _db.transaction(() => {
    const r = S.claimRefund.run(orderId);
    if (r.changes > 0) S.claimIdempotency.run(`refund:${orderId}`, clientId, amount);
    return r;
  })();
}
// Банк подтвердил возврат (ответ API или webhook REFUNDED): фаза фиксируется
// ДО ledger-сторно — крах между ними догоняется без повторного вызова банка.
function refundProviderOk(orderId) { return S.refundProviderOk.run(orderId); }
// Сторно применяется (внутри транзакции atomicDebit): refunded только из фаз возврата.
function markRefunded(orderId) { return S.markRefunded.run(orderId); }
// Банк ТОЧНО отклонил возврат (HTTP 4xx): денег не было — откат захвата и ключа,
// повтор разрешён. При неизвестном исходе НЕ вызывать (§14.3: сверка, не retry).
function releaseRefundClaim(orderId) {
  return _db.transaction(() => {
    const r = S.releaseRefund.run(orderId);
    if (r.changes > 0) S.releaseIdempotency.run(`refund:${orderId}`);
    return r;
  })();
}
// Заказы, у которых банк подтвердил возврат, а сторно ещё не записано (крах
// между фазами) — recovery доводит их без сети.
function pendingRefundFinalize(limit) { return S.pendingRefundFinalize.all(limit || 50); }

module.exports = { init, byOrderId, byClient, insertCreated, markPaid, confirmPaidAt, markCredited, markStatus,
  recent, pendingPaid, markRecoveryFailure, attachProvider, setPromoStatus, completeOrder,
  claimRefund, refundProviderOk, markRefunded, releaseRefundClaim, pendingRefundFinalize };
