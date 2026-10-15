// 2026-10-15: ЛК розницы — выбор «физлицо / юрлицо», анкета юрлица с задачей
// руководителю, заказы прокси РФ (выдаёт менеджер), справочник магазина.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'module';
import request from 'supertest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const express = require('express');
const Database = require('better-sqlite3');
const createRouter = require('../src/routes/client-onboarding.js');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const REQ = {
  legal_name: 'ООО «Ромашка»', inn: '7701234567', kpp: '770101001', ogrn: '1027700000000',
  legal_address: 'г. Москва, ул. Ленина, д. 1', signer_name: 'Иванов Иван Иванович',
  bank_name: 'АО «Банк»', bik: '044525225', account: '40702810000000000001', corr_account: '30101810400000000225',
  contact_name: 'Пётр', contact_phone: '+79990000000', edo_operator: 'Диадок', edo_id: '2BM-7701234567',
};

let db, clients, alerts, crm, settings, app, saved;
function mount(login) {
  const a = express();
  a.use(express.json());
  a.use(createRouter({
    db, logger: { info() {}, warn() {}, error() {} },
    authMiddleware: (req, res, next) => { req.user = { login }; next(); },
    adminMiddleware: (req, res, next) => next(),
    clients, saveClients: () => { saved++; }, alerts, getSetting: (k, d) => (k in settings ? settings[k] : d),
    crm, auditLog: () => {}, getClientIp: () => '1.1.1.1', logActivity: () => {},
    tariffsDb: { publicActive: () => [
      { id: 1, name: '1-29', geo: 'MD', type: 'per_modem', price: 4500, min_proxies: 1, duration_hours: null },
      { id: 2, name: '30+', geo: 'md', type: 'per_modem', price: 4275, min_proxies: 30, duration_hours: null },
      { id: 9, name: 'Тест-день', geo: 'MD', type: 'per_modem', price: 100, min_proxies: 1, duration_hours: 24 },
    ] },
  }));
  return a;
}

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(fs.readFileSync(path.join(root, 'migrations/113_onboarding_and_proxy_orders.sql'), 'utf8'));
  clients = [
    { id: 'c1', login: 'retail1', email: 'r1@example.com', clientType: 'individual', consentPdAt: '2026-10-01' },
    { id: 'c2', login: 'b2b', clientType: 'legal', inn: '7700000000' },
  ];
  alerts = { trigger: vi.fn() };
  crm = { pushTask: vi.fn(async () => ({ taskId: 'task-1' })) };
  settings = { crm_db_url: 'postgres://x', retail_enabled: true };
  saved = 0;
  app = mount('retail1');
});

describe('выбор физлицо / юрлицо', () => {
  it('новый розничный клиент — нужен выбор; B2B-юрлицо — нет', async () => {
    expect((await request(app).get('/api/client/onboarding')).body).toMatchObject({ needsChoice: true, entityType: null });
    expect((await request(mount('b2b')).get('/api/client/onboarding')).body).toMatchObject({ needsChoice: false, entityType: 'legal' });
  });

  it('физлицо: выбор сохраняется, больше не спрашиваем, задач и алертов нет', async () => {
    const r = await request(app).post('/api/client/onboarding').send({ entity_type: 'individual' });
    expect(r.body).toMatchObject({ ok: true, entityType: 'individual' });
    expect((await request(app).get('/api/client/onboarding')).body.needsChoice).toBe(false);
    expect(alerts.trigger).not.toHaveBeenCalled();
    expect(crm.pushTask).not.toHaveBeenCalled();
  });

  it('юрлицо: реквизиты в карточке, задача руководителю в CRM и Telegram, тип клиента НЕ меняется', async () => {
    const r = await request(app).post('/api/client/onboarding').send({ entity_type: 'legal', requisites: REQ });
    expect(r.body).toMatchObject({ ok: true, entityType: 'legal', contractStatus: 'awaiting_template' });
    expect(clients[0]).toMatchObject({ inn: '7701234567', kpp: '770101001', legalName: 'ООО «Ромашка»', clientType: 'individual' });
    expect(crm.pushTask).toHaveBeenCalledTimes(1);
    const task = crm.pushTask.mock.calls[0][1];
    expect(task.title).toContain('Договор по ЭДО');
    expect(task.body).toContain('выслать договор по ЭДО');
    expect(task.body).toContain('Диадок');
    expect(alerts.trigger).toHaveBeenCalledWith('legal_onboarding', expect.objectContaining({ inn: '7701234567', crm_task: true }));
    expect(db.prepare('SELECT manager_task FROM client_onboarding').get().manager_task).toBe('task-1');
    // вернуться в «физлицо» самостоятельно нельзя
    expect((await request(app).post('/api/client/onboarding').send({ entity_type: 'individual' })).status).toBe(409);
  });

  it('проверка реквизитов: ИНН, КПП у организации, р/с и БИК, контакт', async () => {
    const bad = async (patch) => (await request(app).post('/api/client/onboarding').send({ entity_type: 'legal', requisites: { ...REQ, ...patch } })).body;
    expect((await bad({ inn: '123' })).field).toBe('inn');
    expect((await bad({ kpp: '' })).field).toBe('kpp');
    expect((await bad({ inn: '770123456789', kpp: '' })).ok).toBe(true);        // ИП: 12 цифр без КПП
    expect((await bad({ account: '4070' })).field).toBe('account');
    expect((await bad({ bik: 'abc' })).field).toBe('bik');
    expect((await bad({ contact_phone: '', contact_email: '' })).field).toBe('contact_phone');
  });

  it('CRM недоступна — анкета принимается, алерт в Telegram всё равно уходит', async () => {
    crm.pushTask = vi.fn(async () => { throw new Error('ECONNREFUSED'); });
    const r = await request(app).post('/api/client/onboarding').send({ entity_type: 'legal', requisites: REQ });
    expect(r.body.ok).toBe(true);
    expect(alerts.trigger).toHaveBeenCalledWith('legal_onboarding', expect.objectContaining({ crm_task: false }));
  });
});

