// Guards the rule that broke act-filing for ООО "СОВРЕМЕННЫЕ РЕЧЕВЫЕ
// ТЕХНОЛОГИИ": Tochka rejects any document position with price < 0 or
// totalAmount < 0 (HTTP 400 "Input should be greater than or equal to 0").
//
// Our local acts can carry a negative line — a rounding correction
// («Корректировка округления», emitted when qty×price overshot the billed
// total by a kopeck) or a refund («Корректировка (возврат)»). Those render
// fine in our own PDF but must never reach the bank as a negative position.
// sanitizeActPositionsForTochka folds them into the largest positive line so
// the act still sums to exactly what was billed and every position is ≥ 0.

import { describe, it, expect } from 'vitest';
import documents from '../src/tochka/documents.js';

const { sanitizeActPositionsForTochka, buildTochkaActBody, buildActItemsFromLedger } = documents;
const sum = items => Math.round(items.reduce((s, i) => s + (i.amount || 0), 0) * 100) / 100;

// Synthetic May ledger: 30 days at 22 modems + 1 day at 23 modems, tariff 4250.
function mayModemLedger() {
  const entries = [];
  for (let d = 1; d <= 31; d++) {
    const modems = d === 15 ? 23 : 22;
    const cost = Math.round((4250 * modems / 31) * 100) / 100; // daily prorated
    entries.push({
      type: 'charge', billing_type: 'per_modem',
      date: `2026-05-${String(d).padStart(2, '0')}`,
      cost, modem_count: modems, days_in_month: 31, price_per_unit: 4250,
    });
  }
  return entries;
}

describe('sanitizeActPositionsForTochka', () => {
  it('folds a negative rounding-correction line into the main line (the real May bug)', () => {
    // Exactly the stored May act for the affected client.
    const items = [
      { name: 'Аренда модемов за май 2026', quantity: 22.03, unit: 'шт', price: 4250.44, amount: 93637.19 },
      { name: 'Корректировка округления', quantity: 1, unit: 'услуга', price: -0.06, amount: -0.06 },
    ];
    const out = sanitizeActPositionsForTochka(items);
    // No negative positions survive.
    expect(out.every(p => (p.price || 0) >= 0 && (p.amount || 0) >= 0)).toBe(true);
    // The act total is preserved exactly.
    expect(sum(out)).toBe(93637.13);
    // The correction line is gone; the main line absorbed it.
    expect(out.length).toBe(1);
    expect(out[0].amount).toBe(93637.13);
  });

  it('folds a negative refund correction into the largest positive line', () => {
    const items = [
      { name: 'Аренда модемов', quantity: 10, unit: 'шт', price: 1000, amount: 10000 },
      { name: 'Корректировка (возврат)', quantity: 1, unit: 'услуга', price: -250, amount: -250 },
    ];
    const out = sanitizeActPositionsForTochka(items);
    expect(out.every(p => (p.price || 0) >= 0 && (p.amount || 0) >= 0)).toBe(true);
    expect(sum(out)).toBe(9750);
    expect(out.length).toBe(1);
    expect(out[0].amount).toBe(9750);
    // price recomputed so it stays consistent with the new amount.
    expect(out[0].price).toBe(975);
  });

  it('leaves an all-positive act untouched', () => {
    const items = [
      { name: 'Трафик', quantity: 22.03, unit: 'ГБ', price: 23, amount: 506.69 },
      { name: 'Доначисление', quantity: 1, unit: 'услуга', price: 100, amount: 100 },
    ];
    const out = sanitizeActPositionsForTochka(items);
    expect(out.length).toBe(2);
    expect(sum(out)).toBe(606.69);
  });

  it('degrades a pure-refund act to a single zero line instead of a 400', () => {
    const items = [{ name: 'Корректировка (возврат)', quantity: 1, unit: 'услуга', price: -500, amount: -500 }];
    const out = sanitizeActPositionsForTochka(items);
    expect(out.length).toBe(1);
    expect(out[0].amount).toBe(0);
    expect(out[0].price).toBe(0);
  });
});

describe('buildActItemsFromLedger — per-modem-count breakdown (the 22.03 question)', () => {
  it('emits one line per distinct modem count, longest period first, summing exactly', () => {
    const client = { id: 'c1', name: 'Тест', billingType: 'per_modem', price: 4250 };
    const { actItems, totalCost } = buildActItemsFromLedger(client, '2026-05', () => mayModemLedger());

    // Two distinct counts → two lines (not one averaged 22.03 line).
    expect(actItems.length).toBe(2);
    // Longest period first: 22 modems × 30 days.
    expect(actItems[0].quantity).toBe(22);
    expect(actItems[0].amount).toBe(90483.90);
    expect(actItems[0].name).toContain('22 модема × 30 дней');
    // Then 23 modems × 1 day.
    expect(actItems[1].quantity).toBe(23);
    expect(actItems[1].amount).toBe(3153.23);
    expect(actItems[1].name).toContain('23 модема × 1 день');
    // Lines add up to exactly what was billed.
    expect(totalCost).toBe(93637.13);
    expect(sum(actItems)).toBe(93637.13);
    // No negative / zero-illegal positions.
    expect(actItems.every(i => i.price >= 0 && i.amount >= 0)).toBe(true);
  });

  it('collapses to a single averaged line when the count never changes', () => {
    const client = { id: 'c2', name: 'Тест', billingType: 'per_modem', price: 4250 };
    const flat = [];
    for (let d = 1; d <= 31; d++) {
      flat.push({ type: 'charge', billing_type: 'per_modem', date: `2026-05-${String(d).padStart(2, '0')}`,
        cost: Math.round((4250 * 22 / 31) * 100) / 100, modem_count: 22, days_in_month: 31, price_per_unit: 4250 });
    }
    const { actItems } = buildActItemsFromLedger(client, '2026-05', () => flat);
    expect(actItems.length).toBe(1);
    expect(actItems[0].quantity).toBe(22);
    expect(actItems[0].name).toContain('22 модема × 31 день');
  });
});

describe('buildTochkaActBody — no negative position ever leaves the builder', () => {
  const cfg = { accountId: 'acc', customerCode: 'cc' };
  const client = { name: 'Тест', inn: '9704223433', kpp: '770401001' };

  it('ships only non-negative positions even when items contain a negative correction', () => {
    const items = [
      { name: 'Аренда модемов за май 2026', quantity: 22.03, unit: 'шт', price: 4250.44, amount: 93637.19 },
      { name: 'Корректировка округления', quantity: 1, unit: 'услуга', price: -0.06, amount: -0.06 },
    ];
    const body = buildTochkaActBody(cfg, client, '2026-05', items, 'АКТ-202605-b086');
    const positions = body.Data.Content.Act.Positions;
    expect(positions.every(p => p.price >= 0 && p.totalAmount >= 0)).toBe(true);
    // Act total matches the billed amount.
    expect(body.Data.Content.Act.totalAmount).toBe(93637.13);
    // positionNumber stays 1-based and contiguous after the fold.
    expect(positions.map(p => p.positionNumber)).toEqual(positions.map((_, i) => i + 1));
  });
});
