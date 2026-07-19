// Регресс P1 (19.07): реконсиляция и delete-роут не должны верить реплею
// Σ(after−before) на реестре с историческими разрывами цепочки.
//
// Живой кейс: ВАЙЛДБОКС — 6 разрывов (майский инцидент: ручные adjustments,
// ретро-вставки), Σ реплея = +3.3M при реальном балансе −138k. Правильный
// контракт: баланс = balance_after ПОСЛЕДНЕЙ записи (ledgerFinalBalance);
// разрывы ловятся отдельно (findChainBreaks) против baseline.

import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const { ledgerFinalBalance, findChainBreaks, recalcFromLedger, entryDelta } = require('../src/billing/recalc.js');
const reconcileMod = require('../src/jobs/balance-reconcile.js');

function mkDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE billing_ledger (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id TEXT, type TEXT, date TEXT, amount REAL,
      balance_before REAL, balance_after REAL
    );
    CREATE TABLE kv_store (key TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT '{}', updated_at TEXT);
  `);
  return db;
}
function ins(db, cid, type, amount, bb, ba) {
  db.prepare('INSERT INTO billing_ledger (client_id,type,date,amount,balance_before,balance_after) VALUES (?,?,?,?,?,?)')
    .run(cid, type, '2026-07-01', amount, bb, ba);
}

// Мини-копия кейса ВАЙЛДБОКС: непрерывный кусок, затем разрыв (ретро-вставка
// со снапшотами из другого состояния), затем ручной adjustment с разрывом.
function seedBrokenChain(db, cid) {
  ins(db, cid, 'charge', 100, 1000, 900);        // 1000 → 900
  ins(db, cid, 'charge', 100, 900, 800);         // 900 → 800
  ins(db, cid, 'bank_payment', 500, 2000, 2500); // РАЗРЫВ: вставка задним числом (скачок +1200)
  ins(db, cid, 'adjustment', 2600, 400, -100);   // РАЗРЫВ: ручная правка (скачок −2100)
  ins(db, cid, 'charge', 50, -100, -150);        // -100 → -150 (финальное слово)
}

describe('ledgerFinalBalance / findChainBreaks (цепочка с разрывами)', () => {
  let db;
  beforeEach(() => { db = mkDb(); });

  it('финальный баланс = balance_after последней записи, НЕ Σ-реплей', () => {
    seedBrokenChain(db, 'wb');
    expect(ledgerFinalBalance(db, 'wb')).toBe(-150);
    // реплей на этой же истории уезжает (якорь 1000 + подельты −100−100+500−2700−50 = −1450):
    expect(recalcFromLedger(db, 'wb')).not.toBe(-150);
  });

  it('находит оба разрыва и их скачки', () => {
    seedBrokenChain(db, 'wb');
    const breaks = findChainBreaks(db, 'wb');
    expect(breaks.length).toBe(2);
    expect(breaks[0].jump).toBe(1200);   // 800 → 2000
    expect(breaks[1].jump).toBe(-2100);  // 2500 → 400
  });

  it('непрерывная цепочка: финал = реплей, разрывов нет', () => {
    ins(db, 'ok', 'charge', 100, 500, 400);
    ins(db, 'ok', 'payment', 300, 400, 700);
    expect(ledgerFinalBalance(db, 'ok')).toBe(700);
    expect(recalcFromLedger(db, 'ok')).toBe(700);
    expect(findChainBreaks(db, 'ok')).toEqual([]);
  });

  it('entryDelta: снапшоты авторитетны, амбивалентный тип без снапшотов → null', () => {
    expect(entryDelta({ type: 'correction', amount: 1175.01, balance_before: 100, balance_after: -1075.01 })).toBe(-1175.01);
    expect(entryDelta({ type: 'correction', amount: 1175.01 })).toBe(null);   // ловушка trofimovs
    expect(entryDelta({ type: 'charge', amount: 50 })).toBe(-50);
    expect(entryDelta({ type: 'payment', amount: 50 })).toBe(50);
  });
});

describe('balance-reconcile job (baseline разрывов + дрейф по финальному слову)', () => {
  function mkJob(db, clients) {
    const noop = () => {};
    const alerts = { triggered: [], trigger(rule, p) { this.triggered.push({ rule, p }); } };
    const job = reconcileMod.create({ db, clients, logActivity: noop, logger: { info: noop, warn: noop, error: noop }, alerts });
    return { job, alerts };
  }

  it('исторические разрывы сеются в baseline и НЕ алертят; совпадающий баланс — OK', () => {
    const db = mkDb();
    seedBrokenChain(db, 'wb');
    const clients = [{ id: 'wb', name: 'WB', balance: -150 }];
    const { job, alerts } = mkJob(db, clients);
    const r1 = job.runOnce();   // первый запуск: seed
    expect(r1.divergent).toBe(0);
    expect(r1.newBreaks).toEqual([]);
    expect(alerts.triggered.length).toBe(0);
    const r2 = job.runOnce();   // второй запуск: разрывы уже известны
    expect(r2.newBreaks).toEqual([]);
    expect(alerts.triggered.length).toBe(0);
  });

  it('реальный дрейф (balance ≠ последний снапшот) алертит', () => {
    const db = mkDb();
    seedBrokenChain(db, 'wb');
    const clients = [{ id: 'wb', name: 'WB', balance: -150 + 500 }];   // память уехала на 500
    const { job, alerts } = mkJob(db, clients);
    const r = job.runOnce();
    expect(r.divergent).toBe(1);
    expect(r.offenders[0].diff).toBe(500);
    expect(alerts.triggered.length).toBe(1);
  });

  it('НОВЫЙ разрыв после baseline алертит', () => {
    const db = mkDb();
    seedBrokenChain(db, 'wb');
    const clients = [{ id: 'wb', name: 'WB', balance: -150 }];
    const { job, alerts } = mkJob(db, clients);
    job.runOnce();   // seed
    // «удаление мимо канонического пути»: новая запись со снапшотами из другого состояния
    ins(db, 'wb', 'charge', 10, 999, 989);
    clients[0].balance = 989;   // память следует за новой записью — дрейфа нет
    const r = job.runOnce();
    expect(r.divergent).toBe(0);
    expect(r.newBreaks.length).toBe(1);
    expect(r.newBreaks[0].jump).toBe(1149);   // −150 → 999
    expect(alerts.triggered.length).toBe(1);
    expect(alerts.triggered[0].p.offenders).toContain('НОВЫЙ разрыв');
  });
});
