import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { _isQuietTime } = require('../src/telegram/alerts');

function utc(value) { return new Date(value).getTime(); }

describe('Telegram quiet window (MSK)', () => {
  it('covers an overnight 23:00–08:00 interval', () => {
    expect(_isQuietTime(utc('2026-08-25T20:00:00Z'), '23:00', '08:00')).toBe(true);
    expect(_isQuietTime(utc('2026-08-26T04:59:00Z'), '23:00', '08:00')).toBe(true);
    expect(_isQuietTime(utc('2026-08-26T05:00:00Z'), '23:00', '08:00')).toBe(false);
  });

  it('supports same-day windows and rejects invalid/equal bounds', () => {
    expect(_isQuietTime(utc('2026-08-26T10:30:00Z'), '13:00', '14:00')).toBe(true);
    expect(_isQuietTime(utc('2026-08-26T12:00:00Z'), '13:00', '14:00')).toBe(false);
    expect(_isQuietTime(utc('2026-08-26T10:30:00Z'), '25:00', '14:00')).toBe(false);
    expect(_isQuietTime(utc('2026-08-26T10:30:00Z'), '13:00', '13:00')).toBe(false);
  });
});
