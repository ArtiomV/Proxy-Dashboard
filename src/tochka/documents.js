'use strict';

const logger = require('../logger');

// Russian month names (prepositional case for "в январе")
const MONTH_NAMES_RU = ['январе','феврале','марте','апреле','мае','июне','июле','августе','сентябре','октябре','ноябре','декабре'];
// Accusative case for "за январь"
const MONTH_NAMES_ACC = ['январь','февраль','март','апрель','май','июнь','июль','август','сентябрь','октябрь','ноябрь','декабрь'];

// Helper: build act line items from billing ledger entries.
// Invariants enforced for every line item:
//   amount === round(quantity × price, 2)
// Without this Tochka renders inconsistent positions (qty=1 × price=4250
// = "totalAmount=43816" — visually nonsense for the client).
// Stage 4: receives `getLedger(clientId) -> entries[]` getter instead of the
// old in-memory `billingLedger` object. server.js wires this to
// `ledgerDb.listByClient` so the helper always reads fresh DB rows.
function buildActItemsFromLedger(client, period, getLedger) {
  const ledgerEntries = getLedger(client.id) || [];
  const monthEntries  = ledgerEntries.filter(e => (e.type === 'charge' || e.type === 'correction') && e.date && e.date.startsWith(period));
  const monthCharges    = monthEntries.filter(e => e.type === 'charge');
  const monthCorrections = monthEntries.filter(e => e.type === 'correction');

  // Signed correction amount: debit=positive expense, credit=negative (refund)
  const correctionCost = Math.round(monthCorrections.reduce((sum, e) => {
    if (e.balance_before != null && e.balance_after != null) return sum + (e.balance_before - e.balance_after);
    return sum + (e.cost || e.amount || 0);
  }, 0) * 100) / 100;

  const modemCharges = monthCharges.filter(e => e.billing_type === 'per_modem');
  const gbCharges    = monthCharges.filter(e => e.billing_type !== 'per_modem');

  const round2 = v => Math.round(v * 100) / 100;
  const round4 = v => Math.round(v * 10000) / 10000;
  const actItems = [];

  // "за апрель 2026" (винительный падеж)
  const [yyyy, mm] = period.split('-').map(Number);
  const periodLabel = `${MONTH_NAMES_ACC[mm - 1] || ''} ${yyyy}`;

  // ---- Per-GB tariff: одна строка ----
  if (gbCharges.length > 0) {
    const totalCost = round2(gbCharges.reduce((s, e) => s + (e.cost     || 0), 0));
    const totalGb   = round2(gbCharges.reduce((s, e) => s + (e.delta_gb || 0), 0));
    // qty = реальные ГБ из ledger; price = ставка такая, чтобы qty × price = amount.
    // Если по какой-то причине нет delta_gb — back-derive qty из cost.
    const ppgFromLedger = gbCharges.find(e => e.price_per_unit > 0)?.price_per_unit || client.price || 23;
    const qty   = totalGb > 0 ? totalGb : round4(totalCost / ppgFromLedger);
    const price = qty > 0 ? round4(totalCost / qty) : round2(ppgFromLedger);
    actItems.push({
      name: `Услуги мобильных прокси (трафик за ${periodLabel})`,
      quantity: qty,
      unit: 'ГБ',
      price,
      amount: totalCost
    });
  }

  // ---- Per-modem tariff: одна строка ----
  if (modemCharges.length > 0) {
    const totalCost = round2(modemCharges.reduce((s, e) => s + (e.cost || 0), 0));

    // Находим средневзвешенное кол-во модемов за биллинговые дни.
    // Для каждого charge: mc = cost × daysInMonth / price (если в ledger не сохранено).
    let totalModemDays = 0;
    let billedDays = 0;
    const ppmSamples = [];
    const dimSamples = [];
    for (const e of modemCharges) {
      const ppm = e.price_per_unit || client.price || 0;
      const dim = e.days_in_month  || 30;
      let mc = e.modem_count;
      if (mc == null && ppm > 0 && dim > 0) mc = (e.cost || 0) * dim / ppm;
      totalModemDays += mc || 0;
      billedDays++;
      if (ppm > 0) ppmSamples.push(ppm);
      if (dim > 0) dimSamples.push(dim);
    }
    const avgModems = billedDays > 0 ? totalModemDays / billedDays : 0;
    // qty = округлённое среднее число модемов
    // price = totalCost / qty — реальная "стоимость за модем за период биллинга"
    // (учитывает что биллинг шёл не весь месяц).
    // Guard against div-by-zero: if we have charges but somehow avgModems
    // rounds to 0 (e.g. legacy data with all modem_count=null and bad ppm),
    // fall back to qty=1 + full cost as price so the act still validates.
    let qty = round2(avgModems);
    if (!qty || qty <= 0) qty = 1;
    // Round directly to 2 decimals (Tochka enforces ≤2 anyway). Reconcile
    // amount to qty × price so the invariant qty×price ≈ amount holds within
    // the 0.05 tolerance Tochka tolerates — previously round4(price) then
    // round2 in post-processing could drift up to 0.5 RUB on the act.
    const price = qty > 0 ? round2(totalCost / qty) : 0;
    const amount = round2(qty * price);
    actItems.push({
      name: `Услуги мобильных прокси (аренда модемов за ${periodLabel})`,
      quantity: qty,
      unit: 'шт',
      price,
      amount
    });
    // If rounding lost a kopeck or two from totalCost, surface it as a
    // correction line so the act sums exactly to what was billed.
    const drift = round2(totalCost - amount);
    if (Math.abs(drift) >= 0.01) {
      actItems.push({
        name: 'Корректировка округления',
        quantity: 1,
        unit: 'услуга',
        price: drift,
        amount: drift
      });
    }
  }

  // Corrections — show as separate line, signed
  if (correctionCost !== 0) {
    actItems.push({
      name: correctionCost > 0 ? 'Корректировка (доначисление)' : 'Корректировка (возврат)',
      quantity: 1,
      unit: 'услуга',
      price: correctionCost,
      amount: correctionCost
    });
  }

  // Empty fallback (no charges this month)
  if (actItems.length === 0) {
    actItems.push({
      name: 'Услуги мобильных прокси',
      quantity: 1,
      unit: 'мес',
      price: 0,
      amount: 0
    });
  }

  // Tochka API requires price and amount to have ≤2 decimal places, and
  // quantity ≤4. Enforce here so the invariant qty × price ≈ amount survives
  // round-tripping through the bank.
  for (const it of actItems) {
    it.price    = Math.round((it.price    || 0) * 100) / 100;
    it.amount   = Math.round((it.amount   || 0) * 100) / 100;
    it.quantity = Math.round((it.quantity || 0) * 10000) / 10000;
    const expected = round2((it.quantity || 0) * (it.price || 0));
    if (Math.abs(expected - it.amount) > 0.05) {
      logger.warn(`[Act] math mismatch on item "${it.name}": qty=${it.quantity} × price=${it.price} = ${expected} but amount=${it.amount}`);
    }
  }

  const totalCost = round2(actItems.reduce((s, i) => s + (i.amount || 0), 0));
  return { actItems, totalCost, monthCharges: monthEntries };
}

