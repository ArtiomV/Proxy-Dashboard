'use strict';
//
// src/jobs/bill-status-sync.js — сверка статуса счетов напрямую с Точкой.
//
// Зачем: bills.status ставится матчингом входящих платежей (src/billing/bill-settle.js).
// Матч не срабатывает, когда платёж пришёл от третьего лица, разбит на части или
// назначение не сослалось на счёт — счёт висит неоплаченным, хотя деньги в банке есть.
// Этот джоб спрашивает у банка напрямую и закрывает такие счета.
//
// Аудит API Точки 16.07.2026: payment-status — ЕДИНСТВЕННЫЙ читающий метод по
// документам, который у них реализован. Всё остальное (метаданные счёта, статус и
// факт подписи акта, списки) отвечает 501 Not Implemented; ЭДО-неймспейса нет (404).
// Сумму метод не отдаёт — только статус, поэтому сверяем именно статус, не суммы.
//
// Направление одностороннее: unpaid → paid. Обратно не откатываем — счёт мог быть
// закрыт вручную или наличными мимо банка, и мнение Точки такой платёж не отменяет.
// Балансы не трогаем: деньги на баланс зачисляет платёжный тракт (bank_payment),
// а этот джоб только про статус документа.

// Перечня значений paymentStatus в документации Точки нет, наблюдали только
// payment_paid. Поэтому «оплачен» = точное совпадение, всё остальное считаем
// неоплаченным и логируем незнакомые значения — так новый статус проявит себя
// в логах, а не превратит счёт в оплаченный по ошибке.
const PAID_STATUS = 'payment_paid';

function create(deps) {
  const { logger, clients, saveClients, logActivity, documentsDb, getTochkaConfig, tochkaRequest } = deps;

  async function syncBillStatuses() {
    const tochkaConfig = getTochkaConfig();
    if (!tochkaConfig.jwt || !tochkaConfig.customerCode) return { checked: 0, paid: 0 };

    // Счёт без tochkaBillId создан только у нас — в банке его нет, спрашивать нечего.
    const pending = [];
    for (const client of clients) {
      for (const bill of (client.bills || [])) {
        if (bill && bill.tochkaBillId && bill.status !== 'paid') pending.push({ client, bill });
      }
    }
    if (!pending.length) return { checked: 0, paid: 0 };

    let checked = 0, paid = 0;
    for (const { client, bill } of pending) {
      try {
        const path = `/uapi/invoice/v1.0/bills/${tochkaConfig.customerCode}/${bill.tochkaBillId}/payment-status`;
        const res = await tochkaRequest('GET', path);
        checked++;
        if (res.status !== 200) {
          logger.warn(`[BillStatusSync] ${bill.billNumber || bill.id}: HTTP ${res.status}`);
          continue;
        }
        const status = res.data?.Data?.paymentStatus;
        if (status === PAID_STATUS) {
          bill.status = 'paid';
          // saveClients() делает INSERT OR IGNORE и смену статуса не персистит —
          // пишем в таблицу напрямую (та же грабля, что в bill-settle.js).
          documentsDb.updateBillStatus(bill.id, 'paid');
          paid++;
          logger.info(`[BillStatusSync] ${client.name}: счёт ${bill.billNumber || bill.id} (${bill.amount}₽) оплачен по данным Точки`);
          logActivity('billing', 'info', 'bill_auto_paid', client.name,
            `Счёт ${bill.billNumber || bill.id} (${bill.amount}₽) отмечен оплаченным по данным банка (сверка с Точкой)`,
            { client_id: client.id, bill_id: bill.id, amount: bill.amount, rule: 'сверка payment-status' });
        } else if (status && status !== 'payment_pending') {
          logger.info(`[BillStatusSync] ${bill.billNumber || bill.id}: неизвестный paymentStatus='${status}' — счёт оставлен неоплаченным`);
        }
      } catch (e) {
        logger.error(`[BillStatusSync] ${bill.billNumber || bill.id}: ${e.message}`);
      }
    }

    if (paid > 0) saveClients(clients);
    logger.info(`[BillStatusSync] Проверено ${checked} счетов, отмечено оплаченными: ${paid}`);
    return { checked, paid };
  }

  return { syncBillStatuses };
}

module.exports = { create, PAID_STATUS };
