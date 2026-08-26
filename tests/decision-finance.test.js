import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const decision = require('../src/billing/decision-finance.js');

describe('decision finance', () => {
  it('forecasts revenue without renewals from port expiry dates', () => {
    const now = new Date('2026-08-01T00:00:00.000Z');
    const f = decision.forecastRevenue30d([
      { id: 'a', name: 'A', billingType: 'per_modem', price: 3000, assets: [{ validBefore: '2026-08-10' }, { validBefore: '' }] },
    ], now);
    expect(f.with_renewals).toBe(6000);
    expect(f.without_renewals).toBe(4000);
    expect(f.revenue_at_risk).toBe(2000);
  });

  it('groups receivables by the age of negative balance', () => {
    const a = decision.buildReceivablesAging([
      { id: 'a', name: 'A', balance: -100, balanceNegativeSince: '2026-07-01T00:00:00Z' },
      { id: 'b', name: 'B', balance: -50, balanceNegativeSince: '2026-07-27T00:00:00Z' },
    ], new Date('2026-08-01T00:00:00Z'));
    expect(a.total).toBe(150);
    expect(a.buckets.days_31_plus.amount).toBe(100);
    expect(a.buckets.current.amount).toBe(50);
  });

  it('allocates SIM and location expenses to the clients that consume them', () => {
    const u = decision.allocateUnitEconomics([
      { id: 'a', name: 'A', revenue: 1000, assets: [{ server: 'S1', operator: 'Orange' }] },
      { id: 'b', name: 'B', revenue: 1000, assets: [{ server: 'S2', operator: 'Digi' }] },
    ], [
      { category: 'sim', subkey: 'Orange', amount_rub: 100 },
      { category: 'server', subkey: 'location:one', amount_rub: 200 },
      { category: 'other', subkey: null, amount_rub: 100 },
    ], { S1: 'location:one', S2: 'location:two' });
    const a = u.rows.find(r => r.id === 'a');
    const b = u.rows.find(r => r.id === 'b');
    expect(a.allocated_cost).toBe(350);
    expect(b.allocated_cost).toBe(50);
    expect(u.unallocated_cost).toBe(0);
  });
});
