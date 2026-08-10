// D11 (2026-08): симулятор — флаг выключения + лимиты ресурсов.
//   1) POST /api/admin/simulator/run при simulator_enabled=false → 403
//      (дефолт безопасный для прода: «не запускать без необходимости»).
//   2) engine: кламп duration_ms (simulator_max_duration_min), потолок
//      воркеров (simulator_max_workers), лимит SSE (simulator_max_sse).

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'module';
import request from 'supertest';
import { bootApp, asAdmin } from './_helpers/app.js';

const require = createRequire(import.meta.url);

describe('D11: POST /api/admin/simulator/run → 403 при выключенном флаге', () => {
  beforeAll(() => { bootApp(); });

  it('simulator_enabled=false (дефолт) → 403 с понятной ошибкой', async () => {
    const { app } = bootApp();
    const token = asAdmin();
    const res = await request(app)
      .post('/api/admin/simulator/run')
      .set('X-Auth-Token', token)
      .send({ profile: { name: 't', target_modems: [{ server: 'S', nick: 'N' }], targets: [{ url: 'https://x.test/' }], concurrency: { mode: 'constant', workers: 1 }, duration_ms: 1000, timeout_ms: 500 } });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/simulator_enabled/);
  });
});

describe('D11: engine — лимиты ресурсов', () => {
  const engine = require('../src/simulator/engine.js');
  let insertedConfig;

  const settings = {
    simulator_max_duration_min: 30,
    simulator_max_workers: 2,   // просим 500 → кламп к 2 (не 50 — чтобы горячий цикл фейлов не съел heap теста)
    simulator_max_sse: 3,
  };
  const mockDb = {
    prepare: (sql) => {
      if (/INSERT INTO simulator_runs/.test(sql)) {
        return { get: (profileId, name, configJson) => { insertedConfig = JSON.parse(configJson); return { id: 7 }; } };
      }
      if (/UPDATE simulator_runs/.test(sql)) return { run: () => ({}) };
      if (/INSERT INTO simulator_samples/.test(sql)) return { run: () => ({}) };
      if (/is_test_pool/.test(sql)) return { get: () => ({ '1': 1 }) };   // модем в тест-пуле
      return { get: () => undefined, run: () => ({}), all: () => [] };
    },
    transaction: (fn) => fn,
  };

  beforeAll(() => {
    engine.init({
      db: mockDb,
      logger: { info() {}, warn() {}, error() {} },
      getSetting: (k, d) => (k in settings ? settings[k] : d),
    });
  });
  afterAll(() => { try { engine.stop('test-done'); } catch (_) { /* не запущен */ } });

  const profile = {
    name: 'limits-test',
    target_modems: [{ server: 'S', nick: 'N' }],
    targets: [{ url: 'http://10.255.255.1/x' }],   // unroutable → каждый запрос висит до timeout (не горячий цикл)
    concurrency: { mode: 'constant', workers: 500 },   // просим 500 при лимите 2
    duration_ms: 60 * 60000,                           // просим 60 мин при лимите 30
    timeout_ms: 200,
  };
  const resolved = [{ server: 'S', nick: 'N', proxyUrl: 'http://u:p@10.255.255.1:1' }];

  it('duration_ms клампится к simulator_max_duration_min', () => {
    const runId = engine.start(profile, { resolvedModems: resolved, startedBy: 'test' });
    expect(runId).toBe(7);
    expect(insertedConfig.duration_ms).toBe(30 * 60000);
    // Объект вызывающего не мутирован.
    expect(profile.duration_ms).toBe(60 * 60000);
  });

  it('число воркеров не превышает simulator_max_workers', async () => {
    await new Promise(r => setTimeout(r, 700));   // первый tick (500 мс)
    const active = engine.getActive();
    expect(active.target_workers).toBe(2);
    expect(active.active_workers).toBeLessThanOrEqual(2);
    engine.abort(7);
    await new Promise(r => setTimeout(r, 100));
    expect(engine.getActive()).toBeNull();
  });

  it('SSE: лимит simulator_max_sse — лишний подписчик получает null, sseFull=true', () => {
    const unsubs = [];
    for (let i = 0; i < 3; i++) {
      const u = engine.subscribe(7, () => {});
      expect(u).toBeTypeOf('function');
      unsubs.push(u);
    }
    expect(engine.sseFull()).toBe(true);
    expect(engine.subscribe(7, () => {})).toBeNull();
    for (const u of unsubs) u();
    expect(engine.sseFull()).toBe(false);
  });
});
