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

  // ---- Per-GB tariff ----
  if (gbCharges.length > 0) {
    // B1 (Р14/Р32): смена цены mid-month разбивает акт на непрерывные периоды
    // одной цены. Данные — price_per_unit каждого списания в ledger (пишется
    // DailyBilling); у legacy-строк без неё берём текущий client.price (точная
    // ретро-разбивка возможна только по строкам с price_per_unit). Одна цена
    // за весь месяц → одна строка, как раньше.
    const effPrice = e => (e.price_per_unit > 0 ? e.price_per_unit : (client.price || 0));
    const sorted = gbCharges.slice().sort((a, b) => (a.date || '').localeCompare(b.date || ''));
    const segments = [];
    for (const e of sorted) {
      const p = effPrice(e);
      const last = segments[segments.length - 1];
      if (last && last.price === p) {
        last.cost = round2(last.cost + (e.cost || 0));
        last.gb = round2(last.gb + (e.delta_gb || 0));
        last.end = e.date || last.end;
      } else {
        segments.push({ price: p, cost: round2(e.cost || 0), gb: round2(e.delta_gb || 0), start: e.date || '', end: e.date || '' });
      }
    }

    if (segments.length === 1) {
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
    } else {
      // Несколько цен: строка на каждый непрерывный период. amount = точная
      // сумма списаний периода; price — реальная ставка из ledger.
      const fmtD = d => (d ? `${d.slice(8, 10)}.${d.slice(5, 7)}` : '');
      for (const seg of segments) {
        const qty   = seg.gb > 0 ? seg.gb : round4(seg.cost / (seg.price || 1));
        const price = seg.price > 0 ? round2(seg.price) : (qty > 0 ? round4(seg.cost / qty) : 0);
        actItems.push({
          name: `Услуги мобильных прокси (трафик ${fmtD(seg.start)}–${fmtD(seg.end)} по ${price} ₽/ГБ за ${periodLabel})`,
          quantity: qty,
          unit: 'ГБ',
          price,
          amount: seg.cost
        });
      }
    }
  }

  // ---- Per-modem tariff ----
  if (modemCharges.length > 0) {
    const totalCost = round2(modemCharges.reduce((s, e) => s + (e.cost || 0), 0));

    // Group the billed days by their modem count AND price (B1, Р14/Р32: смена
    // цены mid-month — акт разбивается по ценам, не только по количеству) so
    // the act reflects the real composition — e.g. "аренда 22 модемов × 30 дн"
    // + "аренда 23 модемов × 1 дн" — instead of a single averaged line with a
    // fractional quantity and a reverse-derived price. Each group's amount is
    // the exact sum of its daily charges, so the lines add up to exactly what
    // was billed.
    const groups = new Map(); // `${modemCount}|${pricePerMonth}` -> { count, ppm, days, cost }
    let countsKnown = true;
    for (const e of modemCharges) {
      const ppm = e.price_per_unit || client.price || 0;
      let mc = e.modem_count;
      if (mc == null) {
        // Legacy rows didn't store the count — back-derive it.
        const dim = e.days_in_month || 30;
        mc = (ppm > 0 && dim > 0) ? Math.round((e.cost || 0) * dim / ppm) : null;
      }
      if (mc == null || mc <= 0) { countsKnown = false; break; }
      const key = `${mc}|${ppm}`;
      const g = groups.get(key) || { count: mc, ppm, days: 0, cost: 0 };
      g.days += 1;
      g.cost = round2(g.cost + (e.cost || 0));
      groups.set(key, g);
    }

    if (countsKnown && groups.size >= 1 && groups.size <= 6) {
      // One line per distinct count+price, longest period first. Цену в
      // название добавляем только когда их за месяц было несколько — при
      // одной цене формат строки не меняется.
      const distinctPrices = new Set([...groups.values()].map(g => g.ppm)).size;
      const sorted = [...groups.values()].sort((a, b) => b.days - a.days || b.count - a.count || b.ppm - a.ppm);
      for (const g of sorted) {
        const amount = round2(g.cost);
        // Per-modem cost for this group's days (price × qty ≈ amount within
        // Tochka's tolerance; amount itself is exact so the lines sum true).
        const price = g.count > 0 ? round2(amount / g.count) : amount;
        const priceNote = distinctPrices > 1 ? ` по ${round2(g.ppm)} ₽/мес` : '';
        actItems.push({
          name: `Услуги мобильных прокси (аренда ${g.count} ${pluralRu(g.count, MODEM_FORMS)} × ${g.days} ${pluralRu(g.days, DAY_FORMS)}${priceNote} за ${periodLabel})`,
          quantity: g.count,
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

// Helper: calculate monthly bill amount for a client (+ формула расчёта для UI).
// calculateMonthlyBillDetails → { amount, formula } — formula хранится в счёте
// и показывается на странице актов (2026-08-02: «из чего исходил алгоритм»).
function calculateMonthlyBillDetails(client, cachedResults, getLedger) {
  let baseAmount = 0;
  let formula = null;

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
      return { amount: 0, formula: null };
    }
    baseAmount = client.price * modemCount;
    formula = { kind: 'per_modem', modem_count: modemCount, price: client.price || 0 };
  } else {
    // per_gb: base = max(previous month's charges, current-month run-rate
    // forecast). 2026-08-02: the old prev-month-only rule under-billed
    // fast-growing clients (БА: счёт 380k по июлю, а август шёл к ~620k —
    // клиент уходил в минус в середине месяца).
    const now = new Date();
    const prevMonth = new Date(now);
    prevMonth.setMonth(prevMonth.getMonth() - 1);
    const prevPeriod = prevMonth.toISOString().slice(0, 7); // YYYY-MM

    const ledgerEntries = getLedger(client.id) || [];
    const monthCharges = ledgerEntries.filter(e => e.type === 'charge' && e.date && e.date.startsWith(prevPeriod));
    const prevAmount = monthCharges.reduce((sum, e) => sum + (e.cost || 0), 0);

    // Run-rate forecast (2026-08-02, по уточнённой формуле оператора):
    // среднесуточное потребление за ПОСЛЕДНИЕ 7 дней (по биллингу) × дней в
    // месяце × тариф. Без коэффициента-маржи — окно в 7 дней само по себе
    // сглаживает дневной шум, а среднее за месяц-к-дате занижало рост.
    const days7 = [];
    for (let i = 1; i <= 7; i++) days7.push(new Date(now.getTime() - i * 86400000).toISOString().slice(0, 10));
    const last7Gb = ledgerEntries
      .filter(e => e.type === 'charge' && e.date && days7.includes(e.date))
      .reduce((sum, e) => sum + (e.delta_gb || 0), 0);
    const avgDailyGb = last7Gb / 7;
    const daysInMonth = new Date(now.getUTCFullYear(), now.getUTCMonth() + 1, 0).getDate();
    const price = client.price || 0;
    const forecastAmount = (avgDailyGb > 0 && price > 0)
      ? avgDailyGb * daysInMonth * price : 0;

    baseAmount = Math.max(prevAmount, forecastAmount);

    if (baseAmount <= 0) return { amount: 0, formula: null }; // no charges last month — skip
    formula = {
      kind: 'per_gb',
      prev_period: prevPeriod,
      prev_amount: Math.round(prevAmount * 100) / 100,
      avg_daily_gb: Math.round(avgDailyGb * 1000) / 1000,   // среднесуточное за 7 дней
      run_rate_gb: Math.round(last7Gb * 1000) / 1000,       // всего за 7 дней (для тултипа)
      days_in_month: daysInMonth,
      price,
      forecast_amount: Math.round(forecastAmount * 100) / 100,
      rounded_to: 10000,
    };
  }

  // Add negative balance (debt) to the amount
  let totalAmount = baseAmount;
  const debt = (client.balance || 0) < 0 ? Math.abs(client.balance) : 0;
  totalAmount += debt;
  if (formula) formula.debt = Math.round(debt * 100) / 100;

  // For per_gb: round up to nearest 10,000₽
  if (client.billingType !== 'per_modem') {
    totalAmount = Math.ceil(totalAmount / 10000) * 10000;
  }

  return { amount: Math.round(totalAmount * 100) / 100, formula };
}

function calculateMonthlyBillAmount(client, cachedResults, getLedger) {
  return calculateMonthlyBillDetails(client, cachedResults, getLedger).amount;
}

// Человекочитаемая строка формулы для страницы счетов (2026-08-02).
// Краткий формат: MAX (сумма за прошлый месяц или ср.за 7 дн. × дней × тариф).
function formatBillFormula(f) {
  if (!f) return '';
  if (f.kind === 'manual') return 'Сумма задана вручную';
  const rub = v => Math.round(v).toLocaleString('ru-RU') + ' ₽';
  if (f.kind === 'per_modem') {
    return `${f.modem_count} мод. × ${rub(f.price)}${f.debt ? ' + долг ' + rub(f.debt) : ''}`;
  }
  const mm = f.prev_period ? Number(f.prev_period.slice(5, 7)) : 0;
  const monthName = MONTH_NAMES_ACC[mm - 1] || 'прошлый мес.';
  let fc;
  if (f.avg_daily_gb != null) {
    // Текущая формула (2026-08-02): среднесуточное за последние 7 дней.
    fc = `${f.avg_daily_gb} ГБ/день × ${f.days_in_month} дн. × ${f.price} ₽`;
  } else {
    // Легаси-формула (run-rate месяц-к-дате × 1.1) — счета, выставленные раньше.
    fc = `${f.run_rate_gb} ГБ ÷ ${f.days_elapsed} дн. × ${f.days_in_month} дн. × ${f.price} ₽` + (f.margin && f.margin !== 1 ? ` × ${f.margin}` : '');
  }
  return `MAX (${rub(f.prev_amount)} за ${monthName} или ${fc} = ${rub(f.forecast_amount)})`
    + (f.debt ? ` + долг ${rub(f.debt)}` : '')
    + (f.rounded_to ? ` → ↑${(f.rounded_to / 1000)}k` : '');
}

module.exports = {
  MONTH_NAMES_RU,
  MONTH_NAMES_ACC,
  buildActItemsFromLedger,
  buildTochkaActBody,
  buildTochkaBillBody,
  calculateMonthlyBillAmount,
  calculateMonthlyBillDetails,
  formatBillFormula,
  sanitizeActPositionsForTochka
};
