// Stage 9 (HIGH, денежный путь): characterization-тесты месячной сверки.
// Локируем контракт: маркер месяца пишется ДО дебитов (краш ≠ дабл-билл),
// per_modem пропускается, корректировка считается stored − billed с фильтром
// по traffic_source, дата = последний день прошлого месяца.

import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const monthlyRecon = require('../src/jobs/monthly-reconciliation.js');

const AUG1 = new Date('2026-08-01T03:00:00Z');
const AUG2 = new Date('2026-08-02T03:00:00Z');

let kvWrites, debits, saves, jobDeps;
function mkDeps(overrides = {}) {
  kvWrites = [];
  debits = [];
  saves = [];
  const base = {
    logger: { info() {}, warn() {}, error() {} },
    logActivity: () => {},
    kvGet: { get: () => ({ value: '' }) },
    kvSet: { run: (k, v) => kvWrites.push([k, v]) },
    fetchAllServersDataCached: async () => [],
    refreshPortKeyMapping: () => {},
    getClients: () => [{
      id: 'c1', name: 'Client A', portName: 'clientA', price: 100, currency: 'RUB', billingType: 'per_gb',
    }],
    getClientStoredMonthBytes: () => 2e9,        // 2 GB хранится
    trafficBytesToGb: (b) => b / 1e9,
    ledgerDb: { listByClient: () => [] },        // выставлено 0
    appSettings: { reconciliation_tolerance_gb: 0.01 },
    atomicDebit: (id, cost, entry) => { debits.push({ id, cost, entry }); return { duplicate: false }; },
    saveClients: () => saves.push(1),
    getMoscowNow: () => AUG1,
    getMoscowToday: () => '2026-08-01',
  };
  jobDeps = Object.assign(base, overrides);
  return monthlyRecon.create(jobDeps);
}

describe('runMonthlyReconciliation (Stage 9, денежный путь)', () => {
  beforeEach(() => {});

  it('не 1-е число → пропуск: ни дебитов, ни маркера', async () => {
    const job = mkDeps({ getMoscowNow: () => AUG2, getMoscowToday: () => '2026-08-02' });
    await job.runMonthlyReconciliation();
    expect(debits.length).toBe(0);
    expect(kvWrites.length).toBe(0);
  });

  it('уже сверенный месяц → пропуск', async () => {
    const job = mkDeps({ kvGet: { get: () => ({ value: '2026-07' }) } });
    await job.runMonthlyReconciliation();
    expect(debits.length).toBe(0);
    expect(kvWrites.length).toBe(0);
  });

  it('stored > billed → корректировка с правильной суммой, датой и источником', async () => {
    const job = mkDeps();
    await job.runMonthlyReconciliation();
    expect(debits.length).toBe(1);
    const d = debits[0];
    expect(d.id).toBe('c1');
    expect(d.cost).toBe(200);                       // 2 GB × 100₽
    expect(d.entry.date).toBe('2026-07-31');        // последний день прошлого месяца
    expect(d.entry.delta_gb).toBe(2);
    expect(d.entry.traffic_source).toBe('monthly_reconciliation');
    expect(d.entry.note).toContain('07.2026');
    expect(saves.length).toBe(1);
  });

  it('маркер месяца пишется ДО первого дебита (краш при дебите ≠ дабл-билл)', async () => {
    const order = [];
    const job = mkDeps({
      kvSet: { run: (k, v) => order.push(['kv', k, v]) },
      atomicDebit: () => { order.push(['debit']); throw new Error('db down'); },
    });
    await expect(job.runMonthlyReconciliation()).rejects.toThrow('db down');
    expect(order[0][0]).toBe('kv');
    expect(order[0][1]).toBe('last_reconciliation_month');
    expect(order[0][2]).toBe('2026-07');
  });

  it('diff ≤ tolerance → без корректировки; per_modem → пропуск', async () => {
    const job = mkDeps({
      getClients: () => [
        { id: 'c1', name: 'A', portName: 'clientA', price: 100, currency: 'RUB', billingType: 'per_gb' },
        { id: 'c2', name: 'B', portName: 'clientB', price: 5000, currency: 'RUB', billingType: 'per_modem' },
      ],
      getClientStoredMonthBytes: () => 0.005e9,    // 5 MB — ниже порога
    });
    await job.runMonthlyReconciliation();
    expect(debits.length).toBe(0);
  });

  it('старые корректировки monthly_reconciliation не засчитываются в billed', async () => {
    const job = mkDeps({
      getClientStoredMonthBytes: () => 3e9,        // 3 GB
      ledgerDb: { listByClient: () => [
        { type: 'charge', date: '2026-07-10', delta_bytes: 1e9, traffic_source: 'daily_billing' },
        { type: 'charge', date: '2026-07-31', delta_bytes: 1e9, traffic_source: 'monthly_reconciliation' }, // прошлая корр. — не считается
      ] },
    });
    await job.runMonthlyReconciliation();
    expect(debits.length).toBe(1);
    expect(debits[0].entry.delta_gb).toBe(2);      // 3 − 1, а не 3 − 2
  });
});
