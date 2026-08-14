'use strict';
//
// src/payments/provider.js — B2C Э4 (WP3): тонкая абстракция эквайринга.
//
// Единый интерфейс провайдера (реализация выбирается настройкой
// retail_acquiring_provider; сейчас — только 'tochka', ЮKassa добавится
// файлом yookassa.js без переписывания роутов):
//
//   create_payment({ order_id, amount, method: 'card'|'sbp', receipt_email, return_url })
//     → { confirmation_url, provider_payment_id }     (ошибка — throw)
//   verify_webhook(headers, rawBody)
//     → { ok, order_id, status, provider_payment_id, method, raw }
//     STRICT: подпись невалидна/не проверена → { ok: false }, НЕ мягкий режим.
//     status: 'paid' | 'failed' | 'other' (маппинг статусов провайдера).
//   refund(provider_payment_id, amount)
//     → { ok }                                       (ошибка — throw)
//
// create() возвращает null, если провайдер не выбран/не настроен —
// роут отвечает 503 «эквайринг не подключён».

const PROVIDERS = {
  tochka: './tochka-acquiring',
  // yookassa: './yookassa' — позже (кредов нет; интерфейс выше — контракт).
};

function create(deps) {
  const name = String(deps.getSetting('retail_acquiring_provider', '') || '').trim();
  if (!name || name === 'none') return null;
  const mod = PROVIDERS[name];
  if (!mod) {
    deps.logger.warn('[Payments] Неизвестный провайдер эквайринга: ' + name);
    return null;
  }
  return require(mod).create(deps);
}

module.exports = { create };