// Helper: build Tochka closing document (act) request body
function buildTochkaActBody(tochkaConfig, client, period, actItems, actNumber) {
  const [year, month] = period.split('-').map(Number);
  const lastDay = new Date(year, month, 0).getDate();
  const monthNameRu = MONTH_NAMES_RU[month - 1] || '';
  const serviceName = `Услуги по обеспечению подключения к прокси-серверу в ${monthNameRu} ${year}г`;
  const totalAmount = actItems.reduce((s, i) => s + (i.amount || 0), 0);
  const isIP = client.inn && client.inn.length === 12;

  // Build full counterparty name with address (ИНН/КПП добавляется Точкой автоматически)
  let secondSideName = client.legalName || client.name;
  if (client.address) {
    secondSideName += `, ${client.address}`;
  }

  // Build Act object
  // NB: поле "Основание" не поддерживается API Точки для закрывающих документов — заполняется вручную
  const act = {
    Positions: actItems.map((item, idx) => ({
      positionName: serviceName,
      quantity: item.quantity || 1,
      unitCode: item.unit === 'ГБ' ? 'усл.ед.' : (item.unit === 'шт' ? 'шт.' : 'услуга.'),
      totalAmount: item.amount || 0,
      ndsKind: 'without_nds',
      price: item.price || 0,
      positionNumber: idx + 1
    })),
    actDate: `${period}-${String(lastDay).padStart(2, '0')}`,
    number: actNumber,
    totalAmount: Math.round(totalAmount * 100) / 100
  };

  return {
    Data: {
      accountId: tochkaConfig.accountId,
      customerCode: tochkaConfig.customerCode,
      SecondSide: {
        secondSideType: isIP ? 'individual_entrepreneur' : 'legal_entity',
        type: isIP ? 'ip' : 'company',
        inn: client.inn || '',
        taxCode: client.inn || '',
        kpp: client.kpp || '',
        name: secondSideName
      },
      Content: {
        Act: act
      }
    }
  };
}

