'use strict';
//
// src/payments/tochka-acquiring.js — B2C Э4 (WP3): интернет-эквайринг Точки.
//
// Источник контракта — официальная OpenAPI-спецификация Точка.API
// (developers.tochka.com → «Скачать OpenAPI спецификацию», v1.93.0-stable)
// + страницы «Платёжные ссылки» и «Вебхуки»:
//   • POST /uapi/acquiring/v1.0/payments_with_receipt — платёжная ссылка с
//     фискализацией (54-ФЗ: Client.email + Items[]). paymentMode: card|sbp
//     (СБП — отдельный метод того же платежа). paymentLinkId (≤45 симв.) —
//     наш order_id, по нему вебхук отдаёт заказ обратно.
//   • Ответ: Data.operationId (provider_payment_id) + Data.paymentLink
//     (confirmation_url — редирект клиента на страницу оплаты).
//   • POST /uapi/acquiring/v1.0/payments/{operationId}/refund — возврат
//     (только для платежей в APPROVED; полный или частичный, ≤ суммы).
//   • Вебхук acquiringInternetPayment: тело — «голая» строка JWT (RS256,
//     Content-Type: text/plain), поля: paymentLinkId, operationId, status
//     (APPROVED — деньги списаны; AUTHORIZED — только двухэтапная, у нас
//     выключена; EXPIRED; REFUNDED*), paymentType (card|sbp), amount (строка).
//     Подпись проверяется по JWKS Точки — тем же verifyJwtSignature, что и
//     банковский webhook (src/tochka/jwt.js).
//
// ⚠ МАППИНГ ПОЛЕЙ ТОЧКИ — ТОЛЬКО В ЭТОМ ФАЙЛЕ. Боевых кредов пока нет
// (заявка в банке): когда придут, сверяем/правим поля здесь, роуты и
// provider.js не трогаем.

const ACQ_PATH = '/uapi/acquiring/v1.0';

