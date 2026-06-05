// Payment → client matching by INN (primary) or normalized company name.
// The real case that motivated name-matching: a Tochka payment whose payer
// name is in a different legal form than our stored client name.

import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { normCompanyName, findClientByPayer } = require('../src/billing/payer-match.js');

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
