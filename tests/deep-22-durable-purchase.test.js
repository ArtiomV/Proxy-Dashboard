// 2026-09-18 · Регрессии DEEP-22 (FIX-SPEC §): восстанавливаемая операция
// покупки. Настоящие SQLite repositories (retail_pool, retail_purchases,
// billing_ledger) и настоящий atomic; заглушается только бокс.
// Гонки — управляемые Promise-барьеры, без случайных sleep.
// На коде до исправления каждый тест падал:
//   • два конкурентных запроса проходили проверку одного баланса (деньги не
//     резервировались) — списание происходило дважды/в минус;
//   • при неподтверждённой отвязке порт возвращался в free с живым доступом;
//   • ошибка списания после lease только логировалась, API отвечал charged;
//   • expiredReservations никем не вызывался — reserved без исполнителя TTL.

import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import crypto from 'crypto';
import { createRequire } from 'module';
import { bootApp } from './_helpers/app.js';

const cjsRequire = createRequire(import.meta.url);
const createRetailRouter = cjsRequire('../src/routes/retail.js');
const retailGuardMod = cjsRequire('../src/jobs/retail-guard.js');
const retailPoolDb = cjsRequire('../src/db/retail-pool.js');
const retailPurchasesDb = cjsRequire('../src/db/retail-purchases.js');

let db, atomic;
const TAG = 'd22';
const seeded = { pool: [], purchases: [], clients: [] };

beforeAll(() => {
  db = bootApp().db;
  atomic = cjsRequire('../src/billing/atomic.js');
});

afterEach(() => {
  while (seeded.pool.length) { try { db.prepare('DELETE FROM retail_pool WHERE id = ?').run(seeded.pool.pop()); } catch (_) {} }
  while (seeded.purchases.length) { try { db.prepare('DELETE FROM retail_purchases WHERE id = ?').run(seeded.purchases.pop()); } catch (_) {} }
  // покупки, созданные роутом buy_proxy для клиентов этого файла
  try { db.prepare("DELETE FROM retail_purchases WHERE client_id LIKE 'd22_%'").run(); } catch (_) {}
  while (seeded.clients.length) {
    const id = seeded.clients.pop();
    try {
      db.prepare('DELETE FROM billing_ledger WHERE client_id = ?').run(id);
      db.prepare('DELETE FROM clients WHERE id = ?').run(id);
    } catch (_) {}
  }
});

function seedClient(tag, balance) {
  const id = `${TAG}_${tag}_` + crypto.randomBytes(3).toString('hex');
  db.prepare('INSERT INTO clients (id, login, name, balance, created_at) VALUES (?, ?, ?, ?, datetime(\'now\'))')
    .run(id, id, 'DEEP ' + tag, balance);
  seeded.clients.push(id);
  return { id, login: id, name: 'DEEP ' + tag, portName: id, clientType: 'individual',
    emailVerified: true, blocked: false, balance, testUsed: false, tariffId: null, allowDebt: false };
}
function seedPoolRow(tag, status, extra = {}) {
  const portId = `${TAG}_${tag}_` + crypto.randomBytes(2).toString('hex');
  if (status === 'free') retailPoolDb.insertFree('S1', portId);
  else retailPoolDb.insertLeased('S1', portId, extra.client_id || null);
  const row = retailPoolDb.byPort('S1', portId);
  seeded.pool.push(row.id);
  if (status === 'reserved') {
    db.prepare("UPDATE retail_pool SET status='reserved', client_id=?, reserved_until=? WHERE id=?")
      .run(extra.client_id || null, extra.reserved_until || new Date(Date.now() + 60000).toISOString(), row.id);
  }
  return retailPoolDb.byId(row.id);
}
function seedPurchase(p) {
  retailPurchasesDb.createReserved({
    id: p.id, clientId: p.client_id, tariffId: 77, server: 'S1', portId: p.port_id,
    poolRowId: p.pool_row_id, amount: p.amount, testDay: false,
  });
  seeded.purchases.push(p.id);
  if (p.status && p.status !== 'reserved') retailPurchasesDb.setStatus(p.id, p.status, p.error || null);
  return retailPurchasesDb.byId(p.id);
}

// Управляемый бокс с барьером на форме edit_port (гонки без sleep).
function mkNet({ barrier = false, failAssign = false, silentReject = false } = {}) {
  const state = {};
  let release = null;
  const net = {
    state,
    barrierPromise: barrier ? new Promise(r => { release = r; }) : null,
    releaseBarrier: () => release && release(),
    proxyConf: {
      getConfForm: async (_srv, path) => {
        if (failAssign) return { ok: false, reason: 'box offline' };
        if (barrier && path.includes('/conf/edit_port/')) await net.barrierPromise;
        return { ok: true, html: '<form></form>' };
      },
      postConfForm: async (_srv, path, formData) => {
        const pid = path.split('/').pop();
        if (!silentReject) {
          state[pid] = { ...(state[pid] || { portID: pid }), portName: formData.portName };
        } else {
          state[pid] = state[pid] || { portID: pid, portName: '' };
        }
        return { ok: true };
      },
      getConfAction: async () => ({ ok: true }),
    },
    fetchApi: async (_srv, path) => {
      if (path === '/apix/list_ports_json') return { imei1: Object.values(state) };
      return { ok: true };
    },
  };
  return net;
}

