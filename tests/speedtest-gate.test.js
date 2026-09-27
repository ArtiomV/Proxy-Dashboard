// 2026-09-27 · speedtest-gate: глобальный лимит параллельных спидтестов
// НА ОДИН БОКС. Лимит слотов, FIFO-ожидание, таймаут ожидания (null /
// GATE_BUSY), освобождение слота при ошибке fn, независимость боксов.

import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const gate = require('../src/jobs/speedtest-gate.js');

afterEach(() => gate._reset());

describe('speedtest-gate: acquire/release', () => {
  it('лимит: слоты сверх limit не выдаются мгновенно (waitMs=0 → null)', async () => {
    const r1 = await gate.acquire('S1', { limit: 2, waitMs: 0 });
    const r2 = await gate.acquire('S1', { limit: 2, waitMs: 0 });
    expect(typeof r1).toBe('function');
    expect(typeof r2).toBe('function');
    expect(await gate.acquire('S1', { limit: 2, waitMs: 0 })).toBeNull();
    r1();
    r2();
  });

  it('боксы независимы: занятость S1 не мешает S2', async () => {
    const r1 = await gate.acquire('S1', { limit: 1, waitMs: 0 });
    expect(await gate.acquire('S1', { limit: 1, waitMs: 0 })).toBeNull();
    expect(typeof await gate.acquire('S2', { limit: 1, waitMs: 0 })).toBe('function');
    r1();
  });

  it('освобождённый слот достаётся ждущему (FIFO), release идемпотентен', async () => {
    const r1 = await gate.acquire('S1', { limit: 1 });
    const order = [];
    const w1 = gate.acquire('S1', { limit: 1, waitMs: 1000 }).then(r => { order.push('w1'); return r; });
    const w2 = gate.acquire('S1', { limit: 1, waitMs: 1000 }).then(r => { order.push('w2'); return r; });
    r1();
    r1();   // повторный release — no-op, слот не дублируется
    const rw1 = await w1;
    expect(typeof rw1).toBe('function');
    // Слот один: w2 всё ещё ждёт, пока w1 не отпустит.
    expect(await gate.acquire('S1', { limit: 1, waitMs: 0 })).toBeNull();
    rw1();
    const rw2 = await w2;
    expect(typeof rw2).toBe('function');
    expect(order).toEqual(['w1', 'w2']);
    rw2();
  });

  it('таймаут ожидания: слот не освободился за waitMs → null', async () => {
    const r1 = await gate.acquire('S1', { limit: 1 });
    const t0 = Date.now();
    const late = await gate.acquire('S1', { limit: 1, waitMs: 40 });
    expect(late).toBeNull();
    expect(Date.now() - t0).toBeGreaterThanOrEqual(30);
    r1();
    // После таймаута ждущий убран из очереди: следующий acquire получает слот сразу.
    expect(typeof await gate.acquire('S1', { limit: 1, waitMs: 0 })).toBe('function');
  });
});

describe('speedtest-gate: runWithGate', () => {
  it('успех: результат fn пробрасывается, слот освобождается', async () => {
    const out = await gate.runWithGate('S1', async () => 42, { limit: 1, waitMs: 0 });
    expect(out).toBe(42);
    expect(typeof await gate.acquire('S1', { limit: 1, waitMs: 0 })).toBe('function');
  });

  it('ошибка fn: исключение уходит наружу, слот НЕ залипает', async () => {
    await expect(gate.runWithGate('S1', async () => { throw new Error('boom'); }, { limit: 1, waitMs: 0 }))
      .rejects.toThrow('boom');
    // Гейт свободен — следующий замер проходит мгновенно.
    const out = await gate.runWithGate('S1', async () => 'ok', { limit: 1, waitMs: 0 });
    expect(out).toBe('ok');
  });

  it('гейт занят дольше waitMs → GateBusyError с code GATE_BUSY', async () => {
    const release = await gate.acquire('S1', { limit: 1 });
    await expect(gate.runWithGate('S1', async () => 'x', { limit: 1, waitMs: 20 }))
      .rejects.toMatchObject({ code: 'GATE_BUSY' });
    release();
  });

  it('реальный параллелизм не превышает limit', async () => {
    let active = 0, maxActive = 0;
    const task = () => gate.runWithGate('S1', async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise(r => setTimeout(r, 15));
      active--;
    }, { limit: 2, waitMs: 1000 });
    await Promise.all([task(), task(), task(), task(), task()]);
    expect(maxActive).toBe(2);
  });
});

describe('speedtest-gate: optsFromSettings', () => {
  it('дефолты без getSetting; настройки читаются и клампятся', () => {
    expect(gate.optsFromSettings(null)).toEqual({ limit: 2, waitMs: 60000 });
    expect(gate.optsFromSettings(() => undefined)).toEqual({ limit: 2, waitMs: 60000 });
    expect(gate.optsFromSettings(k => (k === 'speedtest_gate_max_per_server' ? '3' : '5')))
      .toEqual({ limit: 3, waitMs: 5000 });
    // Битые/выходящие за рамки значения → дефолт.
    expect(gate.optsFromSettings(k => (k === 'speedtest_gate_max_per_server' ? '99' : '-1')))
      .toEqual({ limit: 2, waitMs: 60000 });
  });
});