function create(deps) {
  const { getSetting, logger, tochkaRequest, verifyJwtSignature } = deps;

  // Конфиг из настроек (kv; jwt — SENSITIVE, enc1:). Читаем на каждый вызов —
  // админ может поменять ключи без рестарта.
  function _config() {
    return {
      jwt:          getSetting('tochka_acq_jwt', ''),
      customerCode: getSetting('tochka_acq_customer_code', ''),
      merchantId:   getSetting('tochka_acq_merchant_id', ''),
      taxSystem:    getSetting('tochka_acq_tax_system', ''),
    };
  }

  function _configured(cfg) {
    return !!(cfg.jwt && cfg.customerCode);
  }

  // ── create_payment ───────────────────────────────────────────────────────
  // Платёжная ссылка с чеком (54-ФЗ). Предмет — «доступ к ПО» (service,
  // НДС «none», полная оплата). Бросает Error при любой не-200 / битом ответе.
  async function create_payment({ order_id, amount, method, receipt_email, return_url, fail_url }) {
    const cfg = _config();
    if (!_configured(cfg)) throw new Error('tochka acquiring not configured (jwt/customerCode)');
    const Data = {
      customerCode: cfg.customerCode,
      amount: Math.round(amount * 100) / 100,
      purpose: ('Доступ к ПО, пополнение баланса ' + order_id).slice(0, 140),
      redirectUrl: return_url,
      failRedirectUrl: fail_url || return_url,
      paymentMode: [method],           // 'card' | 'sbp' — СБП = тот же платёж
      paymentLinkId: order_id,         // уникальный номер заказа (≤45 симв.)
      ttl: 1440,                       // жизнь ссылки, минут (дефолт банка 7 дн; нам хватит суток)
      Client: { email: receipt_email },
      Items: [{
        name: 'Доступ к ПО (пополнение баланса)',
        amount: Math.round(amount * 100) / 100,
        quantity: 1,
        vatType: 'none',
        paymentMethod: 'full_payment',
        paymentObject: 'service',
      }],
    };
    if (cfg.merchantId) Data.merchantId = cfg.merchantId;   // обязателен при нескольких точках
    if (cfg.taxSystem) Data.taxSystemCode = cfg.taxSystem;  // osn|usn_income|...; пусто — не шлём

    const resp = await tochkaRequest(cfg, 'POST', ACQ_PATH + '/payments_with_receipt', { Data });
    const d = resp && resp.data && resp.data.Data;
    if (resp.status !== 200 || !d || !d.operationId || !d.paymentLink) {
      const msg = resp && resp.data && (resp.data.message || JSON.stringify(resp.data).slice(0, 200));
      throw new Error('tochka create_payment failed (http ' + (resp && resp.status) + '): ' + (msg || 'no Data.operationId/paymentLink'));
    }
    return { confirmation_url: d.paymentLink, provider_payment_id: d.operationId };
  }

  // ── verify_webhook ───────────────────────────────────────────────────────
  // STRICT: подпись не сошлась / JWKS недоступен / не JWT → ok:false (роут → 401).
  // Никакого «мягкого» режима, как у банковского webhook, — здесь зачисление
  // денег напрямую по вебхуку, без сверки с выпиской.
  async function verify_webhook(headers, rawBody) {
    const cfg = _config();
    const token = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8').trim() : String(rawBody || '').trim();
    if (!token) return { ok: false, reason: 'empty_body' };
    let verified, payload, reason;
    try {
      ({ verified, payload, reason } = await verifyJwtSignature(token, cfg.jwt));
    } catch (e) {
      logger.warn('[Acquiring webhook] verify error: ' + e.message);
      return { ok: false, reason: 'verification_error' };
    }
    if (!verified || !payload) return { ok: false, reason: reason || 'not_verified' };
    if (payload.webhookType !== 'acquiringInternetPayment') {
      return { ok: false, reason: 'wrong_type:' + (payload.webhookType || 'none') };
    }
    // Маппинг статусов банка → внутренние. Деньги — только по APPROVED
    // (AUTHORIZED = холд двухэтапной оплаты, у нас preAuthorization выключен).
    const st = String(payload.status || '');
    const status = st === 'APPROVED' ? 'paid'
      : (st === 'EXPIRED' || st === 'DECLINED') ? 'failed'
      : st.startsWith('REFUNDED') ? 'refunded'
      : 'other';
    return {
      ok: true,
      order_id: payload.paymentLinkId || null,
      status,
      provider_status: st,
      provider_payment_id: payload.operationId || null,
      method: payload.paymentType || null,          // card|sbp
      amount: parseFloat(payload.amount) || null,   // в вебхуке amount — строка
      raw: payload,
    };
  }

  // ── refund ───────────────────────────────────────────────────────────────
  // Возврат по operationId (только платежи в APPROVED). Бросает Error —
  // роут НЕ сторнирует ledger, если провайдер не подтвердил.
  async function refund(provider_payment_id, amount) {
    const cfg = _config();
    if (!_configured(cfg)) throw new Error('tochka acquiring not configured (jwt/customerCode)');
    if (!provider_payment_id) throw new Error('refund: no provider_payment_id');
    const resp = await tochkaRequest(cfg, 'POST',
      ACQ_PATH + '/payments/' + encodeURIComponent(provider_payment_id) + '/refund',
      { Data: { amount: Math.round(amount * 100) / 100 } });
    const d = resp && resp.data && resp.data.Data;
    if (resp.status !== 200 || !d) {
      const msg = resp && resp.data && (resp.data.message || JSON.stringify(resp.data).slice(0, 200));
      throw new Error('tochka refund failed (http ' + (resp && resp.status) + '): ' + (msg || 'no Data'));
    }
    return { ok: true, orderId: d.orderId || null, isRefund: d.isRefund === true };
  }

  return { name: 'tochka', create_payment, verify_webhook, refund };
}

module.exports = { create };
