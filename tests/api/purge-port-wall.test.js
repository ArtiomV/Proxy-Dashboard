// 2026-07-23: «Delete port failed» — purge_port ходил в /conf/delete_port через
// fetchApi, которая отклоняла 302-страницу логина S2 как «HTML вместо JSON».
// Теперь — proxyConf.getConfAction с обходом стены. Тест: успех и AUTH_WALLED.

import { describe, it, expect } from 'vitest';
import request from 'supertest';
import express from 'express';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const createRouter = require('../../src/routes/proxies-ports.js');

const SRV = { name: 'S2', url: 'http://stub', user: 'u', pass: 'p' };

function mount(confBehavior) {
  const silent = { info() {}, warn() {}, error() {}, debug() {} };
  const passAuth = (req, res, next) => { req.user = { login: 'test_admin', isAdmin: 1 }; next(); };
  const router = createRouter({
    logger: silent,
    authMiddleware: passAuth, adminMiddleware: passAuth,
    fetchApi: async () => ({}),
    fetchApiRaw: async () => ({ buffer: Buffer.from('') }),
    postApi: async () => ({}),
    postFormApi: async () => ({ status: 302 }),
    findServer: () => SRV,
    parseHtmlInputFields: () => ({}),
    auditLog: () => {},
    logActivity: () => {},
    getClientIp: () => '127.0.0.1',
    proxySmart: { invalidateCache() {} },
    proxyConf: confBehavior,
    modemRotationCache: {},
    saveRotationCache: () => {},
  });
  const app = express();
  app.use(express.json());
  app.use(router);
  return app;
}

describe('POST /api/admin/purge_port — через proxyConf (логин-стена S2)', () => {
  it('успех: getConfAction ok → 200 ok:true', async () => {
    const app = mount({ getConfAction: async () => ({ ok: true, status: 302, location: '/conf' }) });
    const res = await request(app).post('/api/admin/purge_port').send({ serverName: 'S2', portId: 'portABC123' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('AUTH_WALLED → 502 с причиной, НЕ молчаливый ok', async () => {
    const app = mount({ getConfAction: async () => ({ ok: false, reason: 'AUTH_WALLED', status: 302 }) });
    const res = await request(app).post('/api/admin/purge_port').send({ serverName: 'S2', portId: 'portABC123' });
    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/AUTH_WALLED/);
    expect(res.body.ok).toBeUndefined();
  });
});
