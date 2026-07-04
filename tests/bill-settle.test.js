import { describe, it, expect, vi } from 'vitest';
import { settleBillsOnPayment } from '../src/billing/bill-settle';

function mkDeps() {
  return {
    documentsDb: { updateBillStatus: vi.fn() },
    logActivity: vi.fn(),
    logger: { error: vi.fn() },
  };
}
function bill(id, period, amount, status = 'unpaid', billNumber = null) {
  return { id, period, amount, status, billNumber: billNumber || `СЧЁТ-${period.replace('-', '')}-xxxx` };
}

describe('settleBillsOnPayment', () => {
  it('матчит по номеру счёта в назначении (е≡ё, регистронезависимо)', () => {
    const deps = mkDeps();
    const client = { id: 'c1', name: 'X', bills: [bill('b1', '2026-07', 240000, 'unpaid', 'СЧЁТ-202607-b389')] };
    const paid = settleBillsOnPayment(client, 500000, 'Оплата по счету №СЧЕТ-202607-b389 от 01.07.2026г. предоплата', deps);
    expect(paid.map(b => b.id)).toEqual(['b1']);
    expect(client.bills[0].status).toBe('paid');
    expect(deps.documentsDb.updateBillStatus).toHaveBeenCalledWith('b1', 'paid');
  });

  it('жадно закрывает и более старый счёт остатком платежа', () => {
    const deps = mkDeps();
    const client = { id: 'c1', name: 'X', bills: [
      bill('june', '2026-06', 160000, 'unpaid', 'СЧЁТ-202606-b389'),
      bill('july', '2026-07', 240000, 'unpaid', 'СЧЁТ-202607-b389'),
    ] };
    const paid = settleBillsOnPayment(client, 500000, 'Оплата по счету №СЧЕТ-202607-b389', deps);
    expect(paid.map(b => b.id).sort()).toEqual(['july', 'june'].sort());
  });

  it('матчит по точной сумме без номера в назначении', () => {
    const deps = mkDeps();
    const client = { id: 'c1', name: 'X', bills: [bill('b1', '2026-07', 93500)] };
    const paid = settleBillsOnPayment(client, 93500, 'Пополнение баланса по договору', deps);
    expect(paid.map(b => b.id)).toEqual(['b1']);
  });

  it('частичная оплата счёт НЕ закрывает', () => {
    const deps = mkDeps();
    const client = { id: 'c1', name: 'X', bills: [bill('b1', '2026-07', 240000)] };
    const paid = settleBillsOnPayment(client, 100000, 'частичная оплата', deps);
    expect(paid).toEqual([]);
    expect(client.bills[0].status).toBe('unpaid');
  });

  it('не закрывает новый счёт, пока старый не покрыт (стоп на первом непокрытом)', () => {
    const deps = mkDeps();
    const client = { id: 'c1', name: 'X', bills: [
      bill('old', '2026-06', 300000),
      bill('new', '2026-07', 50000),
    ] };
    const paid = settleBillsOnPayment(client, 50000, 'оплата', deps);
    // точная сумма совпала с новым счётом — правило 2 закрывает его,
    // но жадное правило не трогает старый (не покрыт)
    expect(paid.map(b => b.id)).toEqual(['new']);
    expect(client.bills[0].status).toBe('unpaid');
  });

  it('оплаченные и нулевые счета игнорируются, пустой клиент безопасен', () => {
    const deps = mkDeps();
    expect(settleBillsOnPayment({ id: 'c', name: 'X' }, 100, 'x', deps)).toEqual([]);
    const client = { id: 'c1', name: 'X', bills: [bill('b1', '2026-07', 100, 'paid')] };
    expect(settleBillsOnPayment(client, 100, 'x', deps)).toEqual([]);
  });
});
