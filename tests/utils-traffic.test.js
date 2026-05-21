// Starter tests for src/utils/traffic.js — the bytes-parse helpers.
// Run with `npm test`. Add more files as we extract more pure modules.
const { describe, it, expect } = require('vitest');
const { parseTrafficValue, trafficBytesToGb, normalizeOperator } = require('../src/utils/traffic.js');

describe('parseTrafficValue', () => {
  it('returns 0 for null/empty/"0 B"', () => {
    expect(parseTrafficValue(null)).toBe(0);
    expect(parseTrafficValue('')).toBe(0);
    expect(parseTrafficValue('0 B')).toBe(0);
  });
  it('passes through numbers', () => {
    expect(parseTrafficValue(123)).toBe(123);
  });
  it('parses decimal SI units', () => {
    expect(parseTrafficValue('1 KB')).toBe(1000);
    expect(parseTrafficValue('1 MB')).toBe(1e6);
    expect(parseTrafficValue('1 GB')).toBe(1e9);
    expect(parseTrafficValue('1 TB')).toBe(1e12);
  });
  it('parses bare byte counts as numbers', () => {
    expect(parseTrafficValue('1234567890')).toBe(1234567890);
  });
  it('returns 0 for malformed strings', () => {
    expect(parseTrafficValue('abc')).toBe(0);
  });
});

describe('trafficBytesToGb', () => {
  it('uses decimal GB (1e9)', () => {
    expect(trafficBytesToGb(1e9)).toBe(1);
    expect(trafficBytesToGb(2.5e9)).toBe(2.5);
  });
  it('rounds to 3 decimals', () => {
    expect(trafficBytesToGb(1234567)).toBe(0.001);
  });
});

describe('normalizeOperator', () => {
  it('maps unite → Moldtelecom', () => {
    expect(normalizeOperator('unite', false)).toBe('Moldtelecom');
  });
  it('uses Orange RO on RO server', () => {
    expect(normalizeOperator('orange', true)).toBe('Orange RO');
    expect(normalizeOperator('orange', false)).toBe('Orange MD');
  });
  it('passes unknown operators through with leading capital', () => {
    expect(normalizeOperator('telekom', false)).toBe('Telekom');
  });
  it('handles empty input', () => {
    expect(normalizeOperator('', false)).toBe('');
  });
});
