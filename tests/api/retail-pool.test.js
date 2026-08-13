// B2C Этап 2 (API): пул розницы + B6.
//   • B6: POST /api/admin/assign_modem с пустым newPortName — отвязка (НЕ 400);
//   • GET /api/admin/retail/pool — rows: полный список;
//   • pool/add — создание free-портов на свободных модемах;
//   • legacy_preview / legacy_import — перенос legacy-портов физиков в пул;
//   • buy_proxy тест-тарифа → test_expires_at = выдача + 24ч (миграция 062).
// Роутеры монтируются standalone с моками ProxySmart — живого бокса нет.

import { describe, it, expect } from 'vitest';
import request from 'supertest';
import express from 'express';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const createRetailRouter = require('../../src/routes/retail.js');
const createProxiesRouter = require('../../src/routes/proxies.js');

const SRV = { name: 'S1', url: 'http://stub', user: 'u', pass: 'p' };
const silent = { info() {}, warn() {}, error() {}, debug() {} };
const passAuth = (req, res, next) => { req.user = { login: 'test_admin', isAdmin: 1 }; next(); };

// ── in-memory retail_pool (как в tests/retail-guard.test.js, + all/insert) ──
function mkPoolDb(rows = []) {
  let nextId = rows.reduce((m, r) => Math.max(m, r.id), 0) + 1;
  return {
    _rows: rows,
    all: () => rows,
    byStatus: (s) => rows.filter(r => r.status === s),
    byClient: (cid) => rows.filter(r => r.client_id === cid && ['reserved', 'leased', 'blocked'].includes(r.status)),
    byPort: (srv, pid) => rows.find(r => r.server === srv && r.port_id === pid),
    countByStatus: () => rows.reduce((acc, r) => { acc[r.status] = (acc[r.status] || 0) + 1; return acc; }, {}),
    nextFree: (srv) => rows.find(r => r.status === 'free' && r.server === srv),
    reserve: (id, cid, until) => {
      const r = rows.find(x => x.id === id && x.status === 'free');
      if (!r) return false;
      r.status = 'reserved'; r.client_id = cid; r.reserved_until = until;
      return true;
    },
    lease: (id) => { const r = rows.find(x => x.id === id); r.status = 'leased'; r.reserved_until = null; },
    release: (id) => { const r = rows.find(x => x.id === id); r.status = 'free'; r.client_id = null; r.hold_until = null; r.test_expires_at = null; },
    block: (id, h) => { const r = rows.find(x => x.id === id); r.status = 'blocked'; r.hold_until = h; },
    setTestExpires: (id, iso) => { rows.find(x => x.id === id).test_expires_at = iso; },
    insertFree: (srv, pid) => {
      if (rows.some(r => r.server === srv && r.port_id === pid)) return { changes: 0 };
      rows.push({ id: nextId++, server: srv, port_id: pid, status: 'free', client_id: null });
      return { changes: 1 };
    },
    insertLeased: (srv, pid, cid) => {
      if (rows.some(r => r.server === srv && r.port_id === pid)) return { changes: 0 };
      rows.push({ id: nextId++, server: srv, port_id: pid, status: 'leased', client_id: cid });
      return { changes: 1 };
    },
    remove: (id) => { const i = rows.findIndex(x => x.id === id); if (i >= 0) rows.splice(i, 1); },
  };
}

function mountRetail({ poolRows = [], clients = [], tariffs = {}, settings = {}, fetchApiImpl, fetchAllResults, posted, user } = {}) {
  const poolDb = mkPoolDb(poolRows);
  const cfg = { retail_enabled: true, retail_pool_servers: 'S1', retail_test_day_price: 100, ...settings };
  const auth = (req, res, next) => { req.user = user || { login: 'test_admin', isAdmin: 1 }; next(); };
  const router = createRetailRouter({
    logger: silent,
    authMiddleware: auth, adminMiddleware: auth,
    clients, saveClients: () => {},
    tariffsDb: { byId: (id) => tariffs[id] || null },
    retailPoolDb: poolDb,
    atomicDebit: () => {},
    getSetting: (k, d) => (k in cfg ? cfg[k] : d),
    findServer: () => SRV,
    fetchApi: fetchApiImpl || (async () => ({})),
    proxyConf: {
      getConfForm: async () => ({ ok: true, html: `<form><input name="portID" value="port_${Math.random().toString(36).slice(2, 8)}"><input name="proxy_password" value="pw"></form>` }),
      postConfForm: async (_srv, path, formData) => { posted && posted.push({ path, formData }); return { ok: true }; },
      getConfAction: async () => ({ ok: true }),
    },
    proxySmart: { invalidateCache() {} },
    parseHtmlInputFields: (html) => {
      const m = html.match(/name="portID" value="([^"]+)"/);
      return { portID: m ? m[1] : undefined, proxy_password: 'pw' };
    },
    fetchAllServersDataCached: async () => fetchAllResults || [],
    auditLog: () => {}, logActivity: () => {}, getClientIp: () => '127.0.0.1',
    alerts: { trigger: () => {} },
  });
  const app = express();
  app.use(express.json());
  app.use(router);
  return { app, poolDb };
}

