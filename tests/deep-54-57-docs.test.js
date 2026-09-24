// 2026-09-24 · DEEP-54/55/57: банковские документы — durable-резерв,
// неизменность подписанных, удаление счёта только после подтверждения банка.

import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const apiMod = require('../src/tochka/api.js');

let bankStub, routerFactory;
const noop = () => {};
const logger = { info: noop, warn: noop, error: noop };

function bootRouter(over = {}) {
  const app = express();
  app.use(express.json());
  const clientsArr = over.clients || [];
  const deps = {
    db: over.db, logger,
    authMiddleware: (req, res, next) => { req.user = { login: 'admin' }; next(); },
    adminMiddleware: (req, res, next) => next(),
    verifyJwtSignature: () => true, _pickField: (o, k) => o && o[k],
    insertBankPaymentToDb: noop, dbAudit: {}, dbStmts: {},
    bankPaymentFromRow: r => r, getAllBankPayments: () => [],
    tochkaConfig: over.tochkaConfig || { jwt: 'j', customerCode: 'cc', accountId: 'a' },
    saveTochkaConfig: noop, atomicCredit: noop,
    saveClients: over.saveClients || (() => true), rebuildClientMaps: noop,
    auditLog: noop, logActivity: noop, getClientIp: () => '127.0.0.1',
    appSettings: {}, clients: clientsArr,
    clientById: new Map(clientsArr.map(c => [c.id, c])),
    clientByLogin: new Map(), clientByInn: new Map(),
    apiServers: [], SERVER_COUNTRIES: {},
    fetchAllServersDataCached: async () => [],
    getMoscowToday: () => '2026-09-24',
    ledgerDb: {}, clientsDb: {},
    documentsDb: over.documentsDb,
    runTochkaSync: noop, notifyClient: noop,
  };
  app.use(routerFactory(deps));
  return app;
}

beforeEach(() => {
  bankStub = async () => ({ status: 200, data: { Data: { documentId: 'doc-1' } } });
  apiMod.tochkaRequest = (...args) => bankStub(...args);
  delete require.cache[require.resolve('../src/routes/tochka.js')];
  routerFactory = require('../src/routes/tochka.js');
});
afterAll(() => { /* модульный стаб больше не нужен другим сьютам — vitest изолирует файлы по процессам */ });

describe('DEEP-55: подписанный акт и оплаченный счёт неизменны', () => {
  const client = {
    id: 'c1', login: 'acme', name: 'Acme',
    closingDocuments: [
      { id: 'd1', period: '2026-08', status: 'signed', signedAt: '2026-09-01', items: [{ name: 'x', quantity: 1, price: 100, unit: 'шт', amount: 100 }], totalAmount: 100 },
      { id: 'd2', period: '2026-08', status: 'unsigned', items: [], totalAmount: 0 },
    ],
    bills: [
      { id: 'b1', period: '2026-08', amount: 100, status: 'paid', billNumber: '1/08-2026' },
      { id: 'b2', period: '2026-08', amount: 100, status: 'unpaid', billNumber: '2/08-2026' },
    ],
  };
  const documentsDb = {
    updateClosingItems: () => ({ changes: 1 }),
    updateBillAmount: () => ({ changes: 1 }),
    insertBill: () => ({ changes: 1 }),
  };

  it('PUT signed-акт → 409, содержимое не меняется', async () => {
    const app = bootRouter({ clients: [client], documentsDb });
    const res = await request(app).put('/api/admin/clients/c1/closing_documents/d1')
      .send({ items: [{ name: 'y', quantity: 1, price: 200 }] });
    expect(res.status).toBe(409);
    expect(client.closingDocuments[0].totalAmount).toBe(100);
  });

  it('PUT unsigned-акт → 200', async () => {
    const app = bootRouter({ clients: [client], documentsDb });
    const res = await request(app).put('/api/admin/clients/c1/closing_documents/d2')
      .send({ items: [{ name: 'y', quantity: 1, price: 200 }] });
    expect(res.status).toBe(200);
    expect(client.closingDocuments[1].totalAmount).toBe(200);
  });

  it('PUT оплаченный счёт → 409, сумма прежняя', async () => {
    const app = bootRouter({ clients: [client], documentsDb });
    const res = await request(app).put('/api/admin/clients/c1/bills/b1').send({ amount: 500 });
    expect(res.status).toBe(409);
    expect(client.bills[0].amount).toBe(100);
  });

  it('PUT неоплаченный счёт → 200', async () => {
    const app = bootRouter({ clients: [client], documentsDb });
    const res = await request(app).put('/api/admin/clients/c1/bills/b2').send({ amount: 500 });
    expect(res.status).toBe(200);
    expect(client.bills[1].amount).toBe(500);
  });
});

