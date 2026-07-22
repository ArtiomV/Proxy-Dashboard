// 2026-07-22: store_modem verify-after-write — «сохранено» только когда
// ProxySmart реально применил значение. AUTH_WALLED и mismatch → 502,
// кэш ротации не трогаем (раньше он обновлялся непроверенным значением
// и UI показывал «Выкл» при включённой ротации).

import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const createProxiesRouter = require('../../src/routes/proxies.js');

const SRV = { name: 'S2', url: 'http://stub', user: 'u', pass: 'p' };
let app, modemRotationCache, proxyConf;

function mount(confBehavior) {
  modemRotationCache = {};
  proxyConf = confBehavior;
  const silent = { info() {}, warn() {}, error() {}, debug() {} };
  const passAuth = (req, res, next) => { req.user = { login: 'test_admin', isAdmin: 1 }; next(); };
  const router = createProxiesRouter({
    logger: silent,
    authMiddleware: passAuth, adminMiddleware: passAuth,
    fetchApi: async () => ({}),
    fetchApiRaw: async () => ({ buffer: Buffer.from('') }),
    postFormApi: async () => ({ status: 302 }),
    findServer: () => SRV,
    parseHtmlInputFields: () => ({}),
    auditLog: () => {},
    getClientIp: () => '127.0.0.1',
    proxySmart: { invalidateCache() {} },
    proxyConf,
    modemRotationCache,
    fetchAllServersDataCached: async () => [],
    syncRotationLog: async () => {},
    _rlSelect: { all: () => [] },
    pushSpeedtestEntry: () => {},
    ipHistory: {},
  });
  app = express();
  app.use(express.json());
  app.use(router);
}

describe('POST /api/admin/store_modem — verify-after-write', () => {
  beforeEach(() => { /* per-test mount */ });

  it('AUTH_WALLED → 502, кэш не меняется, ok не возвращаем', async () => {
    mount({ getConfForm: async () => ({ ok: false, reason: 'AUTH_WALLED', status: 302 }), postConfForm: async () => ({ ok: false, reason: 'AUTH_WALLED' }), parseRotation: () => null });
    const res = await request(app).post('/api/admin/store_modem').send({ serverName: 'S2', IMEI: '531737907724202', AUTO_IP_ROTATION: '0' });
    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/AUTH_WALLED|не отдал форму/);
    expect(modemRotationCache['S2:531737907724202']).toBeUndefined();
  });

  it('verify mismatch (хотели 0, в форме 10) → 502, кэш не меняется', async () => {
    let formRot = '10';
    mount({
      getConfForm: async () => ({ ok: true, fields: { AUTO_IP_ROTATION: formRot, name: 'RO2_49' }, html: `AUTO_IP_ROTATION" value="${formRot}">`, status: 200 }),
      postConfForm: async () => ({ ok: true, status: 302, location: '/conf' }),   // «успех», но значение не применилось
      parseRotation: (html) => { const m = html.match(/value="(\d*)"/); return m && m[1] !== '' ? parseInt(m[1]) : null; },
    });
    const res = await request(app).post('/api/admin/store_modem').send({ serverName: 'S2', IMEI: '531737907724202', AUTO_IP_ROTATION: '0' });
    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/не применил AUTO_IP_ROTATION/);
    expect(modemRotationCache['S2:531737907724202']).toBeUndefined();
  });

  it('подтверждённый 0 → ok:true и кэш обновлён проверенным значением', async () => {
    let formRot = '10';
    mount({
      getConfForm: async () => ({ ok: true, fields: { AUTO_IP_ROTATION: formRot, name: 'RO2_49' }, html: `AUTO_IP_ROTATION" value="${formRot}">`, status: 200 }),
      postConfForm: async (server, path, fields) => { formRot = fields.AUTO_IP_ROTATION; return { ok: true, status: 302, location: '/conf' }; },
      parseRotation: (html) => { const m = html.match(/value="(\d*)"/); return m && m[1] !== '' ? parseInt(m[1]) : null; },
    });
    const res = await request(app).post('/api/admin/store_modem').send({ serverName: 'S2', IMEI: '531737907724202', AUTO_IP_ROTATION: '0' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.verified).toBe(true);
    expect(modemRotationCache['S2:531737907724202']).toBe(0);
  });

  it('сохранение без поля ротации НЕ затирает кэш нулём', async () => {
    modemRotationCache = null;
    mount({
      getConfForm: async () => ({ ok: true, fields: { AUTO_IP_ROTATION: '10', name: 'RO2_49' }, html: 'AUTO_IP_ROTATION" value="10">', status: 200 }),
      postConfForm: async () => ({ ok: true, status: 302, location: '/conf' }),
      parseRotation: () => 10,
    });
    modemRotationCache['S2:531737907724202'] = 10;
    const res = await request(app).post('/api/admin/store_modem').send({ serverName: 'S2', IMEI: '531737907724202', name: 'RO2_49_new' });
    expect(res.status).toBe(200);
    expect(modemRotationCache['S2:531737907724202']).toBe(10);   // не тронут
  });
});
