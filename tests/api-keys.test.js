// 2026-09-24 · DEEP-42: resolveGraceHours — 0 легален (немедленный отзыв),
// мусор → дефолт, потолок 30 суток.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { resolveGraceHours, DEFAULT_GRACE_HOURS } = require('../src/services/api-keys.js');

describe('resolveGraceHours (DEEP-42)', () => {
  it('0 сохраняется как немедленный отзыв (не превращается в 24)', () => {
    expect(resolveGraceHours(0)).toBe(0);
    expect(resolveGraceHours('0')).toBe(0);
  });
  it('штатные значения проходят, мусор → дефолт', () => {
    expect(resolveGraceHours(1)).toBe(1);
    expect(resolveGraceHours(24)).toBe(24);
    expect(resolveGraceHours('abc')).toBe(DEFAULT_GRACE_HOURS);
    expect(resolveGraceHours(-5)).toBe(DEFAULT_GRACE_HOURS);
    expect(resolveGraceHours(undefined)).toBe(DEFAULT_GRACE_HOURS);
  });
  it('потолок 30 суток', () => {
    expect(resolveGraceHours(24 * 365)).toBe(24 * 30);
  });
});
