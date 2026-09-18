import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import { create } from '../src/jobs/bill-status-sync';
import { createRequire } from 'module';
import { bootApp } from './_helpers/app.js';

const require = createRequire(import.meta.url);

function mkDeps(overrides = {}) {
  const deps = {
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    clients: [],
    saveClients: vi.fn(),
    logActivity: vi.fn(),
    documentsDb: { updateBillStatus: vi.fn() },
    getTochkaConfig: () => ({ jwt: 'jwt', customerCode: '302536723' }),
    tochkaRequest: vi.fn(async () => ({ status: 200, data: { Data: { paymentStatus: 'payment_paid' } } })),
    ...overrides,
  };
  return deps;
}
function bill(id, status = 'unpaid', tochkaBillId = 'tb-' + id) {
  return { id, tochkaBillId, status, amount: 240000, billNumber: 'СЧЁТ-202607-' + id, period: '2026-07' };
}
function client(name, bills) { return { id: 'c-' + name, name, bills }; }

describe('syncBillStatuses', () => {
  it('закрывает неоплаченный счёт, который Точка считает оплаченным', async () => {
    const deps = mkDeps({ clients: [client('X', [bill('b1')])] });
    const res = await create(deps).syncBillStatuses();

    expect(res).toEqual({ checked: 1, paid: 1 });
    expect(deps.clients[0].bills[0].status).toBe('paid');
    expect(deps.documentsDb.updateBillStatus).toHaveBeenCalledWith('b1', 'paid');
    expect(deps.saveClients).toHaveBeenCalled();
    expect(deps.tochkaRequest).toHaveBeenCalledWith('GET', '/uapi/invoice/v1.0/bills/302536723/tb-b1/payment-status');
  });

  it('не трогает счета, уже отмеченные оплаченными, и счета без tochkaBillId', async () => {
    const local = bill('b2', 'unpaid'); local.tochkaBillId = null;
    const deps = mkDeps({ clients: [client('X', [bill('b1', 'paid'), local])] });
    const res = await create(deps).syncBillStatuses();

    expect(res).toEqual({ checked: 0, paid: 0 });
    expect(deps.tochkaRequest).not.toHaveBeenCalled();
    expect(deps.saveClients).not.toHaveBeenCalled();
  });

  it('оплаченным считается только точный payment_paid — незнакомый статус счёт не закрывает', async () => {
    const deps = mkDeps({
      clients: [client('X', [bill('b1')])],
      tochkaRequest: vi.fn(async () => ({ status: 200, data: { Data: { paymentStatus: 'payment_partially_paid' } } })),
    });
    const res = await create(deps).syncBillStatuses();

    expect(res).toEqual({ checked: 1, paid: 0 });
    expect(deps.clients[0].bills[0].status).toBe('unpaid');
    expect(deps.documentsDb.updateBillStatus).not.toHaveBeenCalled();
    // Незнакомое значение должно попасть в лог — иначе новый статус Точки пройдёт незамеченным.
    expect(deps.logger.info).toHaveBeenCalledWith(expect.stringContaining('payment_partially_paid'));
  });

  it('ошибка по одному счёту не срывает обработку остальных', async () => {
    const deps = mkDeps({
      clients: [client('X', [bill('b1'), bill('b2')])],
      tochkaRequest: vi.fn(async (_m, path) => {
        if (path.includes('tb-b1')) throw new Error('Tochka API timeout');
        return { status: 200, data: { Data: { paymentStatus: 'payment_paid' } } };
      }),
    });
    const res = await create(deps).syncBillStatuses();

    expect(res).toEqual({ checked: 1, paid: 1 });
    expect(deps.clients[0].bills[1].status).toBe('paid');
    expect(deps.logger.error).toHaveBeenCalled();
  });

  it('HTTP-ошибка не закрывает счёт', async () => {
    const deps = mkDeps({
      clients: [client('X', [bill('b1')])],
      tochkaRequest: vi.fn(async () => ({ status: 404, data: {} })),
    });
    const res = await create(deps).syncBillStatuses();

    expect(res).toEqual({ checked: 1, paid: 0 });
    expect(deps.clients[0].bills[0].status).toBe('unpaid');
  });

  it('без настроенной Точки джоб не ходит в сеть', async () => {
    const deps = mkDeps({ clients: [client('X', [bill('b1')])], getTochkaConfig: () => ({ jwt: '', customerCode: '' }) });
    const res = await create(deps).syncBillStatuses();

    expect(res).toEqual({ checked: 0, paid: 0 });
    expect(deps.tochkaRequest).not.toHaveBeenCalled();
  });
});