describe('DEEP-57: удаление счёта — только после подтверждения банка', () => {
  function mkClient() {
    return { id: 'c1', login: 'acme', name: 'Acme', bills: [
      { id: 'b1', tochkaBillId: 'tb1', period: '2026-08', amount: 100, status: 'unpaid', billNumber: '1/08-2026' },
    ] };
  }
  const documentsDb = { deleteBill: () => ({ changes: 1 }) };

  it('банк отвечает status 500 → 502, локальный счёт СОХРАНЁН', async () => {
    bankStub = async () => ({ status: 500, data: {} });
    const client = mkClient();
    const app = bootRouter({ clients: [client], documentsDb });
    const res = await request(app).delete('/api/admin/clients/c1/bill/b1');
    expect(res.status).toBe(502);
    expect(client.bills.length).toBe(1);
  });

  it('банк бросает (timeout) → 502, счёт сохранён (связь не потеряна)', async () => {
    bankStub = async () => { throw new Error('timeout'); };
    const client = mkClient();
    const app = bootRouter({ clients: [client], documentsDb });
    const res = await request(app).delete('/api/admin/clients/c1/bill/b1');
    expect(res.status).toBe(502);
    expect(client.bills.length).toBe(1);
  });

  it('банк 404 (счёта там нет) → ok, локальный удалён', async () => {
    bankStub = async () => ({ status: 404, data: {} });
    const client = mkClient();
    const app = bootRouter({ clients: [client], documentsDb });
    const res = await request(app).delete('/api/admin/clients/c1/bill/b1');
    expect(res.status).toBe(200);
    expect(client.bills.length).toBe(0);
  });
});

describe('DEEP-54: durable-резерв перед вызовом банка', () => {
  it('конфликт резерва (changes=0) → 409, банк НЕ вызывался', async () => {
    let bankCalls = 0;
    bankStub = async () => { bankCalls++; return { status: 200, data: { Data: { documentId: 'd' } } }; };
    const client = { id: 'c1', login: 'acme', name: 'Acme', inn: '7700000000', balance: 100000, bills: [] };
    const documentsDb = {
      nextDocNumber: () => ({ label: '1/09-2026' }),
      insertBill: () => ({ changes: 0 }),   // конкурент уже занял period
    };
    const app = bootRouter({ clients: [client], documentsDb });
    const res = await request(app).post('/api/admin/tochka/create_bill')
      .send({ clientId: 'c1', amount: 1000, period: '2026-09' });
    expect(res.status).toBe(409);
    expect(bankCalls).toBe(0);
    expect(client.bills.length).toBe(0);
  });

  it('банк бросил (неизвестный исход) → 502, резерв откачен, счёта нет', async () => {
    bankStub = async () => { throw new Error('timeout'); };
    const deleted = [];
    const client = { id: 'c1', login: 'acme', name: 'Acme', inn: '7700000000', balance: 100000, bills: [] };
    const documentsDb = {
      nextDocNumber: () => ({ label: '1/09-2026' }),
      insertBill: () => ({ changes: 1 }),
      deleteBill: (id) => { deleted.push(id); return { changes: 1 }; },
    };
    const app = bootRouter({ clients: [client], documentsDb });
    const res = await request(app).post('/api/admin/tochka/create_bill')
      .send({ clientId: 'c1', amount: 1000, period: '2026-09' });
    expect(res.status).toBe(502);
    expect(deleted.length).toBe(1);
    expect(client.bills.length).toBe(0);
  });

  it('банк создал → счёт в памяти с tochkaBillId', async () => {
    const client = { id: 'c1', login: 'acme', name: 'Acme', inn: '7700000000', balance: 100000, bills: [] };
    const documentsDb = {
      nextDocNumber: () => ({ label: '1/09-2026' }),
      insertBill: () => ({ changes: 1 }),
    };
    const app = bootRouter({ clients: [client], documentsDb });
    const res = await request(app).post('/api/admin/tochka/create_bill')
      .send({ clientId: 'c1', amount: 1000, period: '2026-09' });
    expect(res.status).toBe(200);
    expect(client.bills.length).toBe(1);
    expect(client.bills[0].tochkaBillId).toBe('doc-1');
  });
});
