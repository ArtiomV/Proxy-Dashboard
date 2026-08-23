'use strict';
//
// SSE (23.08): шина src/events.js — publish/subscribe, троттлинг с
// коалесцированием, лимит клиентов на сессию, graceful closeAll.

import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const events = require('../src/events');

function fakeRes() {
  return {
    writes: [],
    closed: false,
    _closeCbs: [],
    write(s) { if (this.closed) throw new Error('write after end'); this.writes.push(s); return true; },
    end() { this.closed = true; this._closeCbs.forEach(cb => cb()); },
    on(ev, cb) { if (ev === 'close') this._closeCbs.push(cb); },
  };
}

let bus;
function makeBus() { bus = events.create({ heartbeatMs: 60000, throttleMs: 100, maxPerSession: 2 }); return bus; }
afterEach(() => { try { if (bus) bus.closeAll(); } catch (_) { /* best-effort */ } bus = null; });

describe('events bus (SSE)', () => {
  it('publish без подписчиков — безопасный no-op', () => {
    makeBus();
    expect(() => bus.publish('alert', { ruleId: 'x' })).not.toThrow();
    expect(bus.clientCount()).toBe(0);
  });

  it('subscribe → клиент получает event:/data: фрейм', () => {
    makeBus();
    const res = fakeRes();
    expect(bus.subscribe(res, 'sess1')).toBe(true);
    bus.publish('fleet_update', { total: 5 });
    expect(res.writes.length).toBe(1);
    expect(res.writes[0].startsWith('event: fleet_update\ndata: ')).toBe(true);
    expect(res.writes[0]).toContain('"total":5');
    expect(res.writes[0].endsWith('\n\n')).toBe(true);
  });

  it('троттлинг: повтор в окне коалесцируется, last-wins', async () => {
    makeBus();
    const res = fakeRes();
    bus.subscribe(res, 'sess1');
    bus.publish('modem_rate', { v: 1 });
    bus.publish('modem_rate', { v: 2 });
    bus.publish('modem_rate', { v: 3 });
    expect(res.writes.length).toBe(1);            // первое ушло сразу
    await new Promise(r => setTimeout(r, 300));   // окно 100мс + flush
    expect(res.writes.length).toBe(2);
    expect(res.writes[1]).toContain('"v":3');     // выиграло последнее
  });

  it('разные типы не троттлят друг друга', () => {
    makeBus();
    const res = fakeRes();
    bus.subscribe(res, 'sess1');
    bus.publish('alert', { a: 1 });
    bus.publish('metrics_update', { m: 1 });
    expect(res.writes.length).toBe(2);
  });

  it('лимит клиентов на сессию: сверх maxPerSession → false', () => {
    makeBus();
    expect(bus.subscribe(fakeRes(), 's')).toBe(true);
    expect(bus.subscribe(fakeRes(), 's')).toBe(true);
    expect(bus.subscribe(fakeRes(), 's')).toBe(false);           // лимит 2
    expect(bus.subscribe(fakeRes(), 'other')).toBe(true);        // другая сессия — ок
  });

  it('отписка по close сокета освобождает лимит', () => {
    makeBus();
    const r1 = fakeRes(); const r2 = fakeRes();
    bus.subscribe(r1, 's'); bus.subscribe(r2, 's');
    expect(bus.subscribe(fakeRes(), 's')).toBe(false);
    r1.end();   // триггерит 'close' → drop
    expect(bus.subscribe(fakeRes(), 's')).toBe(true);
  });

  it('write-ошибка → клиент выбрасывается, остальные получают событие', () => {
    makeBus();
    const bad = fakeRes(); bad.end();            // следующий write кинет
    const good = fakeRes();
    bus.subscribe(bad, 's1'); bus.subscribe(good, 's2');
    bus.publish('alert', { x: 1 });
    expect(bus.clientCount()).toBe(1);
    expect(good.writes.length).toBe(1);
  });

  it('closeAll шлёт bye и закрывает потоки', () => {
    makeBus();
    const res = fakeRes();
    bus.subscribe(res, 's');
    bus.closeAll();
    expect(res.writes.some(w => w.startsWith('event: bye'))).toBe(true);
    expect(res.closed).toBe(true);
    expect(bus.clientCount()).toBe(0);
  });

  it('несериализуемый payload не роняет publish', () => {
    makeBus();
    const res = fakeRes();
    bus.subscribe(res, 's');
    const cyclic = {}; cyclic.self = cyclic;
    expect(() => bus.publish('alert', cyclic)).not.toThrow();
    expect(res.writes[0]).toContain('data: {}');
  });
});
