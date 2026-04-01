'use strict';

const logger = require('../logger');

// Russian month names (prepositional case for "в январе")
const MONTH_NAMES_RU = ['январе','феврале','марте','апреле','мае','июне','июле','августе','сентябре','октябре','ноябре','декабре'];

// Helper: build act line items from billing ledger entries
function buildActItemsFromLedger(client, period, billingLedger) {
  const ledgerEntries = billingLedger[client.id] || [];
  const monthCharges = ledgerEntries.filter(e => e.type === 'charge' && e.date && e.date.startsWith(period));
  const totalGb = monthCharges.reduce((sum, e) => sum + (e.delta_gb || 0), 0);
  const totalCost = Math.round(monthCharges.reduce((sum, e) => sum + (e.cost || 0), 0) * 100) / 100;
  const modemCharges = monthCharges.filter(e => e.billing_type === 'per_modem');
  const gbCharges = monthCharges.filter(e => e.billing_type !== 'per_modem');

  const actItems = [];
  if (gbCharges.length > 0) {
    actItems.push({
      name: 'Услуги мобильных прокси (трафик)',
      quantity: Math.round(totalGb * 100) / 100,
      unit: 'ГБ',
      price: client.price || 23,
      amount: Math.round(gbCharges.reduce((s, e) => s + (e.cost || 0), 0) * 100) / 100
    });
  }
  if (modemCharges.length > 0) {
    const modemCount = Math.max(...modemCharges.map(e => e.modem_count || 0)) || 1;
    actItems.push({
      name: 'Услуги мобильных прокси (аренда модемов)',
      quantity: modemCount,
      unit: 'шт',
      price: client.price || 0,
      amount: Math.round(modemCharges.reduce((s, e) => s + (e.cost || 0), 0) * 100) / 100
    });
  }
  if (actItems.length === 0) {
    actItems.push({
      name: 'Услуги мобильных прокси',
      quantity: Math.round(totalGb * 100) / 100 || 1,
      unit: totalGb > 0 ? 'ГБ' : 'мес',
      price: client.price || 23,
      amount: totalCost
    });
  }
  return { actItems, totalCost, monthCharges };
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
      unitCode: item.unit === 'ГБ' ? 'Гбайт' : (item.unit === 'шт' ? 'шт' : 'услуга.'),
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
        Act: act,
        PackingList: {},
        Invoicef: {},
        Upd: {}
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
function calculateMonthlyBillAmount(client, cachedResults, billingLedger) {
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

    const ledgerEntries = billingLedger[client.id] || [];
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
  buildActItemsFromLedger,
  buildTochkaActBody,
  buildTochkaBillBody,
  calculateMonthlyBillAmount
};
