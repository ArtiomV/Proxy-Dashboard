// 2026-09-18 · Регрессии DEEP-20/21 (FIX-SPEC §): идемпотентность покупки по
// purchase_id (а НЕ по общему ключу client+date+type) и сумма ledger =
// изменению баланса. Настоящие SQLite repositories (retail_pool,
// retail_purchases, billing_ledger, clients) и настоящий atomic на общей
// тестовой БД; заглушается только бокс ProxySmart.
// На коде до исправления каждый тест падал:
//   DEEP-20: вторая покупка в день получала duplicate по UNIQUE(client,date,
//            type) — баланс списывался один раз при двух выданных портах, а
//            first_day-строка удовлетворяла гварду дневного биллинга;
//   DEEP-21: покупка передавала entry без cost → billing_ledger.amount = 0
//            при реальном списании 100+ ₽.

import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import crypto from 'crypto';
import { createRequire } from 'module';
import { bootApp } from './_helpers/app.js';

const cjsRequire = createRequire(import.meta.url);
const createRetailRouter = cjsRequire('../src/routes/retail.js');
const retailPoolDb = cjsRequire('../src/db/retail-pool.js');       // init'ed сервером на этой БД
const retailPurchasesDb = cjsRequire('../src/db/retail-purchases.js');
const ledgerDb = cjsRequire('../src/db/ledger.js');

let db, atomic;
const TAG = 'd2021';
const seeded = { pool: [], purchases: [], clients: [] };

beforeAll(() => {
  db = bootApp().db;
  atomic = cjsRequire('../src/billing/atomic.js');   // инициализирован server.js
});

afterEach(() => {
  while (seeded.pool.length) {
    try { db.prepare('DELETE FROM retail_pool WHERE id = ?').run(seeded.pool.pop()); } catch (_) {}
  }
  while (seeded.purchases.length) {
    try { db.prepare('DELETE FROM retail_purchases WHERE id = ?').run(seeded.purchases.pop()); } catch (_) {}
  }
  // покупки, созданные роутом buy_proxy для клиентов этого файла
  try { db.prepare("DELETE FROM retail_purchases WHERE client_id LIKE 'd2021_%'").run(); } catch (_) {}
  while (seeded.clients.length) {
    const id = seeded.clients.pop();
    try {
      db.prepare('DELETE FROM billing_ledger WHERE client_id = ?').run(id);
      db.prepare('DELETE FROM clients WHERE id = ?').run(id);
    } catch (_) {}
  }
});

// Клиент: строка в clients (для atomic) + объект в памяти (для роутера).
function seedClient(tag, balance) {
  const id = `${TAG}_${tag}_` + crypto.randomBytes(3).toString('hex');
  const login = id;
  db.prepare('INSERT INTO clients (id, login, name, balance, created_at) VALUES (?, ?, ?, ?, datetime(\'now\'))')
    .run(id, login, 'DEEP ' + tag, balance);
  seeded.clients.push(id);
  return { id, login, name: 'DEEP ' + tag, portName: login, clientType: 'individual',
    emailVerified: true, blocked: false, balance, testUsed: false, tariffId: null };
}

function seedFreePort(tag) {
  const portId = `${TAG}_${tag}_` + crypto.randomBytes(2).toString('hex');
  retailPoolDb.insertFree('S1', portId);
  const row = retailPoolDb.byPort('S1', portId);
  seeded.pool.push(row.id);
  return row;
}

// Управляемый «бокс»: postConfForm применяет portName к состоянию порта.
function mkNet() {
  const state = {};
  return {
    state,
    proxyConf: {
      getConfForm: async () => ({ ok: true, html: '<form></form>' }),
      postConfForm: async (_srv, path, formData) => {
        const pid = path.split('/').pop();
        state[pid] = { ...(state[pid] || { portID: pid }), portName: formData.portName };
        return { ok: true };
      },
      getConfAction: async () => ({ ok: true }),
    },
    fetchApi: async (_srv, path) => {
      if (path === '/apix/list_ports_json') return { imei1: Object.values(state) };
      return { ok: true };
    },
  };
}

const SUB_TARIFF = { id: 77, name: 'Подписка', active: 1, public: 1, duration_hours: null, price: 3100, min_topup_days: 1, server: 'S1', geo: 'TST' };

