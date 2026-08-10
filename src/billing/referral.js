'use strict';

// Реферальная программа (решение Р6): комиссия 10% от платежа реферала
// с любого канала зачисления — ручной платёж, webhook Точки, statement-sync
// (Р22: sync-путь раньше пропускал начисление — исправлено).
// Начисление — в транзакции atomicCredit при зачислении платежа
// (opts.referral, src/billing/atomic.js); сторно — при payment_reversal
// (та же дельта со знаком минус). Без ретро-доначисления (Р28).
const REFERRAL_PCT = 0.10;

// Комиссия с суммы платежа, округление до копеек.
function referralCommission(amount) {
  return Math.round(amount * REFERRAL_PCT * 100) / 100;
}

module.exports = { REFERRAL_PCT, referralCommission };
