// B5 (C7): промах pricing_tiers — раньше молчаливый fallback в tiers[0].price
// или хардкод 23. Теперь: warn в system_log (action=pricing_tier_miss) +
// TG-правило pricing_tier_miss с cooldown. Fallback сохранён (AutoCreate не
// должен падать), но он больше не молчит.

import { describe, it, expect, beforeAll } from 'vitest';
import { bootApp } from './_helpers/app.js';

let db, getPriceForProxyCount;

beforeAll(() => {
  const ctx = bootApp();
  db = ctx.db;
  getPriceForProxyCount = ctx.getPriceForProxyCount;
});

const missRows = () =>
  db.prepare("SELECT * FROM system_log WHERE action = 'pricing_tier_miss'").all();

describe('getPriceForProxyCount — промах pricing_tiers (B5)', () => {
  it('попадание в тир — тихо, без warn', () => {
    const before = missRows().length;
    const price = getPriceForProxyCount(10);   // дефолтная сетка: тир 10-19 → 23
    expect(price).toBe(23);
    expect(missRows().length).toBe(before);
  });

  it('промах (count=0) → fallback + запись в system_log', () => {
    const before = missRows().length;
    const price = getPriceForProxyCount(0);    // ни один тир (min_proxies ≥ 1) не подходит
    expect(price).toBe(30);                    // fallback = tiers[0].price
    const rows = missRows();
    expect(rows.length).toBe(before + 1);
    const last = rows[rows.length - 1];
    expect(last.level).toBe('warn');
    const details = JSON.parse(last.details);
    expect(details.count).toBe(0);
    expect(details.fallback).toBe(30);
  });
});