function mountBuy(client, net, { atomicDebit } = {}) {
  const router = createRetailRouter({
    logger: { info() {}, warn() {}, error() {} },
    authMiddleware: (req, _res, next) => { req.user = { login: client.login, isAdmin: 0 }; next(); },
    adminMiddleware: (_req, _res, next) => next(),
    clients: [client], saveClients: () => {},
    tariffsDb: { byId: (id) => (id === SUB_TARIFF.id ? SUB_TARIFF : null) },
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

function ledgerCharges(clientId) {
  return db.prepare("SELECT * FROM billing_ledger WHERE client_id = ? AND type = 'charge' ORDER BY id").all(clientId);
}
function dbBalance(clientId) {
  return db.prepare('SELECT balance FROM clients WHERE id = ?').get(clientId).balance;
}
// Тот же расчёт, что в buy_proxy (price / дней в текущем месяце).
function expectedCharge() {
  const days = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0).getDate();
  return Math.round((SUB_TARIFF.price / days) * 100) / 100;
}

describe('DEEP-20/21: независимая идемпотентность покупки и сумма ledger', () => {
  it('две покупки в один день — обе списаны (разные purchase_id), сумма ledger = списанию', async () => {
    const client = seedClient('two', 500);
    seedFreePort('a');
    seedFreePort('b');
    const app = mountBuy(client, mkNet());

    const r1 = await request(app).post('/api/client/buy_proxy').send({ tariff_id: SUB_TARIFF.id });
    expect(r1.status).toBe(200);
    expect(r1.body.charged).toBe(expectedCharge());
    const r2 = await request(app).post('/api/client/buy_proxy').send({ tariff_id: SUB_TARIFF.id });
    expect(r2.status).toBe(200);
    expect(r2.body.charged).toBe(expectedCharge());

    // На старом коде вторая покупка получала duplicate по UNIQUE(client,date,
    // type): баланс 500 − charge (один раз), портов выдано два.
    expect(dbBalance(client.id)).toBe(Math.round((500 - 2 * expectedCharge()) * 100) / 100);
    const rows = ledgerCharges(client.id);
    expect(rows.length).toBe(2);
    // DEEP-21: сумма ledger равна изменению баланса (на старом коде — 0).
    for (const row of rows) {
      expect(row.amount).toBe(expectedCharge());
      expect(row.purchase_id).toBeTruthy();
      expect(row.balance_after - row.balance_before).toBeCloseTo(-expectedCharge(), 2);
    }
    expect(rows[0].purchase_id).not.toBe(rows[1].purchase_id);
    // durable-покупки завершены
    expect(rows.every(r => retailPurchasesDb.byId(r.purchase_id).status === 'charged')).toBe(true);
  });

  it('first_day-строка покупки НЕ считается суточным расчётом (гварды биллинга)', async () => {
    const client = seedClient('guard', 500);
    seedFreePort('g');
    const app = mountBuy(client, mkNet());
    const r = await request(app).post('/api/client/buy_proxy').send({ tariff_id: SUB_TARIFF.id });
    expect(r.status).toBe(200);
    const mskToday = new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 10);
    // На старом коде existsChargeOnDate находил first_day-строку и останавливал
    // дневной расчёт ВСЕХ клиентов за эту дату.
    expect(ledgerDb.existsChargeOnDate(mskToday)).toBeFalsy();
    expect(ledgerDb.chargedClientIdsForDate(mskToday)).not.toContain(client.id);
  });

  it('повтор ТОЙ ЖЕ покупки (replay по purchase_id) — duplicate, деньги один раз', () => {
    const client = seedClient('replay', 500);
    const purchaseId = 'pur_' + TAG + '_replay';
    const entry = {
      date: new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 10),
      type: 'charge', note: 'first_day', cost: 100, purchase_id: purchaseId,
    };
    const first = atomic.atomicDebit(client.id, 100, entry, { minBalance: 0 });
    const second = atomic.atomicDebit(client.id, 100, { ...entry }, { minBalance: 0 });
    expect(first.duplicate).toBeFalsy();
    expect(second.duplicate).toBe(true);
    expect(dbBalance(client.id)).toBe(400);
    const rows = ledgerCharges(client.id);
    expect(rows.length).toBe(1);
    expect(rows[0].purchase_id).toBe(purchaseId);
  });

  it('расхождение суммы ledger и изменения баланса — ошибка до транзакции (DEEP-21)', () => {
    const client = seedClient('mismatch', 500);
    // charge без cost — сумма подставляется из списания (единый источник);
    // явно ДРУГАЯ сумма — программная ошибка, а не нулевая/иная строка журнала.
    expect(() => atomic.atomicDebit(client.id, 100, { type: 'charge', date: '2026-09-18', cost: 50 }))
      .toThrow(/mismatch/);
    expect(dbBalance(client.id)).toBe(500);
    expect(ledgerCharges(client.id).length).toBe(0);
  });
});
