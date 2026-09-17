// Автоматическое закрытие счетов входящими банковскими платежами.
// Вызывается после успешного atomicCredit во всех точках входа платежа
// (webhook auto-credit, ручной match, обе ветки runTochkaSync).
//
// Правила (от сильного сигнала к слабому):
//   1. Номер счёта в назначении платежа («Оплата по счету №СЧЕТ-202607-b389…»)
//      — регистронезависимо, «е»≡«ё». Платёж, сославшийся на счёт, но не
//      покрывающий его ПОЛНОСТЬЮ, не закрывает его и НЕ разливается по другим
//      счетам (ни точная сумма, ни жадное правило не срабатывают).
//   2. Точное совпадение суммы платежа с суммой счёта (в копейках) — старейший период.
//   3. Жадное покрытие: клиенты платят фиксированную предоплату и платёж часто
//      больше счёта — закрываем старейшие неоплаченные, пока остатка платежа
//      хватает на ПОЛНУЮ сумму счёта (частичная оплата счёт не закрывает).
//
// Все суммы сравниваются в копейках (Math.round(×100)) — без float-погрешности;
// нечисловой/бесконечный платёж ничего не закрывает.
//
// Статус пишется и в client.bills (память), и напрямую в таблицу bills через
// documentsDb.updateBillStatus (нужна немедленная персистентность без раунда
// saveClients). Память меняется ТОЛЬКО после успешной записи в таблицу:
// ошибка сохранения не оставляет фиктивный 'paid' (DEEP-18-паттерн).
// saveClients() тоже подстраховывает: insertBill — UPSERT по
// status, поэтому память и таблица расхождения не дают.

function _norm(s) { return String(s || '').toLowerCase().replace(/ё/g, 'е'); }
function _kopecks(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

function settleBillsOnPayment(client, amount, purpose, deps) {
  const { documentsDb, logActivity, logger } = deps || {};
  const paymentK = _kopecks(amount);
  if (!client || paymentK == null || paymentK <= 0) return [];
  const unpaid = (client.bills || []).filter(b => b && b.status !== 'paid' && (_kopecks(b.amount) || 0) > 0)
    .sort((a, b) => String(a.period || '').localeCompare(String(b.period || '')) || String(a.id || '').localeCompare(String(b.id || '')));
  if (!unpaid.length) return [];

  const paidNow = [];
  const markPaid = (bill, rule) => {
    try {
      const result = documentsDb.updateBillStatus(bill.id, 'paid');
      if (result && result.changes === 0) throw new Error('bill row was not updated');
    } catch (e) {
      if (logger) logger.error('[BillSettle] updateBillStatus failed:', e.message);
      return false;
    }
    bill.status = 'paid';
    paidNow.push(bill);
    try {
      if (logActivity) logActivity('billing', 'info', 'bill_auto_paid', client.name,
        `Счёт ${bill.billNumber || bill.id} (${bill.amount}₽) автоматически отмечен оплаченным (${rule})`,
        { client_id: client.id, bill_id: bill.id, amount: bill.amount, rule });
    } catch (_) { /* лог не должен ломать платёж */ }
    return true;
  };
  const take = (bill, rule) => {
    if (!markPaid(bill, rule)) return false;
    remainingK -= _kopecks(bill.amount);
    unpaid.splice(unpaid.indexOf(bill), 1);
    return true;
  };

  let remainingK = paymentK;
  const p = _norm(purpose);

  // 1. Номер счёта в назначении платежа
  let referencedUnpaid = false;
  let referencedInsufficient = false;
  for (const b of [...unpaid]) {
    if (!b.billNumber || !p || !p.includes(_norm(b.billNumber))) continue;
    referencedUnpaid = true;
    if (remainingK >= _kopecks(b.amount)) {
      if (!take(b, 'по номеру в назначении')) { referencedInsufficient = true; break; }
    }
    else { referencedInsufficient = true; break; }
  }
  // 2. Точная сумма (когда назначение не сослалось ни на один счёт)
  if (!referencedUnpaid && !paidNow.length) {
    const exact = unpaid.find(b => _kopecks(b.amount) === paymentK);
    if (exact) take(exact, 'точная сумма');
  }
  // 3. Жадное покрытие остатком, старейшие первыми; первый непокрытый — стоп
  //    (не закрываем новый счёт, пока висит старый)
  for (const b of referencedInsufficient ? [] : [...unpaid]) {
    if (remainingK >= _kopecks(b.amount)) {
      if (!take(b, 'покрыт платежом')) break;
    }
    else break;
  }
  return paidNow;
}

module.exports = { settleBillsOnPayment };
