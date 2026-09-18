// 2026-09-18 · Регрессии DEEP-23 (FIX-SPEC §): durable-учёт суточного биллинга
// (billing_runs + задания client/date). Настоящие SQLite repositories
// (billing_runs, billing_jobs, billing_ledger, clients) и настоящий atomic;
// заглушаются только фид серверов и счётчики трафика.
// На коде до исправления каждый тест падал:
//   • ошибка списания только логировалась — в retry не попадала и нигде не
//     сохранялась; retry в setTimeout пересчитывал «вчера» на момент запуска;
//   • first_day-строка покупки за расчётную дату останавливала расчёт всех
//     клиентов (глобальный guard по любому charge);
//   • нулевое списание и ошибка не различались; незавершённый прогон после
//     рестарта не восстанавливался (глядели на возраст snapshot).

import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import crypto from 'crypto';
import { createRequire } from 'module';
import { bootApp } from './_helpers/app.js';

const cjsRequire = createRequire(import.meta.url);
const billingJob = cjsRequire('../src/jobs/billing.js');
const billingRunsDb = cjsRequire('../src/db/billing-runs.js');
const ledgerDb = cjsRequire('../src/db/ledger.js');

let db, atomic;
const TAG = 'd23';
const seeded = { clients: [], dates: [] };

beforeAll(() => {
  db = bootApp().db;
  atomic = cjsRequire('../src/billing/atomic.js');
});

afterEach(() => {
  while (seeded.clients.length) {
    const id = seeded.clients.pop();
    try {
      db.prepare('DELETE FROM billing_ledger WHERE client_id = ?').run(id);
      db.prepare('DELETE FROM clients WHERE id = ?').run(id);
    } catch (_) {}
  }
  while (seeded.dates.length) {
    const d = seeded.dates.pop();
    try {
      db.prepare('DELETE FROM billing_runs WHERE billing_date = ?').run(d);
      db.prepare('DELETE FROM billing_jobs WHERE billing_date = ?').run(d);
    } catch (_) {}
  }
});

function trackDate(d) { if (!seeded.dates.includes(d)) seeded.dates.push(d); return d; }

function seedClient(tag, { balance = 1000, price = 100 } = {}) {
  const id = `${TAG}_${tag}_` + crypto.randomBytes(3).toString('hex');
  db.prepare('INSERT INTO clients (id, login, name, balance, price, billing_type, created_at) VALUES (?, ?, ?, ?, ?, \'per_gb\', datetime(\'now\'))')
    .run(id, id, 'DEEP ' + tag, balance, price);
  seeded.clients.push(id);
  return { id, login: id, name: 'DEEP ' + tag, portName: id, price, billingType: 'per_gb',
    clientType: 'legal', balance };
}

function mkBilling(clientsArr, { debitImpl, durableBytes = 2e9 } = {}) {
  return billingJob.create({
    db,
    logger: { info() {}, warn() {}, error() {} },
    logActivity() {},
    fetchAllServersData: async () => [{ serverName: 'S1', bw: {} }],
    refreshPortKeyMapping() {},
    getMoscowYesterday: () => '2026-09-17',
    getMoscowNow: () => new Date('2026-09-18T01:00:00+03:00'),
    ledgerDb, billingRunsDb,
    clients: clientsArr,
    dailyTraffic: {}, recordDailyTraffic() {},
    parseBwToBytes: () => 0,
    trafficBytesToGb: (b) => b / 1e9,
    getClientCachedServers: () => [],
    apiServers: [{ name: 'S1' }],
    getClientBytesForMskDate: () => durableBytes,
    computeClientYesterdayBytes: () => 0,
    computeClientMonthBytes: () => 0,
    atomicDebit: debitImpl || atomic.atomicDebit,
    modemPlural: (n) => 'модема',
    appSettings: {},
    alerts: { trigger: () => true },
    saveClients() {}, saveDailyTraffic() {},
    withClientsLock: (fn) => fn(),
    setLastBillingRunSummary() {},
    debtBlock: null,
    tariffsDb: null,
  });
}

function jobOf(date, clientId) { return billingRunsDb.jobFor(date, clientId); }
function runOf(date) { return billingRunsDb.runFor(date); }
function ledgerCharges(clientId) {
  return db.prepare("SELECT * FROM billing_ledger WHERE client_id = ? AND type='charge' ORDER BY id").all(clientId);
}