describe('заказы прокси РФ', () => {
  it('заказ создаётся без списания, менеджер получает задачу (CRM + Telegram), клиент видит статус', async () => {
    const r = await request(app).post('/api/client/proxy_orders').send({ proxy_type: 'Мобильные (4G/LTE)', geo: 'Москва', quantity: 10, comment: 'для парсинга' });
    expect(r.body).toMatchObject({ ok: true, order: { status: 'new', quantity: 10 } });
    expect(crm.pushTask.mock.calls[0][1].title).toContain('Выдать прокси РФ: 10 шт');
    expect(alerts.trigger).toHaveBeenCalledWith('proxy_order_ru', expect.objectContaining({ quantity: 10, geo: 'Москва' }));
    const list = (await request(app).get('/api/client/proxy_orders')).body.orders;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ region: 'RU', status: 'new' });
  });

  it('валидация и защита от спама: не больше 5 новых заявок за сутки', async () => {
    expect((await request(app).post('/api/client/proxy_orders').send({ proxy_type: 'x', geo: 'y', quantity: 0 })).status).toBe(400);
    for (let i = 0; i < 5; i++) await request(app).post('/api/client/proxy_orders').send({ proxy_type: 'x', geo: 'y', quantity: 1 });
    expect((await request(app).post('/api/client/proxy_orders').send({ proxy_type: 'x', geo: 'y', quantity: 1 })).status).toBe(429);
  });
});

describe('справочник магазина', () => {
  it('Европа — гео с отсортированными ступенями (без тест-дня); Россия — типы и гео из настроек', async () => {
    settings.ru_proxy_geos = 'Москва, Казань';
    const r = (await request(app).get('/api/client/shop_catalog')).body;
    expect(r.europe).toEqual([{ geo: 'MD', name: 'Молдова', type: 'Мобильные (4G/LTE)', tiers: [
      { id: 1, name: '1-29', geo: 'MD', price: 4500, min_proxies: 1 }, { id: 2, name: '30+', geo: 'MD', price: 4275, min_proxies: 30 }] }]);
    expect(r.russia.geos).toEqual(['Москва', 'Казань']);
    expect(r.russia.types.length).toBeGreaterThan(0);
    expect(r.testDay).toMatchObject({ id: 9 });
  });
});

describe('админка: статусы заказов и договоров', () => {
  it('менеджер меняет статус заказа и договора; клиент видит новый статус', async () => {
    await request(app).post('/api/client/proxy_orders').send({ proxy_type: 'x', geo: 'Москва', quantity: 3 });
    await request(app).post('/api/client/onboarding').send({ entity_type: 'legal', requisites: REQ });
    const adm = mount('admin');
    const orders = (await request(adm).get('/api/admin/proxy_orders')).body.orders;
    expect(orders[0]).toMatchObject({ client: 'ООО «Ромашка»', status: 'new' });
    expect((await request(adm).post('/api/admin/proxy_orders/' + orders[0].id).send({ status: 'done' })).body.ok).toBe(true);
    expect((await request(adm).post('/api/admin/proxy_orders/' + orders[0].id).send({ status: 'bogus' })).status).toBe(400);
    expect((await request(app).get('/api/client/proxy_orders')).body.orders[0].status).toBe('done');
    const legal = (await request(adm).get('/api/admin/onboarding')).body.items;
    expect(legal[0]).toMatchObject({ client_id: 'c1', contract_status: 'awaiting_template' });
    expect((await request(adm).post('/api/admin/onboarding/c1').send({ contract_status: 'sent' })).body.ok).toBe(true);
    expect((await request(app).get('/api/client/onboarding')).body.contractStatus).toBe('sent');
  });
});
