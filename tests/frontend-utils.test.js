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

  test('fmtGb crosses thresholds at 1e6 and 1e9', () => {
    expect(utils.fmtGb(0)).toBe('0 B');
    // KB band: <1e6
    expect(utils.fmtGb(500000)).toBe('500.0 KB');
    // MB band: <1e9
    expect(utils.fmtGb(500e6)).toBe('500.0 MB');
    // GB band
    expect(utils.fmtGb(1e9)).toBe('1.0 GB');
    expect(utils.fmtGb(2.5e9)).toBe('2.5 GB');
    // Rounded for >=100 GB
    expect(utils.fmtGb(150e9)).toBe('150 GB');
    // TB band: >=1000 GB
    expect(utils.fmtGb(1.5e12)).toBe('1.5 TB');
  });

  test('fmtGbShort flips MB→GB at 1e9', () => {
    expect(utils.fmtGbShort(500e6)).toBe('500 MB');
    expect(utils.fmtGbShort(1e9)).toBe('1.0 GB');
  });

  test('formatBytes auto-unit uses decimal thresholds', () => {
    expect(utils.formatBytes(0)).toBe('0 B');
    expect(utils.formatBytes(500)).toBe('500 B');
    expect(utils.formatBytes(500e3)).toBe('500.0 KB');
    expect(utils.formatBytes(500e6)).toBe('500.0 MB');
    expect(utils.formatBytes(2e9)).toBe('2.0 GB');
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