const TARIFF = { id: 77, name: 'Подписка', active: 1, duration_hours: null, price: 3100, min_topup_days: 1, server: 'S1', geo: 'TST' };
function expectedCharge() {
  const days = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0).getDate();
  return Math.round((TARIFF.price / days) * 100) / 100;
}
function dbBalance(id) { return db.prepare('SELECT balance FROM clients WHERE id = ?').get(id).balance; }

function mountBuy(client, net, { atomicDebit } = {}) {
  const router = createRetailRouter({
    logger: { info() {}, warn() {}, error() {} },
    authMiddleware: (req, _res, next) => { req.user = { login: client.login, isAdmin: 0 }; next(); },
    adminMiddleware: (_req, _res, next) => next(),
    clients: [client], saveClients: () => {},
    tariffsDb: { byId: (id) => (id === TARIFF.id ? TARIFF : null) },
    retailPoolDb, retailPurchasesDb,
    atomicDebit: atomicDebit || atomic.atomicDebit,
    getSetting: (k, d) => ({ retail_enabled: true, retail_pool_servers: 'S1', retail_test_day_price: 100 })[k] ?? d,
    findServer: () => ({ name: 'S1' }),
    fetchApi: net.fetchApi,
    proxyConf: net.proxyConf,
    proxySmart: { invalidateCache() {} },
    parseHtmlInputFields: () => ({ proxy_password: 'pw' }),
    fetchAllServersDataCached: async () => [],
    auditLog: () => {}, logActivity: () => {}, getClientIp: () => '127.0.0.1',
    alerts: { trigger: () => {} },
    getMoscowNow: () => new Date(),
  });
  const app = express();
  app.use(express.json());
  app.use(router);
  return app;
}

// retail-guard с настоящими repositories и atomic — recovery-проход покупок.
function mountGuard(client, net) {
  return retailGuardMod.create({
    logger: { info() {}, warn() {}, error() {} },
    logActivity() {}, auditLog() {}, alerts: { trigger: () => {} },
    proxyConf: net.proxyConf, findServer: () => ({ name: 'S1' }),
    fetchApi: net.fetchApi,
    saveClients: () => {}, getMoscowNow: () => new Date(),
    fetchAllServersDataCached: async () => [],
    clients: [client], retailPoolDb, retailPurchasesDb,
    tariffsDb: { byId: () => null },
    getSetting: (k, d) => ({ retail_enabled: true, retail_pool_servers: 'S1' })[k] ?? d,
    atomicDebit: atomic.atomicDebit,
    notifyClient: async () => {},
    kvGet: () => null, kvSet: () => {},
  });
}

