// C5: unit-тест логики сравнения scripts/reconcile-payments.js —
// Σ legacy payments vs Σ billing_ledger (payment + bank_payment − payment_reversal).

import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const { comparePayments } = require('../scripts/reconcile-payments.js');

let db;

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(`
    CREATE TABLE payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id TEXT NOT NULL,
      amount REAL NOT NULL,
      date TEXT NOT NULL,
      note TEXT DEFAULT '',
      source TEXT DEFAULT 'manual',
      payment_id TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE billing_ledger (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id TEXT NOT NULL,
      type TEXT NOT NULL,
      date TEXT NOT NULL,
      amount REAL NOT NULL
    );
  `);
});

function addLegacy(clientId, amount) {
  db.prepare('INSERT INTO payments (client_id, amount, date) VALUES (?, ?, ?)').run(clientId, amount, '2026-01-01');
}
function addLedger(clientId, type, amount) {
  db.prepare('INSERT INTO billing_ledger (client_id, type, date, amount) VALUES (?, ?, ?, ?)').run(clientId, type, '2026-01-01', amount);
}

describe('reconcile-payments: comparePayments', () => {
  it('совпадение: legacy == ledger → match', () => {
    addLegacy('c1', 1000);
    addLegacy('c1', 500);
    addLedger('c1', 'payment', 1000);
    addLedger('c1', 'bank_payment', 500);
    // charge/correction не участвуют в сумме платежей
    addLedger('c1', 'charge', 300);
    addLedger('c1', 'correction', 100);

    const r = comparePayments(db);
    expect(r.paymentsTableMissing).toBe(false);
    expect(r.clients.length).toBe(1);
    expect(r.clients[0]).toMatchObject({ client_id: 'c1', legacy: 1500, ledger: 1500, diff: 0, match: true });
    expect(r.totals).toEqual({ legacy: 1500, ledger: 1500 });
  });

  it('payment_reversal вычитается из ledger-суммы', () => {
    addLegacy('c1', 1000);
    addLedger('c1', 'payment', 1000);
    addLedger('c1', 'payment', 200);
    addLedger('c1', 'payment_reversal', 200);   // сторно второго платежа

    const r = comparePayments(db);
    expect(r.clients[0]).toMatchObject({ legacy: 1000, ledger: 1000, diff: 0, match: true });
  });

  it('расхождение: платёж есть в legacy, но не доимпортирован в ledger', () => {
    addLegacy('c1', 700);
    addLedger('c1', 'payment', 500);
    addLegacy('c2', 300);
    addLedger('c2', 'payment', 300);

    const r = comparePayments(db);
    const c1 = r.clients.find(c => c.client_id === 'c1');
    const c2 = r.clients.find(c => c.client_id === 'c2');
    expect(c1).toMatchObject({ legacy: 700, ledger: 500, diff: -200, match: false });
    expect(c2.match).toBe(true);
  });

  it('клиент только в ledger (без legacy-строк) тоже попадает в отчёт', () => {
    addLedger('c9', 'bank_payment', 100);
    const r = comparePayments(db);
    expect(r.clients.length).toBe(1);
    expect(r.clients[0]).toMatchObject({ client_id: 'c9', legacy: 0, ledger: 100, match: false });
  });

  it('отсутствующая таблица payments → paymentsTableMissing', () => {
    db.exec('DROP TABLE payments');
    const r = comparePayments(db);
    expect(r.paymentsTableMissing).toBe(true);
    expect(r.clients).toEqual([]);
  });
});