describe('GET /api/admin/retail/pool — rows', () => {
  it('отдаёт counts + полный список строк пула', async () => {
    const { app } = mountRetail({
      poolRows: [
        { id: 1, server: 'S1', port_id: 'p1', status: 'free', client_id: null, hold_until: null, test_expires_at: null, reserved_until: null },
        { id: 2, server: 'S1', port_id: 'p2', status: 'blocked', client_id: 'c1', hold_until: '2026-08-20T00:00:00Z', test_expires_at: null, reserved_until: null },
      ],
    });
    const res = await request(app).get('/api/admin/retail/pool');
    expect(res.status).toBe(200);
    expect(res.body.counts).toEqual({ free: 1, blocked: 1 });
    expect(res.body.rows.length).toBe(2);
    expect(res.body.rows[1]).toMatchObject({ port_id: 'p2', status: 'blocked', client_id: 'c1', hold_until: '2026-08-20T00:00:00Z' });
  });
});

describe('POST /api/admin/retail/pool/add', () => {
  it('создаёт free-порты на свободных модемах (пустой portName → apply → insert)', async () => {
    const posted = [];
    const { app, poolDb } = mountRetail({
      posted,
      fetchApiImpl: async (srv, path) => {
        if (path === '/apix/show_status_json') {
          return [
            { modem_details: { IMEI: 'imei_free' }, net_details: { IS_ONLINE: 'yes' } },
            { modem_details: { IMEI: 'imei_busy' }, net_details: { IS_ONLINE: 'yes' } },
            { modem_details: { IMEI: 'imei_off' }, net_details: { IS_ONLINE: 'no' } },
          ];
        }
        if (path === '/apix/list_ports_json') {
          return { imei_busy: [{ portID: 'px', portName: 'corpClient' }] };   // занят клиентом
        }
        return {};
      },
    });
    const res = await request(app).post('/api/admin/retail/pool/add').send({ server: 'S1', count: 1 });
    expect(res.status).toBe(200);
    expect(res.body.created.length).toBe(1);
    expect(res.body.errors).toEqual([]);
    // add_port пошёл на СВОБОДНЫЙ модем, с пустым portName
    expect(posted[0].path).toBe('/conf/add_port?imei=imei_free');
    expect(posted[0].formData.portName).toBe('');
    expect(poolDb._rows.some(r => r.status === 'free' && r.port_id === res.body.created[0])).toBe(true);
  });

  it('count вне 1..50 → 400', async () => {
    const { app } = mountRetail();
    const res = await request(app).post('/api/admin/retail/pool/add').send({ server: 'S1', count: 100 });
    expect(res.status).toBe(400);
  });
});

describe('legacy_preview / legacy_import', () => {
  const legacyResults = [{
    serverName: 'S1',
    ports: {
      imei1: [
        { portID: 'p_leg', portName: 'u_legacy' },     // физик-legacy → кандидат
        { portID: 'p_corp', portName: 'ACME Corp' },   // юрлицо → нет
        { portID: 'p_free', portName: '' },            // пустой → нет
      ],
    },
  }];
  const clients = [
    { id: 'c_leg', login: 'u_legacy', portName: 'u_legacy', clientType: 'individual' },
    { id: 'c_corp', login: 'acme', portName: 'ACME Corp', clientType: 'legal' },
  ];

  it('preview: порты физиков вне пула → кандидаты; уже в пуле — исключены', async () => {
    const { app } = mountRetail({
      clients, fetchAllResults: legacyResults,
      poolRows: [{ id: 1, server: 'S1', port_id: 'p_dup', status: 'leased', client_id: 'c_leg' }],
    });
    const res = await request(app).get('/api/admin/retail/pool/legacy_preview');
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([{ server: 'S1', port_id: 'p_leg', login: 'u_legacy', client_id: 'c_leg' }]);
  });

  it('import: insert leased, идемпотентно (дубль → skipped)', async () => {
    const { app, poolDb } = mountRetail({ clients });
    const items = [{ server: 'S1', port_id: 'p_leg', client_id: 'c_leg' }];
    const r1 = await request(app).post('/api/admin/retail/pool/legacy_import').send({ items });
    expect(r1.body.imported).toBe(1);
    expect(poolDb.byPort('S1', 'p_leg')).toMatchObject({ status: 'leased', client_id: 'c_leg' });
    const r2 = await request(app).post('/api/admin/retail/pool/legacy_import').send({ items });
    expect(r2.body.imported).toBe(0);
    expect(r2.body.skipped[0].reason).toBe('duplicate');
    // после импорта preview пуст
    const prev = await request(mountRetail({ clients, fetchAllResults: legacyResults, poolRows: poolDb._rows }).app)
      .get('/api/admin/retail/pool/legacy_preview');
    expect(prev.body.items).toEqual([]);
  });
});

