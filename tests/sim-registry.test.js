import { describe, expect, it } from 'vitest';
import registry from '../src/inventory/sim-registry.js';

const { normalizeIccid, normalizePhone, parseSimRegistryText } = registry;

describe('SIM registry import', () => {
  it('parses Russian semicolon headers and normalizes identifiers', () => {
    const parsed = parseSimRegistryText([
      'ICCID;Телефон;Оператор;Примечание',
      '8937 3123 4567 8901 234;+373 (60) 111-222;Orange;Корпоративная',
    ].join('\n'));
    expect(parsed.errors).toEqual([]);
    expect(parsed.rows).toEqual([{
      iccid: '8937312345678901234',
      phone: '+37360111222',
      operator: 'Orange',
      notes: 'Корпоративная',
    }]);
  });

  it('accepts a headerless tab-separated export', () => {
    const parsed = parseSimRegistryText('8937312345678901234\t060111222\tMoldcell');
    expect(parsed.rows[0]).toMatchObject({
      iccid: '8937312345678901234',
      phone: '060111222',
      operator: 'Moldcell',
    });
  });

  it('keeps the last duplicate and reports invalid rows without aborting the import', () => {
    const parsed = parseSimRegistryText([
      'ICCID,phone,operator',
      '8937312345678901234,+37360111111,Orange',
      'bad,+37360111111,Orange',
      '8937312345678901234,+37360222222,Orange',
    ].join('\n'));
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rows[0].phone).toBe('+37360222222');
    expect(parsed.errors).toEqual([{ line: 3, error: 'Некорректный ICCID (ожидается 15–24 цифры)' }]);
  });

  it('rejects malformed ICCIDs and phones', () => {
    expect(normalizeIccid('123')).toBe('');
    expect(normalizePhone('abc')).toBe('');
    expect(normalizeIccid('8937-3123-4567-8901-234')).toBe('8937312345678901234');
  });
});

