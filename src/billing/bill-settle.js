// Автоматическое закрытие счетов входящими банковскими платежами.
// Вызывается после успешного atomicCredit во всех точках входа платежа
// (webhook auto-credit, ручной match, обе ветки runTochkaSync).
//
// Правила (от сильного сигнала к слабому):
//   1. Номер счёта в назначении платежа («Оплата по счету №СЧЕТ-202607-b389…»)
//      — регистронезависимо, «е»≡«ё».
//   2. Точное совпадение суммы платежа с суммой счёта (±0.01) — старейший период.
//   3. Жадное покрытие: клиенты платят фиксированную предоплату и платёж часто
//      больше счёта — закрываем старейшие неоплаченные, пока остатка платежа
//      хватает на ПОЛНУЮ сумму счёта (частичная оплата счёт не закрывает).
//
// Статус пишется и в client.bills (память), и напрямую в таблицу bills через
// documentsDb.updateBillStatus — saveClients() использует INSERT OR IGNORE и
// смену статуса существующей строки сам не персистит.

function _norm(s) { return String(s || '').toLowerCase().replace(/ё/g, 'е'); }

function settleBillsOnPayment(client, amount, purpose, deps) {
  const { documentsDb, logActivity, logger } = deps || {};
  if (!client || !(amount > 0)) return [];
  const unpaid = (client.bills || []).filter(b => b && b.status !== 'paid' && (b.amount || 0) > 0)
    .sort((a, b) => String(a.period || '').localeCompare(String(b.period || '')));
  if (!unpaid.length) return [];

  const paidNow = [];
  const markPaid = (bill, rule) => {
    bill.status = 'paid';
    try { documentsDb.updateBillStatus(bill.id, 'paid'); }
    catch (e) { if (logger) logger.error('[BillSettle] updateBillStatus failed:', e.message); }
    paidNow.push(bill);
    try {
      if (logActivity) logActivity('billing', 'info', 'bill_auto_paid', client.name,
        `Счёт ${bill.billNumber || bill.id} (${bill.amount}₽) автоматически отмечен оплаченным (${rule})`,
        { client_id: client.id, bill_id: bill.id, amount: bill.amount, rule });
    } catch (_) { /* лог не должен ломать платёж */ }
  };
  const take = (bill, rule) => {
    markPaid(bill, rule);
    remaining -= bill.amount;
    unpaid.splice(unpaid.indexOf(bill), 1);
  };

  let remaining = amount;
  const p = _norm(purpose);

  // 1. Номер счёта в назначении платежа
  for (const b of [...unpaid]) {
    if (b.billNumber && p && p.includes(_norm(b.billNumber))) take(b, 'по номеру в назначении');
  }
  // 2. Точная сумма (когда назначение не сослалось ни на один счёт)
  if (!paidNow.length) {
    const exact = unpaid.find(b => Math.abs(b.amount - amount) < 0.01);
    if (exact) take(exact, 'точная сумма');
  }
  // 3. Жадное покрытие остатком, старейшие первыми; первый непокрытый — стоп
  //    (не закрываем новый счёт, пока висит старый)
  for (const b of [...unpaid]) {
    if (remaining >= b.amount - 0.01) take(b, 'покрыт платежом');
    else break;
  }
  return paidNow;
}

module.exports = { settleBillsOnPayment };