// Helper: build Tochka bill (счёт на оплату) request body
function buildTochkaBillBody(tochkaConfig, client, amount, billNumber, billDate) {
  const isIP = client.inn && client.inn.length === 12;

  // Build full counterparty name with address (ИНН/КПП добавляется Точкой автоматически)
  let secondSideName = client.legalName || client.name;
  if (client.address) {
    secondSideName += `, ${client.address}`;
  }

  return {
    Data: {
      accountId: tochkaConfig.accountId,
      customerCode: tochkaConfig.customerCode,
      SecondSide: {
        secondSideType: isIP ? 'individual_entrepreneur' : 'legal_entity',
        type: isIP ? 'ip' : 'company',
        inn: client.inn || '',
        taxCode: client.inn || '',
        kpp: client.kpp || '',
        name: secondSideName
      },
      Content: {
        Invoice: {
          Positions: [{
            positionName: 'Предоплата за услуги мобильных прокси',
            quantity: 1,
            unitCode: 'услуга.',
            totalAmount: amount,
            ndsKind: 'without_nds',
            price: amount,
            positionNumber: 1
          }],
          invoiceDate: billDate,
          number: billNumber,
          totalAmount: amount
        }
      }
    }
  };
}

// Helper: calculate monthly bill amount for a client
function calculateMonthlyBillAmount(client, cachedResults, getLedger) {
  let baseAmount = 0;

  if (client.billingType === 'per_modem') {
    // Fixed: price * modem count
    let modemCount = 0;
    if (cachedResults && cachedResults.length > 0) {
      for (const data of cachedResults) {
        if (typeof data.bw === 'object') {
          for (const [portId, b] of Object.entries(data.bw)) {
            if (b.portName === client.portName) modemCount++;
          }
        }
      }
    }
    if (modemCount === 0) {
      logger.warn(`[Bill] Cannot determine modemCount for ${client.name}, skipping`);
      return 0;
    }
    baseAmount = client.price * modemCount;
  } else {
    // per_gb: sum charges from previous month
    const now = new Date();
    const prevMonth = new Date(now);
    prevMonth.setMonth(prevMonth.getMonth() - 1);
    const prevPeriod = prevMonth.toISOString().slice(0, 7); // YYYY-MM

    const ledgerEntries = getLedger(client.id) || [];
    const monthCharges = ledgerEntries.filter(e => e.type === 'charge' && e.date && e.date.startsWith(prevPeriod));
    baseAmount = monthCharges.reduce((sum, e) => sum + (e.cost || 0), 0);

    if (baseAmount <= 0) return 0; // no charges last month — skip
  }

  // Add negative balance (debt) to the amount
  let totalAmount = baseAmount;
  if ((client.balance || 0) < 0) {
    totalAmount += Math.abs(client.balance);
  }

  // For per_gb: round up to nearest 10,000₽
  if (client.billingType !== 'per_modem') {
    totalAmount = Math.ceil(totalAmount / 10000) * 10000;
  }

  return Math.round(totalAmount * 100) / 100;
}

module.exports = {
  MONTH_NAMES_RU,
  MONTH_NAMES_ACC,
  buildActItemsFromLedger,
  buildTochkaActBody,
  buildTochkaBillBody,
  calculateMonthlyBillAmount
};
