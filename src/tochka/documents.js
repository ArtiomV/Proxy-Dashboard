'use strict';

const logger = require('../logger');

// Russian month names (prepositional case for "в январе")
const MONTH_NAMES_RU = ['январе','феврале','марте','апреле','мае','июне','июле','августе','сентябре','октябре','ноябре','декабре'];
// Accusative case for "за январь"
const MONTH_NAMES_ACC = ['январь','февраль','март','апрель','май','июнь','июль','август','сентябрь','октябрь','ноябрь','декабрь'];

const _round2 = v => Math.round((v || 0) * 100) / 100;

// Russian plural: pluralRu(22, ['модем','модема','модемов']) -> 'модема'
const MODEM_FORMS = ['модем', 'модема', 'модемов'];
const DAY_FORMS = ['день', 'дня', 'дней'];
function pluralRu(n, forms) {
  const n10 = Math.abs(n) % 10, n100 = Math.abs(n) % 100;
  if (n10 === 1 && n100 !== 11) return forms[0];
  if (n10 >= 2 && n10 <= 4 && (n100 < 10 || n100 >= 20)) return forms[1];
  return forms[2];
}

// Tochka rejects any document position with price < 0 or totalAmount < 0
// (HTTP 400 "Input should be greater than or equal to 0"). Our local acts can
// legitimately carry a negative line — a rounding correction (qty×price
// overshot the billed total by a kopeck) or a refund «Корректировка (возврат)».
// Those render fine in our own PDF, but must never reach the bank as a negative
// position. Fold every negative line into the largest positive line so the act
// still sums to exactly what was billed and every submitted position is ≥ 0.
//
// This is the single chokepoint for ALL act submissions (manual create, bulk
// generate, re-issue of a stored act) — whatever produced the items, the bank
// only ever sees non-negative positions.
function sanitizeActPositionsForTochka(items) {
  const list = (items || []).map(it => ({ ...it }));
  const negatives = list.filter(it => (it.amount || 0) < 0 || (it.price || 0) < 0);
  if (negatives.length === 0) return list;

  const positives = list.filter(it => (it.amount || 0) >= 0 && (it.price || 0) >= 0);
  const negSum = _round2(negatives.reduce((s, it) => s + (it.amount || 0), 0)); // ≤ 0

  if (positives.length === 0) {
    // Degenerate: nothing positive to absorb the credit (a pure-refund act).
    // We can't express that as a positive position — ship a single zero line
    // and let the operator issue a proper credit note. Better than a 400.
    logger.warn('[Act] all positions non-positive — cannot build a valid Tochka act, shipping zero line');
    return [{ name: (list[0] && list[0].name) || 'Услуги мобильных прокси', quantity: 1, unit: 'услуга', price: 0, amount: 0 }];
  }

  // Apply the (negative) sum to the biggest positive line.
  let target = positives[0];
  for (const it of positives) if ((it.amount || 0) > (target.amount || 0)) target = it;
  const newAmount = Math.max(0, _round2((target.amount || 0) + negSum));
  target.amount = newAmount;
  const q = target.quantity || 1;
  target.price = q > 0 ? _round2(newAmount / q) : newAmount;
  return positives;
}

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

  // ---- Per-modem tariff ----
  if (modemCharges.length > 0) {
    const totalCost = round2(modemCharges.reduce((s, e) => s + (e.cost || 0), 0));

    // Group the billed days by their modem count so the act reflects the real
    // composition — e.g. "аренда 22 модемов × 30 дн" + "аренда 23 модемов × 1 дн"
    // — instead of a single averaged line with a fractional quantity and a
    // reverse-derived price. Each group's amount is the exact sum of its daily
    // charges, so the lines add up to exactly what was billed.
    const groups = new Map(); // modemCount -> { days, cost }
    let countsKnown = true;
    for (const e of modemCharges) {
      let mc = e.modem_count;
      if (mc == null) {
        // Legacy rows didn't store the count — back-derive it.
        const ppm = e.price_per_unit || client.price || 0;
        const dim = e.days_in_month || 30;
        mc = (ppm > 0 && dim > 0) ? Math.round((e.cost || 0) * dim / ppm) : null;
      }
      if (mc == null || mc <= 0) { countsKnown = false; break; }
      const g = groups.get(mc) || { days: 0, cost: 0 };
      g.days += 1;
      g.cost = round2(g.cost + (e.cost || 0));
      groups.set(mc, g);
    }

    if (countsKnown && groups.size >= 1 && groups.size <= 6) {
      // One line per distinct count, longest period first.
      const counts = [...groups.keys()].sort((a, b) => groups.get(b).days - groups.get(a).days || b - a);
      for (const count of counts) {
        const g = groups.get(count);
        const amount = round2(g.cost);
        // Per-modem cost for this group's days (price × qty ≈ amount within
        // Tochka's tolerance; amount itself is exact so the lines sum true).
        const price = count > 0 ? round2(amount / count) : amount;
        actItems.push({
          name: `Услуги мобильных прокси (аренда ${count} ${pluralRu(count, MODEM_FORMS)} × ${g.days} ${pluralRu(g.days, DAY_FORMS)} за ${periodLabel})`,
          quantity: count,
          unit: 'шт',
          price,
          amount
        });
      }
    } else {
      // Fallback: count unknown (legacy data) or too many distinct counts to
      // list — collapse to one averaged line. amount = exact billed total
      // (like the per-GB branch); no negative rounding-correction line.
      let totalModemDays = 0, billedDays = 0;
      for (const e of modemCharges) {
        const ppm = e.price_per_unit || client.price || 0;
        const dim = e.days_in_month || 30;
        let mc = e.modem_count;
        if (mc == null && ppm > 0 && dim > 0) mc = (e.cost || 0) * dim / ppm;
        totalModemDays += mc || 0;
        billedDays++;
      }
      let qty = round2(billedDays > 0 ? totalModemDays / billedDays : 0);
      if (!qty || qty <= 0) qty = 1;
      const price = qty > 0 ? round2(totalCost / qty) : 0;
      actItems.push({
        name: `Услуги мобильных прокси (аренда модемов за ${periodLabel})`,
        quantity: qty,
        unit: 'шт',
        price,
        amount: totalCost
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
  const isIP = client.inn && client.inn.length === 12;

  // Fold any negative line (rounding correction / refund) into a positive
  // position — Tochka rejects positions with price/totalAmount < 0.
  const positions = sanitizeActPositionsForTochka(actItems);
  const totalAmount = positions.reduce((s, i) => s + (i.amount || 0), 0);

  // Build full counterparty name with address (ИНН/КПП добавляется Точкой автоматически)
  let secondSideName = client.legalName || client.name;
  if (client.address) {
    secondSideName += `, ${client.address}`;
  }

  // Build Act object
  // NB: поле "Основание" не поддерживается API Точки для закрывающих документов — заполняется вручную
  const act = {
    Positions: positions.map((item, idx) => ({
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
  calculateMonthlyBillAmount,
  sanitizeActPositionsForTochka
};