describe('DEEP-23: durable billing runs/jobs и восстановление', () => {
  it('ошибка списания → durable failed + retry-очередь; retry сохраняет дату и контекст', async () => {
    const date = trackDate('2026-09-10');
    const c1 = seedClient('ok', { price: 100 });
    const c2 = seedClient('err', { price: 100 });
    let failC2 = true;
    const debitImpl = (id, amount, entry, opts) => {
      if (id === c2.id && failC2) throw new Error('ledger db locked');
      return atomic.atomicDebit(id, amount, entry, opts);
    };
    const timers = [];
    const stSpy = vi.spyOn(global, 'setTimeout').mockImplementation((fn) => { timers.push(fn); return 0; });
    try {
      const job = mkBilling([c1, c2], { debitImpl });
      await job.runDailyBilling(undefined, { billingDate: date });

      // c1 списан; у c2 — durable 'failed' и место в retry-очереди (на старом
      // коде ошибка только логировалась и задание нигде не сохранялось).
      expect(jobOf(date, c1.id).status).toBe('done');
      expect(jobOf(date, c1.id).amount).toBe(200);   // 100 ₽/GB × 2 GB
      expect(jobOf(date, c2.id).status).toBe('failed');
      expect(runOf(date).status).toBe('completed');
      expect(timers.length).toBe(1);   // retry запланирован (старое: не попадал в очередь)

      // Retry через реальный таймерный колбэк: дата исходная, цена — из
      // durable-контекста (клиенту уже подняли цену до 999).
      db.prepare('UPDATE clients SET price = 999 WHERE id = ?').run(c2.id);
      c2.price = 999;
      failC2 = false;
      await timers[0]();
      const job2 = jobOf(date, c2.id);
      expect(job2.status).toBe('done');
      expect(job2.amount).toBe(200);   // контекст первой попытки, не 999×2
      const rows = ledgerCharges(c2.id);
      expect(rows.length).toBe(1);
      expect(rows[0].date).toBe(date); // старый retry пересчитывал «вчера»
      expect(rows[0].amount).toBe(200);
    } finally {
      stSpy.mockRestore();
    }
  });

  it('first_day-строка покупки за расчётную дату НЕ останавливает прогон', async () => {
    const date = trackDate('2026-09-11');
    const c1 = seedClient('first', { price: 50 });
    // Покупка первых суток (purchase_id NOT NULL) за ту же дату — на старом
    // коде existsChargeOnDate находил её и пропускал весь дневной расчёт.
    atomic.atomicDebit(c1.id, 33, {
      date, type: 'charge', note: 'first_day', cost: 33, purchase_id: 'pur_' + TAG + '_g',
    });
    const job = mkBilling([c1]);
    await job.runDailyBilling(undefined, { billingDate: date });
    expect(jobOf(date, c1.id).status).toBe('done');
    const rows = ledgerCharges(c1.id);
    expect(rows.length).toBe(2);                       // first_day + суточное списание
    expect(rows.filter(r => r.purchase_id).length).toBe(1);
    expect(rows.filter(r => !r.purchase_id)[0].amount).toBe(100);   // 50 × 2 GB
  });

  it('завершённый прогон без открытых заданий — guard; нулевое списание — отдельный статус', async () => {
    const date = trackDate('2026-09-12');
    const c1 = seedClient('full', { price: 40 });
    const c0 = seedClient('zero', { price: 40 });
    // c0 — per_gb с нулевым трафиком: durableBytes по умолчанию >0, даём 0.
    // per-client байты: у c0 трафика нет.
    const bytesByClient = { [c1.id]: 2e9, [c0.id]: 0 };
    const inst = billingJob.create({
      db,
      logger: { info() {}, warn() {}, error() {} },
      logActivity() {},
      fetchAllServersData: async () => [{ serverName: 'S1', bw: {} }],
      refreshPortKeyMapping() {},
      getMoscowYesterday: () => '2026-09-17',
      getMoscowNow: () => new Date('2026-09-18T01:00:00+03:00'),
      ledgerDb, billingRunsDb,
      clients: [c1, c0],
      dailyTraffic: {}, recordDailyTraffic() {},
      parseBwToBytes: () => 0,
      trafficBytesToGb: (b) => b / 1e9,
      getClientCachedServers: () => [],
      apiServers: [{ name: 'S1' }],
      getClientBytesForMskDate: (portName) => bytesByClient[portName] || 0,
      computeClientYesterdayBytes: () => 0,
      computeClientMonthBytes: () => 0,
      atomicDebit: atomic.atomicDebit,
      modemPlural: (n) => 'модема',
      appSettings: {},
      alerts: { trigger: () => true },
      saveClients() {}, saveDailyTraffic() {},
      withClientsLock: (fn) => fn(),
      setLastBillingRunSummary() {},
      debtBlock: null,
      tariffsDb: null,
    });
    await inst.runDailyBilling(undefined, { billingDate: date });
    expect(jobOf(date, c1.id).status).toBe('done');
    // Нулевое списание — завершённое состояние 'zero', не ошибка и не no_data.
    expect(jobOf(date, c0.id).status).toBe('zero');
    expect(runOf(date).status).toBe('completed');

    // Повторный прогон той же даты — guard, новых списаний нет.
    const before = ledgerCharges(c1.id).length;
    await inst.runDailyBilling(undefined, { billingDate: date });
    expect(ledgerCharges(c1.id).length).toBe(before);
  });

  it('крах после debit до отметки: задание pending → recovery доводит без двойного списания', async () => {
    const date = trackDate('2026-09-13');
    const c1 = seedClient('crash', { price: 60 });
    // Имитация краха: durable-задание создано, списание ПРОШЛО, отметка — нет.
    billingRunsDb.beginRun(date);
    billingRunsDb.ensureJob(date, c1.id, { price: 60, billing_type: 'per_gb', billing_date: date });
    atomic.atomicDebit(c1.id, 120, {
      date, type: 'charge', cost: 120, note: 'crash before mark', traffic_source: 'daily_billing',
    });
    // Recovery находит незавершённое задание по дате (не по возрасту snapshot).
    const open = billingRunsDb.openJobs(date);
    expect(open.map(j => j.client_id)).toContain(c1.id);

    const job = mkBilling([c1]);
    await job.runDailyBilling([c1.id], { billingDate: date });
    expect(jobOf(date, c1.id).status).toBe('done');
    // Денег ровно одно списание — повторный прогон увидел duplicate.
    expect(ledgerCharges(c1.id).length).toBe(1);
    expect(billingRunsDb.openJobs(date).length).toBe(0);
  });
});
