// ping-freshness (FIX-05/06, 2026-09-18): единая политика качества и возраста
// наблюдений нативного пинга — общая для всех потребителей.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const pf = require('../src/services/ping-freshness.js');

const NOW = Date.parse('2026-09-18T12:00:00.000Z');
const TTL = pf.DEFAULT_TTL_MIN * 60000;

describe('ping-freshness', () => {
  it('ttl из настройки ping_fresh_ttl_min, дефолт 10 мин, мусор → дефолт', () => {
    expect(pf.ttlMs(() => 5)).toBe(5 * 60000);
    expect(pf.ttlMs(() => undefined)).toBe(TTL);
    expect(pf.ttlMs(() => 'abc')).toBe(TTL);
    expect(pf.ttlMs(null)).toBe(TTL);
  });

  it('valid в пределах TTL → valid; старше TTL → stale', () => {
    const row = { quality: 'valid', observed_at: new Date(NOW - 5 * 60000).toISOString() };
    expect(pf.qualityAt(row, NOW, TTL)).toBe('valid');
    expect(pf.qualityAt({ quality: 'valid', observed_at: new Date(NOW - 11 * 60000).toISOString() }, NOW, TTL)).toBe('stale');
  });

  it('missing/invalid хранимого качества возвращаются как есть; пустая строка — missing', () => {
    expect(pf.qualityAt({ quality: 'missing', observed_at: new Date(NOW).toISOString() }, NOW, TTL)).toBe('missing');
    expect(pf.qualityAt({ quality: 'invalid', observed_at: new Date(NOW).toISOString() }, NOW, TTL)).toBe('invalid');
    expect(pf.qualityAt(null, NOW, TTL)).toBe('missing');
  });

  it('timestamp из будущего (сверх допуска рассинхрона) недостоверен', () => {
    const row = { quality: 'valid', observed_at: new Date(NOW + 3600000).toISOString() };
    expect(pf.qualityAt(row, NOW, TTL)).toBe('invalid');
    // мелкий skew ≤ 60с допустим
    expect(pf.qualityAt({ quality: 'valid', observed_at: new Date(NOW + 30000).toISOString() }, NOW, TTL)).toBe('valid');
  });

  it('measured_at важнее observed_at: старый замер не омолаживается новым опросом', () => {
    const row = {
      quality: 'valid',
      measured_at: new Date(NOW - 3600000).toISOString(),   // замер час назад
      observed_at: new Date(NOW).toISOString(),             // получен только что
    };
    expect(pf.qualityAt(row, NOW, TTL)).toBe('stale');
  });

  it('неразбираемое время → invalid', () => {
    expect(pf.qualityAt({ quality: 'valid', observed_at: 'not-a-date' }, NOW, TTL)).toBe('invalid');
  });
});