// 2026-09-18 · DEEP-18 (FIX-SPEC §17.2): DB-first, как settlement (FIX-02).
// Настоящий documents repository (SQLite через bootApp); сбой записи
// имитируется обёрткой, кидающей как better-sqlite3. На коде до исправления
// bill.status менялся в памяти ДО updateBillStatus — ошибка SQLite оставляла
// фиктивный paid, и следующий проход такой счёт уже не проверял.
describe('DEEP-18: ошибка записи не оставляет фиктивный paid', () => {
  const CLIENT_ID = 'deep18-c';
  const BILL_ID = 'deep18-b1';
  let db, documentsRepo;

  beforeAll(() => {
    db = bootApp().db;
    documentsRepo = require('../src/db/documents.js');
    db.prepare("INSERT INTO clients (id, login, name, balance, created_at) VALUES (?, 'deep18_login', 'DEEP18', 0, datetime('now'))").run(CLIENT_ID);
  });
  beforeEach(() => {
    // Счёт на уникальный (клиент, период); состояние — неоплачен.
    db.prepare("INSERT INTO bills (id, client_id, tochka_bill_id, period, bill_number, amount, status) VALUES (?, ?, 'tb-deep18', '2099-01', 'СЧЁТ-D18', 1000, 'unpaid') ON CONFLICT(id) DO UPDATE SET status='unpaid'").run(BILL_ID, CLIENT_ID);
  });
  afterAll(() => {
    try { db.prepare('DELETE FROM bills WHERE client_id = ?').run(CLIENT_ID); } catch (_) { /* best-effort */ }
    try { db.prepare('DELETE FROM clients WHERE id = ?').run(CLIENT_ID); } catch (_) { /* best-effort */ }
  });

  function mkRealDeps({ failWrite }) {
    const inMemoryBill = { id: BILL_ID, tochkaBillId: 'tb-deep18', status: 'unpaid', amount: 1000, billNumber: 'СЧЁТ-D18', period: '2099-01' };
    const deps = {
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      clients: [{ id: CLIENT_ID, name: 'DEEP18', bills: [inMemoryBill] }],
      saveClients: vi.fn(),
      logActivity: vi.fn(),
      documentsDb: {
        updateBillStatus: (id, status) => {
          if (failWrite === 'throw') throw new Error('SQLITE_BUSY: database is locked');
          if (failWrite === 'noop') return { changes: 0 };   // строка не обновлена (конфликт)
          return documentsRepo.updateBillStatus(id, status);
        },
      },
      getTochkaConfig: () => ({ jwt: 'jwt', customerCode: '302536723' }),
      tochkaRequest: vi.fn(async () => ({ status: 200, data: { Data: { paymentStatus: 'payment_paid' } } })),
    };
    return { deps, inMemoryBill };
  }

  it('банк вернул paid, запись SQLite упала → в памяти unpaid, повтор доводит без фиктивного успеха', async () => {
    const failing = mkRealDeps({ failWrite: 'throw' });
    const res1 = await create(failing.deps).syncBillStatuses();

    expect(res1).toEqual({ checked: 1, paid: 0 });
    expect(failing.inMemoryBill.status).toBe('unpaid');   // нет фиктивного paid в памяти
    expect(db.prepare('SELECT status FROM bills WHERE id = ?').get(BILL_ID).status).toBe('unpaid');
    expect(failing.deps.saveClients).not.toHaveBeenCalled();
    expect(failing.deps.logActivity).not.toHaveBeenCalled();
    expect(failing.deps.logger.error).toHaveBeenCalled();

    // Запись восстановилась — следующий проход закрывает счёт по-настоящему.
    const ok = mkRealDeps({ failWrite: false });
    const res2 = await create(ok.deps).syncBillStatuses();
    expect(res2).toEqual({ checked: 1, paid: 1 });
    expect(ok.inMemoryBill.status).toBe('paid');
    expect(db.prepare('SELECT status FROM bills WHERE id = ?').get(BILL_ID).status).toBe('paid');
    expect(ok.deps.saveClients).toHaveBeenCalled();
    expect(ok.deps.logActivity).toHaveBeenCalledWith('billing', 'info', 'bill_auto_paid', 'DEEP18',
      expect.any(String), expect.objectContaining({ bill_id: BILL_ID }));
  });

  it('updateBillStatus обновил 0 строк → не paid (как settlement: changes=0 — не подтверждение)', async () => {
    const { deps, inMemoryBill } = mkRealDeps({ failWrite: 'noop' });
    const res = await create(deps).syncBillStatuses();

    expect(res).toEqual({ checked: 1, paid: 0 });
    expect(inMemoryBill.status).toBe('unpaid');
    expect(db.prepare('SELECT status FROM bills WHERE id = ?').get(BILL_ID).status).toBe('unpaid');
    expect(deps.saveClients).not.toHaveBeenCalled();
    expect(deps.logger.error).toHaveBeenCalled();
  });
});
