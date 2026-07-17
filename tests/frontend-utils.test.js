// tests/frontend-utils.test.js — Stage 7 regression test.
//
// Locks the unit semantics of public/js/utils.js to DECIMAL (SI):
//   1 KB = 1e3, 1 MB = 1e6, 1 GB = 1e9, 1 TB = 1e12.
//
// Why this matters: backend src/utils/traffic.js uses decimal for billing
// math (trafficBytesToGb(1e9) === 1). The admin SPA also uses decimal.
// Before Stage 7 the client portal's utils.js used BINARY units (1024,
// 1048576, 1073741824) — so the same byte count rendered as different
// numbers on /admin vs /client. This test trips if anyone reintroduces
// the divergence by switching a multiplier back to binary.

import { test, expect, describe } from 'vitest';
import { createRequire } from 'module';

// utils.js exports via CommonJS when `module` is defined (server side).
// Browsers ignore the export — bare function declarations stay global.
const require = createRequire(import.meta.url);
const utils = require('../public/js/utils.js');
const { trafficBytesToGb } = require('../src/utils/traffic');

describe('utils.js — decimal SI units (Stage 7 lock)', () => {
  test('parseTraffic uses decimal multipliers', () => {
    expect(utils.parseTraffic('1 KB')).toBe(1e3);
    expect(utils.parseTraffic('1 MB')).toBe(1e6);
    expect(utils.parseTraffic('1 GB')).toBe(1e9);
    expect(utils.parseTraffic('1 TB')).toBe(1e12);
    expect(utils.parseTraffic('1.5 GB')).toBe(1.5e9);
    // Case-insensitive
    expect(utils.parseTraffic('2 gb')).toBe(2e9);
    // Pass-through numeric and zero
    expect(utils.parseTraffic(12345)).toBe(12345);
    expect(utils.parseTraffic(0)).toBe(0);
    expect(utils.parseTraffic('')).toBe(0);
  });

  test('bytesToGb uses 1e9 (decimal), not 1<<30 (binary)', () => {
    expect(utils.bytesToGb(1e9)).toBe(1);
    expect(utils.bytesToGb(2.5e9)).toBe(2.5);
    // Binary GiB would be ~0.9313 — would-be regression value if the
    // dupe in admin.js / client.js sneaks back.
    expect(utils.bytesToGb(1e9)).not.toBeCloseTo(0.9313, 3);
  });

  // All formatters render RU units — the UI language is Russian. This lock
  // trips if anyone reintroduces EN units (that regression shipped in v2.1.0
  // and left this test red until the test was aligned with the RU UI).
  test('fmtGb crosses thresholds at 1e6 and 1e9 (RU units)', () => {
    expect(utils.fmtGb(0)).toBe('0 Б');
    // КБ band: <1e6
    expect(utils.fmtGb(500000)).toBe('500.0 КБ');
    // МБ band: <1e9
    expect(utils.fmtGb(500e6)).toBe('500.0 МБ');
    // ГБ band
    expect(utils.fmtGb(1e9)).toBe('1.0 ГБ');
    expect(utils.fmtGb(2.5e9)).toBe('2.5 ГБ');
    // Rounded for >=100 ГБ
    expect(utils.fmtGb(150e9)).toBe('150 ГБ');
    // ТБ band: >=1000 ГБ
    expect(utils.fmtGb(1.5e12)).toBe('1.5 ТБ');
  });

  test('fmtGbShort flips МБ→ГБ at 1e9 (RU units)', () => {
    expect(utils.fmtGbShort(500e6)).toBe('500 МБ');
    expect(utils.fmtGbShort(1e9)).toBe('1.0 ГБ');
  });

  test('formatBytes auto-unit uses decimal thresholds (RU units)', () => {
    expect(utils.formatBytes(0)).toBe('0 Б');
    expect(utils.formatBytes(500)).toBe('500 Б');
    expect(utils.formatBytes(500e3)).toBe('500.0 КБ');
    expect(utils.formatBytes(500e6)).toBe('500.0 МБ');
    expect(utils.formatBytes(2e9)).toBe('2.0 ГБ');
  });

  test('roundtrip — parseTraffic ↔ bytesToGb agree', () => {
    // 5 GB string parses to 5e9, which is exactly 5 GB by decimal math.
    expect(utils.bytesToGb(utils.parseTraffic('5 GB'))).toBe(5);
  });

  test('matches backend (src/utils/traffic.js trafficBytesToGb invariant)', () => {
    // Backend: trafficBytesToGb(1e9) === 1. Frontend must agree.
    expect(utils.bytesToGb(1e9)).toBe(trafficBytesToGb(1e9));
    expect(utils.bytesToGb(7.5e9)).toBe(trafficBytesToGb(7.5e9));
  });

  test('esc escapes HTML control characters', () => {
    expect(utils.esc('<script>')).toBe('&lt;script&gt;');
    expect(utils.esc('"quoted"')).toBe('&quot;quoted&quot;');
    expect(utils.esc('a & b')).toBe('a &amp; b');
    expect(utils.esc('')).toBe('');
    expect(utils.esc(null)).toBe('');
  });
});
