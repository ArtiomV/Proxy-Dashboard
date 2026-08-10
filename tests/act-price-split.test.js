// B1 (Р14/Р32): смена цены mid-month — акт разбивается на строки по периодам
// цен (per_gb — непрерывные периоды одной цены; per_modem — группы цена×
// количество модемов). Без смены цены формат строк не меняется (регрессия
// старого поведения покрыта tochka-act-positions.test.js).

import { describe, it, expect } from 'vitest';
import documents from '../src/tochka/documents.js';

const { buildActItemsFromLedger } = documents;
const sum = items => Math.round(items.reduce((s, i) => s + (i.amount || 0), 0) * 100) / 100;

const client = { id: 'c1', price: 250, billingType: 'per_gb' };

// per_gb: 14 дней по 250 ₽/ГБ, затем 17 дней по 220 ₽/ГБ (смена цены 15-го).
function gbLedgerTwoPrices() {
  const entries = [];
  for (let d = 1; d <= 31; d++) {
    const price = d <= 14 ? 250 : 220;
    const gb = 2;
    entries.push({
      type: 'charge', billing_type: 'per_gb',
      date: `2026-08-${String(d).padStart(2, '0')}`,
      cost: Math.round(price * gb * 100) / 100,
      delta_gb: gb, price_per_unit: price,
    });
  }
  return entries;
}

// per_modem: 15 дней аренды 10 модемов по 300 ₽/мес, затем 16 дней по 330 ₽/мес.
function modemLedgerTwoPrices() {
  const entries = [];
  for (let d = 1; d <= 31; d++) {
    const price = d <= 15 ? 300 : 330;
    entries.push({
      type: 'charge', billing_type: 'per_modem',
      date: `2026-08-${String(d).padStart(2, '0')}`,
      cost: Math.round((price * 10 / 31) * 100) / 100,
      modem_count: 10, days_in_month: 31, price_per_unit: price,
    });
  }
  return entries;
}

describe('buildActItemsFromLedger — разбивка по ценам (B1)', () => {
  it('per_gb: смена цены → две строки с периодами и ставками', () => {
    const { actItems, totalCost } = buildActItemsFromLedger(client, '2026-08', () => gbLedgerTwoPrices());
    expect(actItems.length).toBe(2);

    const [first, second] = actItems;
    expect(first.name).toContain('01.08–14.08');
    expect(first.name).toContain('по 250 ₽/ГБ');
    expect(first.price).toBe(250);
    expect(first.quantity).toBe(28);            // 14 дн × 2 ГБ
    expect(first.amount).toBe(7000);

    expect(second.name).toContain('15.08–31.08');
    expect(second.name).toContain('по 220 ₽/ГБ');
    expect(second.price).toBe(220);
    expect(second.quantity).toBe(34);           // 17 дн × 2 ГБ
    expect(second.amount).toBe(7480);

    expect(totalCost).toBe(14480);
    expect(sum(actItems)).toBe(totalCost);      // строки сходятся с начисленным
  });

  it('per_gb: одна цена весь месяц → одна строка в старом формате', () => {
    const entries = gbLedgerTwoPrices().map(e => ({ ...e, price_per_unit: 250, cost: 500 }));
    const { actItems } = buildActItemsFromLedger(client, '2026-08', () => entries);
    expect(actItems.length).toBe(1);
    expect(actItems[0].name).toBe('Услуги мобильных прокси (трафик за август 2026)');
    expect(actItems[0].amount).toBe(15500);
  });

  it('per_gb: непрерывные периоды одной цены склеиваются, прерванные — нет', () => {
    const entries = [
      { type: 'charge', billing_type: 'per_gb', date: '2026-08-01', cost: 250, delta_gb: 1, price_per_unit: 250 },
      { type: 'charge', billing_type: 'per_gb', date: '2026-08-02', cost: 220, delta_gb: 1, price_per_unit: 220 },
      { type: 'charge', billing_type: 'per_gb', date: '2026-08-03', cost: 250, delta_gb: 1, price_per_unit: 250 },
      { type: 'charge', billing_type: 'per_gb', date: '2026-08-04', cost: 250, delta_gb: 1, price_per_unit: 250 },
    ];
    const { actItems } = buildActItemsFromLedger(client, '2026-08', () => entries);
    // 250 | 220 | 250+250 → три сегмента (первый и последний НЕ склеиваются)
    expect(actItems.length).toBe(3);
    expect(actItems[2].quantity).toBe(2);
    expect(actItems[2].name).toContain('03.08–04.08');
  });

  it('per_gb: legacy-строки без price_per_unit группируются по текущей цене клиента', () => {
    const entries = [
      { type: 'charge', billing_type: 'per_gb', date: '2026-08-01', cost: 500, delta_gb: 2 },
      { type: 'charge', billing_type: 'per_gb', date: '2026-08-02', cost: 500, delta_gb: 2 },
    ];
    const { actItems } = buildActItemsFromLedger(client, '2026-08', () => entries);
    expect(actItems.length).toBe(1);            // одна цена (client.price=250) — одна строка
  });

  it('per_modem: смена цены → две строки с пометкой цены', () => {
    const modemClient = { id: 'c2', price: 300, billingType: 'per_modem' };
    const { actItems, totalCost } = buildActItemsFromLedger(modemClient, '2026-08', () => modemLedgerTwoPrices());
    expect(actItems.length).toBe(2);
    // Сортировка: сначала самый длинный период (16 дн по 330), затем 15 дн по 300.
    expect(actItems[0].name).toContain('по 330 ₽/мес');
    expect(actItems[0].name).toContain('× 16 дней');
    expect(actItems[1].name).toContain('по 300 ₽/мес');
    expect(actItems[1].name).toContain('× 15 дней');
    expect(actItems[0].quantity).toBe(10);
    expect(actItems[1].quantity).toBe(10);
    expect(sum(actItems)).toBe(totalCost);
  });

  it('per_modem: одна цена → пометки цены нет (старый формат строк)', () => {
    const modemClient = { id: 'c3', price: 300, billingType: 'per_modem' };
    const entries = modemLedgerTwoPrices().map(e => ({ ...e, price_per_unit: 300, cost: Math.round((300 * 10 / 31) * 100) / 100 }));
    const { actItems } = buildActItemsFromLedger(modemClient, '2026-08', () => entries);
    expect(actItems.length).toBe(1);
    expect(actItems[0].name).not.toContain('₽/мес');
    expect(actItems[0].name).toContain('аренда 10 модемов × 31 день');
  });
});
