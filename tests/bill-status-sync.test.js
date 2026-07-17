import { describe, it, expect, vi } from 'vitest';
import { create } from '../src/jobs/bill-status-sync';

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
