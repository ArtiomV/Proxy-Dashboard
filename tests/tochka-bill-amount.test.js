// calculateMonthlyBillAmount (per_gb): счёт = max(прошлый месяц, прогноз
// текущего run-rate ×1.1) + долг, округление вверх до 10 000 ₽.
// Регрессия 2026-08-02 (БА): счёт только по прошлому месяцу (380k) при росте
// потребления (~620k прогноз) уводил клиента в минус в середине месяца.

import { describe, it, expect } from 'vitest';
import documents from '../src/tochka/documents.js';

const { calculateMonthlyBillAmount } = documents;

function ym(offset) { const d = new Date(); d.setMonth(d.getMonth() + offset); return d.toISOString().slice(0, 7); }
const NOW = new Date();
const DAYS_ELAPSED = Math.max(1, NOW.getUTCDate());
const DAYS_IN_MONTH = new Date(NOW.getUTCFullYear(), NOW.getUTCMonth() + 1, 0).getDate();
const PREV = ym(-1), CUR = ym(0);

const round10k = v => Math.ceil(v / 10000) * 10000;
const ledgerOf = entries => () => entries;

describe('calculateMonthlyBillAmount (per_gb, прогноз)', () => {
  const client = { id: 'C1', portName: 'X', billingType: 'per_gb', price: 23, balance: 0 };

  it('прогноз текущего месяца больше прошлого → счёт по прогнозу ×1.1', () => {
    const entries = [
      { type: 'charge', date: PREV + '-15', cost: 100000, delta_gb: 4000 },
      { type: 'charge', date: CUR + '-01', cost: 10000, delta_gb: 2000 },
    ];
    const forecast = (2000 / DAYS_ELAPSED) * DAYS_IN_MONTH * 23 * 1.1;
    const expected = round10k(Math.max(100000, forecast));
    expect(calculateMonthlyBillAmount(client, [], ledgerOf(entries))).toBe(expected);
  });

  it('текущий месяц пуст → счёт по прошлому', () => {
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

  it('прогноз не шатает счёт вниз: при просадке берётся прошлый месяц', () => {
    const entries = [
      { type: 'charge', date: PREV + '-15', cost: 500000, delta_gb: 20000 },
      { type: 'charge', date: CUR + '-01', cost: 100, delta_gb: 10 },
    ];
    expect(calculateMonthlyBillAmount(client, [], ledgerOf(entries))).toBe(500000);
  });

  it('живой счётчик свежий → прогноз берёт max(ledger, live)', () => {
    // В ledger августа почти нет (списание за вчера), а живой месячный счётчик
    // уже большой — прогноз должен пойти по live (кейс БА 2026-08-02).
    const entries = [{ type: 'charge', date: PREV + '-15', cost: 373526.04, delta_gb: 16240 }];
    const liveGb = 26000; // 26 ТБ run-rate, как у БА
    const liveBytes = liveGb * 1e9;
    const cached = [{ bw: { p1: { portName: 'X', bandwidth_bytes_month_in: String(liveBytes / 2), bandwidth_bytes_month_out: String(liveBytes / 2) } } }];
    const forecast = (liveGb / DAYS_ELAPSED) * DAYS_IN_MONTH * 23 * 1.1;
    const expected = round10k(Math.max(373526.04, forecast));
    expect(calculateMonthlyBillAmount(client, cached, ledgerOf(entries))).toBe(expected);
  });
});
