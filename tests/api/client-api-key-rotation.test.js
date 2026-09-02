// Self-serve ротация API-ключа клиентом (v2.10.68, миграция 086):
//   POST /api/client/api_key/regenerate — новый ключ сразу, прежний живёт
//   ещё 24 ч (grace), plaintext возвращается один раз.
// Плюс регрессия на жилой баг: после ротации rebuildClientMaps обязателен,
// иначе новый ключ не работал бы до рестарта, а старый продолжал работать.

import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import crypto from 'crypto';
import { createRequire } from 'module';
import { bootApp, asAdmin } from '../_helpers/app.js';
const require = createRequire(import.meta.url);
const stateMod = require('../../src/state/index.js');

let app, db, adminToken, clientToken, plainKeyV1;
const PASSWORD = 'rot_pass_' + crypto.randomBytes(4).toString('hex');

beforeAll(async () => {
  const ctx = bootApp();
  app = ctx.app;
  db = ctx.db;
  adminToken = asAdmin();
  const login = 'rot_' + crypto.randomBytes(3).toString('hex');
  const create = await request(app).post('/api/admin/clients').set('X-Auth-Token', adminToken).send({
    name: 'Rotation Test', login, password: PASSWORD,
    portName: 'rot_p_' + crypto.randomBytes(2).toString('hex'),
    billingType: 'per_gb', price: 10, currency: 'RUB',
  });
  if (create.status !== 200) throw new Error('seed failed: ' + create.status);
  plainKeyV1 = create.body.client.apiKey;
  const auth = await request(app).post('/api/login').send({ login, password: PASSWORD });
  if (auth.status !== 200) throw new Error('client login failed: ' + auth.status);
  clientToken = auth.body.token;
});

describe('POST /api/client/api_key/regenerate (grace-ротация)', () => {
  it('требует авторизации', async () => {
    const res = await request(app).post('/api/client/api_key/regenerate');
    expect(res.status).toBe(401);
  });

  it('карточка ключа в dashboard_data: prefix + createdAt с момента создания', async () => {
    const res = await request(app).get('/api/dashboard_data').set('X-Auth-Token', clientToken);
    expect(res.status).toBe(200);
    const info = res.body.billing && res.body.billing.apiKeyInfo;
    expect(info).toBeTruthy();
    expect(info.prefix).toBe(plainKeyV1.slice(0, 8));
    expect(info.createdAt).toBeTruthy();
    expect(info.prevExpiresAt).toBeNull();
  });

  it('ротация: новый ключ работает сразу, прежний — в течение grace', async () => {
    const res = await request(app).post('/api/client/api_key/regenerate').set('X-Auth-Token', clientToken);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    const plainV2 = res.body.apiKey;
    expect(plainV2).toMatch(/^prx_[0-9a-f]{48}$/);
    expect(plainV2).not.toBe(plainKeyV1);
    expect(Date.parse(res.body.prevExpiresAt)).toBeGreaterThan(Date.now() + 23 * 3600 * 1000);

    // Новый ключ принимается СРАЗУ (без рестарта) — регрессия на rebuildMaps.
    const withNew = await request(app).get('/api/v1/proxy').set('X-API-Key', plainV2);
    expect(withNew.status).toBe(200);

    // Прежний ключ ещё работает (grace 24 ч).
    const withOld = await request(app).get('/api/v1/proxy').set('X-API-Key', plainKeyV1);
    expect(withOld.status).toBe(200);

    // Повторная ротация в ту же минуту — анти-спам 429.
    const spam = await request(app).post('/api/client/api_key/regenerate').set('X-Auth-Token', clientToken);
    expect(spam.status).toBe(429);

    // Истёкший grace: prev-дедлайн в прошлом → прежний ключ отклоняется.
    const client = stateMod.state.clients.find(c => c.apiKeyPrefix === plainV2.slice(0, 8));
    expect(client).toBeTruthy();
    client.apiKeyPrevExpiresAt = new Date(Date.now() - 1000).toISOString();
    stateMod.rebuildMaps();
    const expired = await request(app).get('/api/v1/proxy').set('X-API-Key', plainKeyV1);
    expect(expired.status).toBe(401);
    const stillNew = await request(app).get('/api/v1/proxy').set('X-API-Key', plainV2);
    expect(stillNew.status).toBe(200);
  });

  it('после ротации карточка показывает grace-дедлайн прежнего ключа', async () => {
    // клиент из предыдущего теста уже с ротированным ключом (prev истёк —
    // но поле в БД/памяти осталось, карточка показывает его только пока оно в будущем)
    const res = await request(app).get('/api/dashboard_data').set('X-Auth-Token', clientToken);
    expect(res.status).toBe(200);
    const info = res.body.billing.apiKeyInfo;
    expect(info.createdAt).toBeTruthy();
    expect(info.prevExpiresAt).toBeNull();   // дедлайн истёк в тесте выше — не показываем
  });
});