describe('buy_proxy: тест-день проставляет test_expires_at (+24ч)', () => {
  it('duration_hours=24 → строка пула получает дедлайн возврата', async () => {
    const clients = [{
      id: 'c_t', login: 'u_t', name: 'T', portName: 'u_t', clientType: 'individual',
      emailVerified: true, blocked: false, balance: 1000, testUsed: false, tariffId: null,
    }];
    const before = Date.now();
    const { app, poolDb } = mountRetail({
      clients,
      user: { login: 'u_t', isAdmin: 0 },
      poolRows: [{ id: 1, server: 'S1', port_id: 'p_test', status: 'free', client_id: null }],
      tariffs: { 7: { id: 7, name: 'Тест-день', active: 1, duration_hours: 24, price: 100, min_topup_days: 1, server: 'S1', geo: 'TST' } },
    });
    const res = await request(app)
      .post('/api/client/buy_proxy')
      .send({ tariff_id: 7 });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    const row = poolDb.byPort('S1', 'p_test');
    expect(row.status).toBe('leased');
    expect(row.client_id).toBe('c_t');
    const exp = Date.parse(row.test_expires_at);
    expect(exp).toBeGreaterThanOrEqual(before + 24 * 3600e3);
    expect(exp).toBeLessThanOrEqual(Date.now() + 24 * 3600e3);
    expect(clients[0].testUsed).toBe(true);
  });

  it('обычная подписка → test_expires_at НЕ проставляется', async () => {
    const clients = [{
      id: 'c_s', login: 'u_s', name: 'S', portName: 'u_s', clientType: 'individual',
      emailVerified: true, blocked: false, balance: 1000, testUsed: true, tariffId: null,
    }];
    const { app, poolDb } = mountRetail({
      clients,
      user: { login: 'u_s', isAdmin: 0 },
      poolRows: [{ id: 1, server: 'S1', port_id: 'p_sub', status: 'free', client_id: null }],
      tariffs: { 9: { id: 9, name: 'Базовый', active: 1, duration_hours: null, price: 300, min_topup_days: 1, server: 'S1', geo: 'TST' } },
    });
    const res = await request(app).post('/api/client/buy_proxy').send({ tariff_id: 9 });
    expect(res.status).toBe(200);
    expect(poolDb.byPort('S1', 'p_sub').test_expires_at).toBeFalsy();
  });
});

describe('B6: POST /api/admin/assign_modem — пустой newPortName = отвязка', () => {
  function mountProxies(posted) {
    const router = createProxiesRouter({
      logger: silent,
      authMiddleware: passAuth, adminMiddleware: passAuth,
      fetchApi: async () => ({}),
      fetchApiRaw: async () => ({}),
      postFormApi: async () => ({}),
      findServer: () => SRV,
      parseHtmlInputFields: () => ({ proxy_password: 'pw', portName: 'oldName' }),
      auditLog: () => {}, getClientIp: () => '127.0.0.1',
      proxySmart: { invalidateCache() {} },
      proxyConf: {
        getConfForm: async () => ({ ok: true, html: '<form></form>' }),
        postConfForm: async (srv, path, formData) => { posted.push({ path, formData }); return { ok: true }; },
      },
      modemRotationCache: {},
      fetchAllServersDataCached: async () => [],
      syncRotationLog: async () => {}, _rlSelect: { all: () => [] },
      pushSpeedtestEntry: () => {}, ipHistory: {},
    });
    const app = express();
    app.use(express.json());
    app.use(router);
    return app;
  }

  it('newPortName: "" → 200, portName ушёл пустым (отвязка, НЕ 400)', async () => {
    const posted = [];
    const app = mountProxies(posted);
    const res = await request(app)
      .post('/api/admin/assign_modem')
      .send({ serverName: 'S1', portID: 'p1', newPortName: '' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(posted[0].formData.portName).toBe('');
  });

  it('newPortName отсутствует (undefined) → 400', async () => {
    const app = mountProxies([]);
    const res = await request(app)
      .post('/api/admin/assign_modem')
      .send({ serverName: 'S1', portID: 'p1' });
    expect(res.status).toBe(400);
  });
});
