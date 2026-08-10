// D9 (2026-08): тест «портал == акт».
//
// Клиентский портал (/api/dashboard_data → billing.monthExpense) и акты
// (buildActItemsFromLedger, src/tochka/documents.js) обязаны сходиться в деньгах,
// потому что читают ОДИН источник — billing_ledger (charge + correction за
// период). Инвариант на уровне данных: Σ ledgerExpense(портал) == totalCost(акт).
//
// Портал считает через server.js ledgerExpense (здесь — та самая функция из
// экспорта server.js, не копия); акт — через продовый buildActItemsFromLedger
// поверх реального ledgerDb.listByClient. Строки пишем в боевую схему
// billing_ledger тестовой БД.

import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'module';
import crypto from 'crypto';
import { bootApp } from './_helpers/app.js';

const require = createRequire(import.meta.url);
const ledgerDb = require('../src/db/ledger.js');
const { buildActItemsFromLedger } = require('../src/tochka/documents.js');

let db, ledgerExpense, clientId;
const PERIOD = '2026-08';

beforeAll(() => {
  const ctx = bootApp();
  db = ctx.db;
  ledgerExpense = require('../server.js').ledgerExpense;

  clientId = 'd9-' + crypto.randomBytes(4).toString('hex');
  db.prepare(`INSERT INTO clients (id, login, name, balance, price, billing_type, created_at)
              VALUES (?, ?, ?, 0, 10, 'per_gb', datetime('now'))`)
    .run(clientId, 'd9_' + clientId, 'D9 Parity');

  const ins = db.prepare(`INSERT INTO billing_ledger
    (client_id, type, date, timestamp, amount, balance_before, balance_after, gb_used, modem_count, days_in_month, note, source, details)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'test', ?)`);
  const at = (d) => d + 'T04:00:00.000Z';
  // per_gb списания, две цены (B1-разбивка)
  ins.run(clientId, 'charge', '2026-08-01', at('2026-08-01'), 100, null, null, 10, null, null, 'gb d1', JSON.stringify({ billing_type: 'per_gb', price_per_unit: 10 }));
  ins.run(clientId, 'charge', '2026-08-02', at('2026-08-02'), 115.5, null, null, 10.5, null, null, 'gb d2', JSON.stringify({ billing_type: 'per_gb', price_per_unit: 11 }));
  // per_modem списание
  ins.run(clientId, 'charge', '2026-08-03', at('2026-08-03'), 230, null, null, null, 10, 31, 'modem d3', JSON.stringify({ billing_type: 'per_modem', price_per_unit: 23 }));
  // корректировки обеих сторон (возврат −50, доначисление +20)
  ins.run(clientId, 'correction', '2026-08-05', at('2026-08-05'), 50, 1000, 1050, null, null, null, 'refund', '{}');
  ins.run(clientId, 'correction', '2026-08-06', at('2026-08-06'), 20, 1050, 1030, null, null, null, 'debit', '{}');
  // НЕ должны влиять: платёж и списание другого месяца
  ins.run(clientId, 'payment', '2026-08-07', at('2026-08-07'), 5000, null, null, null, null, null, 'pay', '{}');
  ins.run(clientId, 'charge', '2026-07-15', at('2026-07-15'), 999, null, null, 99, null, null, 'other month', JSON.stringify({ billing_type: 'per_gb', price_per_unit: 10 }));
});

describe('D9: «портал == акт» — месячный расход из одного источника (billing_ledger)', () => {
  it('Σ ledgerExpense (формула портала /api/dashboard_data) == totalCost акта', () => {
    const entries = ledgerDb.listByClient(clientId);

    // Формула портала — client-portal.js /api/dashboard_data (billing.monthExpense):
    // charge + correction за текущий месяц через ledgerExpense.
    const portalMonthExpense = entries
      .filter(e => (e.type === 'charge' || e.type === 'correction') && e.date && e.date.startsWith(PERIOD))
      .reduce((sum, e) => sum + ledgerExpense(e), 0);

    const client = { id: clientId, name: 'D9 Parity', price: 10, billingType: 'per_gb' };
    const { actItems, totalCost } = buildActItemsFromLedger(client, PERIOD, (id) => ledgerDb.listByClient(id));

    // Санити: набор строк осмысленный (gb ×2 цены, modem, корректировка).
    expect(actItems.length).toBeGreaterThanOrEqual(3);
    // 100 + 115.5 + 230 − 50 + 20 = 415.5
    expect(portalMonthExpense).toBeCloseTo(415.5, 2);
    // Инвариант: суммы сходятся (допуск — копеечное округление сегментов акта).
    expect(Math.abs(totalCost - portalMonthExpense)).toBeLessThanOrEqual(0.02);
  });

  it('платежи и чужие месяцы не попадают ни в портал, ни в акт', () => {
    const client = { id: clientId, name: 'D9 Parity', price: 10, billingType: 'per_gb' };
    const { totalCost } = buildActItemsFromLedger(client, PERIOD, (id) => ledgerDb.listByClient(id));
    expect(totalCost).toBeCloseTo(415.5, 1);   // без 5000-платежа и 999 июльского
  });
});
