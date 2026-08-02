// calculateMonthlyBillDetails (per_gb): счёт = MAX(прошлый месяц, среднесуточное
// за последние 7 дней × дней в месяце × тариф) + долг, округление вверх до 10 000 ₽.
// Формула оператора 2026-08-02 (без коэффициента-маржи и без live-счётчиков).

import { describe, it, expect } from 'vitest';
import documents from '../src/tochka/documents.js';

const { calculateMonthlyBillAmount, calculateMonthlyBillDetails, formatBillFormula } = documents;

function ym(offset) { const d = new Date(); d.setMonth(d.getMonth() + offset); return d.toISOString().slice(0, 7); }
function daysAgo(n) { return new Date(Date.now() - n * 86400000).toISOString().slice(0, 10); }
const NOW = new Date();
const DAYS_IN_MONTH = new Date(NOW.getUTCFullYear(), NOW.getUTCMonth() + 1, 0).getDate();
const PREV = ym(-1);

const round10k = v => Math.ceil(v / 10000) * 10000;
const ledgerOf = entries => () => entries;

describe('calculateMonthlyBillAmount (per_gb, формула avg-7дн)', () => {
  const client = { id: 'C1', portName: 'X', billingType: 'per_gb', price: 23, balance: 0 };

  it('счёт = MAX(прошлый месяц, avg-7дн × дней × тариф)', () => {
    // 700 ГБ за последние 7 дней → 100 ГБ/день → 100 × daysInMonth × 23 прогноз.
    const entries = [{ type: 'charge', date: PREV + '-15', cost: 50000, delta_gb: 2000 }];
    for (let i = 1; i <= 7; i++) entries.push({ type: 'charge', date: daysAgo(i), cost: 2300, delta_gb: 100 });
    const forecast = 100 * DAYS_IN_MONTH * 23;
    expect(calculateMonthlyBillAmount(client, [], ledgerOf(entries))).toBe(round10k(Math.max(50000, forecast)));
  });

  it('текущих списаний нет → счёт по прошлому месяцу', () => {
    const entries = [{ type: 'charge', date: PREV + '-15', cost: 373526.04, delta_gb: 16240 }];
    expect(calculateMonthlyBillAmount(client, [], ledgerOf(entries))).toBe(380000);
  });

  it('долг добавляется к базе до округления', () => {
    const entries = [{ type: 'charge', date: PREV + '-15', cost: 100000, delta_gb: 4000 }];
    const inDebt = { ...client, balance: -25000 };
    expect(calculateMonthlyBillAmount(inDebt, [], ledgerOf(entries))).toBe(round10k(100000 + 25000));
  });

  it('совсем без списаний → 0 (счёт не выставляется)', () => {
    expect(calculateMonthlyBillAmount(client, [], ledgerOf([]))).toBe(0);
  });

  it('просадка не уронит счёт: берётся прошлый месяц', () => {
    const entries = [{ type: 'charge', date: PREV + '-15', cost: 500000, delta_gb: 20000 }];
    entries.push({ type: 'charge', date: daysAgo(1), cost: 100, delta_gb: 5 });
    expect(calculateMonthlyBillAmount(client, [], ledgerOf(entries))).toBe(500000);
  });
});

describe('calculateMonthlyBillDetails + formatBillFormula', () => {
  const client = { id: 'C1', portName: 'X', billingType: 'per_gb', price: 23, balance: 0 };

  it('формула хранит разбор: прошлый месяц, avg-7дн, тариф, округление', () => {
    const entries = [{ type: 'charge', date: PREV + '-15', cost: 373526.04, delta_gb: 16240 }];
    for (let i = 1; i <= 7; i++) entries.push({ type: 'charge', date: daysAgo(i), cost: 2300, delta_gb: 100 });
    const d = calculateMonthlyBillDetails(client, [], ledgerOf(entries));
    // prev_amount = июльский charge + те из 7 дневных, что попали в прошлый месяц.
    const expectedPrev = entries.filter(e => e.date.startsWith(PREV)).reduce((s, e) => s + e.cost, 0);
    expect(d.formula.kind).toBe('per_gb');
    expect(d.formula.prev_amount).toBe(expectedPrev);
    expect(d.formula.avg_daily_gb).toBe(100);
    expect(d.formula.run_rate_gb).toBe(700);
    expect(d.formula.days_in_month).toBe(DAYS_IN_MONTH);
    expect(d.formula.price).toBe(23);
    expect(d.formula.forecast_amount).toBe(100 * DAYS_IN_MONTH * 23);
    const txt = formatBillFormula(d.formula).replace(/[\s\u00A0\u202F]/g, ' ');
    expect(txt).toContain('MAX (');
    expect(txt).toContain('100 ГБ/день');
    expect(txt).toContain('× 23 ₽');
  });

  it('ручная сумма → «вручную», per_modem → «N мод. × price»', () => {
    expect(formatBillFormula({ kind: 'manual' })).toBe('Сумма задана вручную');
    expect(formatBillFormula({ kind: 'per_modem', modem_count: 12, price: 4250, debt: 0 }).replace(/[\s\u00A0\u202F]/g, ' ')).toBe('12 мод. × 4 250 ₽');
  });
});
