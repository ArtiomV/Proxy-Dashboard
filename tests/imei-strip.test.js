'use strict';
// Тесты stripServerPrefix — срезание серверного префикса с IMEI.
// Регрессия 27.08: для сервера RO1-MF289 префикс не срезался регэкспом /^S\d+_/,
// и на бокс улетал IMEI вида "RO1-MF289_8673…" — ProxySmart молча реджектил формы.
import { describe, it, expect } from 'vitest';
import { stripServerPrefix } from '../src/utils/imei';

describe('stripServerPrefix', () => {
  it('срезает префикс по имени сервера', () => {
    expect(stripServerPrefix('RO1-MF289_867389050591949', 'RO1-MF289')).toBe('867389050591949');
    expect(stripServerPrefix('S1_867389050591949', 'S1')).toBe('867389050591949');
  });

  it('legacy-регэксп без имени сервера', () => {
    expect(stripServerPrefix('S2_012345678901234')).toBe('012345678901234');
    // без имени сервера не-S префикс НЕ срезаем (не угадываем)
    expect(stripServerPrefix('RO1-MF289_012345678901234')).toBe('RO1-MF289_012345678901234');
  });

  it('не портит чистый IMEI', () => {
    expect(stripServerPrefix('867389050591949', 'RO1-MF289')).toBe('867389050591949');
    expect(stripServerPrefix('867389050591949')).toBe('867389050591949');
  });

  it('пустые значения', () => {
    expect(stripServerPrefix('')).toBe('');
    expect(stripServerPrefix(null, 'S1')).toBe('');
    expect(stripServerPrefix(undefined)).toBe('');
  });
});