describe('DEEP-22: durable-покупка с финансовым резервом и recovery', () => {
  it('два конкурентных запроса: второй — 409 PURCHASE_IN_FLIGHT, списание одно', async () => {
    const client = seedClient('race', 2 * expectedCharge());
    seedPoolRow('r1', 'free');
    seedPoolRow('r2', 'free');
    const net = mkNet({ barrier: true });   // первый запрос повисает в assign
    const app = mountBuy(client, net);

    // supertest стартует запрос только по then/await — привязываем сразу.
    const p1 = request(app).post('/api/client/buy_proxy').send({ tariff_id: TARIFF.id }).then(r => r);
    // Барьер на наблюдаемом состоянии: первый запрос зарезервировал порт
    // (значит, дальше он повис в assign на barrierPromise).
    for (let i = 0; i < 100 && !retailPoolDb.byStatus('reserved').length; i++) {
      await new Promise(r => setImmediate(r));
    }
    expect(retailPoolDb.byStatus('reserved').length).toBe(1);
    const r2 = await request(app).post('/api/client/buy_proxy').send({ tariff_id: TARIFF.id });
    // На старом коде второй запрос проходил проверку того же баланса и
    // покупал второй порт. Теперь — отказ durable-резерва.
    expect(r2.status).toBe(409);
    expect(r2.body.code).toBe('PURCHASE_IN_FLIGHT');

    net.releaseBarrier();
    const r1 = await p1;
    expect(r1.status).toBe(200);
    expect(r1.body.charged).toBe(expectedCharge());
    expect(dbBalance(client.id)).toBe(Math.round((2 * expectedCharge() - expectedCharge()) * 100) / 100);
    expect(db.prepare("SELECT COUNT(*) n FROM billing_ledger WHERE client_id = ? AND type='charge'").get(client.id).n).toBe(1);
  });

  it('провижининг упал, отвязка НЕ подтверждена: порт НЕ free, покупка quarantine', async () => {
    const client = seedClient('prov', 500);
    const poolRow = seedPoolRow('q', 'free');
    // failAssign: assign падает; _tryUnbindPort тоже не может подтвердить
    // (getConfForm !ok) — исход сети неизвестен.
    const net = mkNet({ failAssign: true });
    const app = mountBuy(client, net);

    const r = await request(app).post('/api/client/buy_proxy').send({ tariff_id: TARIFF.id });
    expect(r.status).toBe(502);
    // На старом коде release() возвращал активный порт в free.
    expect(retailPoolDb.byId(poolRow.id).status).not.toBe('free');
    const purchases = retailPurchasesDb.byStatus('quarantine').filter(p => p.client_id === client.id);
    expect(purchases.length).toBe(1);
    expect(dbBalance(client.id)).toBe(500);   // деньги не тронуты
  });

  it('отказ списания после lease: API НЕ charged, recovery досписывает по purchase_id', async () => {
    const client = seedClient('chg', 500);
    seedPoolRow('c', 'free');
    const net = mkNet();
    const charge = expectedCharge();
    // Роут с падающим atomicDebit (порт уже выдан в этот момент).
    const app = mountBuy(client, net, {
      atomicDebit: () => { throw new Error('ledger db locked'); },
    });
    const r = await request(app).post('/api/client/buy_proxy').send({ tariff_id: TARIFF.id });
    expect(r.status).toBe(200);
    // На старом коде API сообщал charged при фактическом отказе.
    expect(r.body.charged).toBe(0);
    expect(r.body.charge_pending).toBe(true);
    expect(dbBalance(client.id)).toBe(500);
    const failed = retailPurchasesDb.recoverableCharges().filter(p => p.client_id === client.id);
    expect(failed.length).toBe(1);

    // Recovery (retail-guard) досписывает — идемпотентно по purchase_id.
    await mountGuard(client, net).runOnce();
    expect(retailPurchasesDb.byId(failed[0].id).status).toBe('charged');
    expect(dbBalance(client.id)).toBe(Math.round((500 - charge) * 100) / 100);
    const rows = db.prepare("SELECT * FROM billing_ledger WHERE client_id = ? AND type='charge'").all(client.id);
    expect(rows.length).toBe(1);
    expect(rows[0].purchase_id).toBe(failed[0].id);
    // Второй прогон recovery — без двойного списания.
    await mountGuard(client, net).runOnce();
    expect(dbBalance(client.id)).toBe(Math.round((500 - charge) * 100) / 100);
  });

  it('истёкший резерв: порт фактически выдан (portName клиента) → lease + досписание, НЕ free', async () => {
    const client = seedClient('exp', 500);
    const poolRow = seedPoolRow('e1', 'reserved', {
      client_id: client.id,
      reserved_until: new Date(Date.now() - 3600e3).toISOString(),   // TTL давно истёк
    });
    const purchase = seedPurchase({
      id: 'pur_' + TAG + '_e1', client_id: client.id, port_id: poolRow.port_id,
      pool_row_id: poolRow.id, amount: 100, status: 'provisioned',
    });
    const net = mkNet();
    net.state[poolRow.port_id] = { portID: poolRow.port_id, portName: client.login };   // порт выдан, процесс умер
    const guard = mountGuard(client, net);
    await guard.runOnce();
    // На старом коде expiredReservations никем не вызывался — reserved висел вечно.
    expect(retailPoolDb.byId(poolRow.id).status).toBe('leased');
    await guard.runOnce();   // charge_failed → досписание следующим циклом
    expect(retailPurchasesDb.byId(purchase.id).status).toBe('charged');
    expect(dbBalance(client.id)).toBe(400);
  });

  it('истёкший резерв: portName пуст (выдача не дошла) → free + покупка failed', async () => {
    const client = seedClient('expf', 500);
    const poolRow = seedPoolRow('e2', 'reserved', {
      client_id: client.id,
      reserved_until: new Date(Date.now() - 3600e3).toISOString(),
    });
    const purchase = seedPurchase({
      id: 'pur_' + TAG + '_e2', client_id: client.id, port_id: poolRow.port_id,
      pool_row_id: poolRow.id, amount: 100, status: 'provisioning',
    });
    const net = mkNet();
    net.state[poolRow.port_id] = { portID: poolRow.port_id, portName: '' };   // отвязка подтверждена
    await mountGuard(client, net).runOnce();
    expect(retailPoolDb.byId(poolRow.id).status).toBe('free');
    expect(retailPurchasesDb.byId(purchase.id).status).toBe('failed');
    expect(dbBalance(client.id)).toBe(500);   // денег не списано
  });

  it('истёкший резерв: бокс недоступен — порт НЕ освобождается (TTL не доказательство)', async () => {
    const client = seedClient('expu', 500);
    const poolRow = seedPoolRow('e3', 'reserved', {
      client_id: client.id,
      reserved_until: new Date(Date.now() - 3600e3).toISOString(),
    });
    seedPurchase({
      id: 'pur_' + TAG + '_e3', client_id: client.id, port_id: poolRow.port_id,
      pool_row_id: poolRow.id, amount: 100, status: 'provisioning',
    });
    const net = mkNet();
    net.fetchApi = async () => { throw new Error('box unreachable'); };
    await mountGuard(client, net).runOnce();
    // Неизвестное состояние сети ≠ free: резерв остаётся до подтверждения.
    expect(retailPoolDb.byId(poolRow.id).status).toBe('reserved');
  });
});
