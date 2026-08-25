import { describe, expect, it } from 'vitest';
import registry from '../src/inventory/sim-registry.js';

const { normalizeIccid, normalizePhone, parseSimRegistryText } = registry;

describe('SIM registry import', () => {
  it('parses Russian semicolon headers and normalizes identifiers', () => {
    const parsed = parseSimRegistryText([
      'ICCID;Телефон;Оператор;Примечание',
      '8937 3123 4567 8901 2342;+373 (60) 111-222;Orange;Корпоративная',
    ].join('\n'));
    expect(parsed.errors).toEqual([]);
    expect(parsed.rows).toEqual([{
      iccid: '89373123456789012342',
      phone: '+37360111222',
      operator: 'Orange',
      notes: 'Корпоративная',
    }]);
  });

  it('accepts a headerless tab-separated export', () => {
    const parsed = parseSimRegistryText('89373123456789012342\t060111222\tMoldcell');
    expect(parsed.rows[0]).toMatchObject({
      iccid: '89373123456789012342',
      phone: '060111222',
      operator: 'Moldcell',
    });
  });

  it('restores the Luhn check digit truncated by operator exports (19 → 20 digits)', () => {
    // Реальная пара из выгрузки Moldtelecom и ответа бокса
    expect(normalizeIccid('8937303000002867088')).toBe('89373030000028670882');
    expect(normalizeIccid('8937301220718162710')).toBe('89373012207181627102');
    // Полный 20-значный ICCID не изменяется
    expect(normalizeIccid('89373030000028670882')).toBe('89373030000028670882');
    const parsed = parseSimRegistryText('ICCID;Телефон\n8937303000002867088;37367779662');
    expect(parsed.errors).toEqual([]);
    expect(parsed.rows[0].iccid).toBe('89373030000028670882');
  });

  it('keeps the last duplicate and reports invalid rows without aborting the import', () => {
    const parsed = parseSimRegistryText([
      'ICCID,phone,operator',
      '89373123456789012342,+37360111111,Orange',
      'bad,+37360111111,Orange',
      '89373123456789012342,+37360222222,Orange',
    ].join('\n'));
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rows[0].phone).toBe('+37360222222');
    expect(parsed.errors).toEqual([{ line: 3, error: 'Некорректный ICCID (ожидается 15–24 цифры)' }]);
  });

  it('rejects malformed ICCIDs and phones', () => {
    expect(normalizeIccid('123')).toBe('');
    expect(normalizePhone('abc')).toBe('');
    expect(normalizeIccid('8937-3123-4567-8901-2342')).toBe('89373123456789012342');
  });
});

