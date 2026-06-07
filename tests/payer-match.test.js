// Payment → client matching by INN (primary) or normalized company name.
// The real case that motivated name-matching: a Tochka payment whose payer
// name is in a different legal form than our stored client name.

import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { normCompanyName, findClientByPayer, buildNaturalKey } = require('../src/billing/payer-match.js');

describe('buildNaturalKey', () => {
  it('webhook and sync produce the SAME key for one payment (the 265000.0 vs 265000 bug)', () => {
    // Webhook delivered amount as a float 265000.0; sync as int 265000. Before the
    // shared builder these produced different natural keys → duplicate rows + the
    // sync could not reconcile/credit the webhook row.
    const webhook = buildNaturalKey('1683018490', 265000.0, '2026-05-21', 'Оплата за прокси');
    const sync    = buildNaturalKey('1683018490', 265000,   '2026-05-21', 'Оплата за прокси');
    expect(webhook).toBe(sync);
    expect(webhook).toContain('|265000|');     // no stray ".0"
  });
  it('preserves real decimals and slices date + purpose', () => {
    expect(buildNaturalKey('77', 4250.44, '2026-03-22T10:00:00', 'x'.repeat(150)))
      .toBe('77|4250.44|2026-03-22|' + 'x'.repeat(100));
  });
  it('tolerates string amounts and missing fields', () => {
    expect(buildNaturalKey('77', '265000.00', '2026-05-21', 'p')).toBe('77|265000|2026-05-21|p');
    expect(buildNaturalKey('', null, '', '')).toBe('|0||');  // Number(null)=0; empty inn/date/purpose
  });
});

describe('normCompanyName', () => {
  it('strips legal form, quotes, case → comparable core name', () => {
    expect(normCompanyName('ООО "ПАЛИТРУМЛАБ"')).toBe('палитрумлаб');
    expect(normCompanyName('Общество с ограниченной ответственностью "ПалитрумЛаб"')).toBe('палитрумлаб');
    expect(normCompanyName('АО «Ромашка»')).toBe('ромашка');
    expect(normCompanyName('ПАО Сбербанк')).toBe('сбербанк');
    expect(normCompanyName('ИП Иванов Иван Иванович')).toBe('иванов иван иванович');
    expect(normCompanyName('ё-Мобиль')).toBe('е мобиль');
  });
  it('returns empty for a bare legal form or blank', () => {
    expect(normCompanyName('ООО')).toBe('');
    expect(normCompanyName('')).toBe('');
    expect(normCompanyName(null)).toBe('');
  });
});

describe('findClientByPayer', () => {
  const clients = [
    { id: 'a', name: 'ООО "ПАЛИТРУМЛАБ"', inn: '7727796050' },
    { id: 'b', name: 'ООО "ВАЙЛДБОКС"', inn: '1683018490' },
    { id: 'c', name: 'ООО "Ромашка"', inn: '1111' },
    { id: 'd', name: 'АО "Ромашка"', inn: '2222' },   // same core name → ambiguous
  ];
  const byInn = new Map(clients.map(c => [c.inn, c]));

  it('matches by INN first (by=inn)', () => {
    const m = findClientByPayer('1683018490', 'что угодно', byInn, clients);
    expect(m.client.id).toBe('b');
    expect(m.by).toBe('inn');
  });

  it('falls back to company name when INN is absent / not found (by=name)', () => {
    const m = findClientByPayer('', 'Общество с ограниченной ответственностью "ПалитрумЛаб"', byInn, clients);
    expect(m.client.id).toBe('a');
    expect(m.by).toBe('name');
  });

  it('matches by name when the INN does not map to any client', () => {
    const m = findClientByPayer('9999999999', 'ООО ВАЙЛДБОКС', byInn, clients);
    expect(m.client.id).toBe('b');
    expect(m.by).toBe('name');
  });

  it('refuses an AMBIGUOUS name (two clients share the core name)', () => {
    expect(findClientByPayer('', 'ООО Ромашка', byInn, clients)).toBeNull();
  });

  it('returns null for an unknown payer', () => {
    expect(findClientByPayer('0000', 'ООО "Незнакомец"', byInn, clients)).toBeNull();
  });
});
