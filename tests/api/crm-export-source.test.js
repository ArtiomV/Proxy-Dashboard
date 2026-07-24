// 2026-07-23: «источник не экспортируется» — companies читал company.leadSource
// (всегда NULL), люди — person.createdBySource (IMPORT/MANUAL, не источник лида).
// Реальный источник живёт на сделке (opportunity.leadSource / istochnikSdelki).
// Тест: SQL тянет источник из сделки, значения мапятся в русские лейблы.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import express from 'express';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

// Fake pg.Client: отдаёт консервные строки и запоминает SQL.
let lastSql = '';
let cannedRows = [];
class FakeClient {
  constructor() {}
  async connect() {}
  async query(sql) { lastSql = sql; return { rows: cannedRows }; }
  async end() {}
}
require.cache[require.resolve('pg')] = { id: 'pg', filename: 'pg', loaded: true, exports: { Client: FakeClient } };

const createCrmExportRouter = require('../../src/routes/crm-export.js');

let app;
beforeAll(() => {
  process.env.CRM_WORKSPACE = 'ws_test';
  const silent = { info() {}, warn() {}, error() {}, debug() {} };
  const passAuth = (req, res, next) => { req.user = { login: 't', isAdmin: 1 }; next(); };
  app = express();
  app.use(createCrmExportRouter({
    logger: silent,
    authMiddleware: passAuth, adminMiddleware: passAuth,
    appSettings: { crm_db_url: 'postgres://u:p@127.0.0.1:5432/db' },
    setSettings: () => {},
  }));
});
afterAll(() => { delete process.env.CRM_WORKSPACE; });

describe('CRM export — «Источник» из сделки, а не из пустых полей', () => {
  it('companies: источник мапится в лейбл; SQL ходит в opportunity', async () => {
    cannedRows = [{
      nm: 'Тест', dom: '', inn: '', em: '', bs: '', pt: '', uc: '', pc: '', pv: '',
      ls: 'PROXY_MARKET', cs: 'ACTIVE', emp: '', ci: '', ctr: '', li: '', icp: '',
      cb: 'a', ca: null, ua: null,
    }];
    const res = await request(app).get('/api/admin/crm/export?object=companies');
    expect(res.status).toBe(200);
    expect(lastSql).toMatch(/LEFT JOIN LATERAL[\s\S]*opportunity/);
    expect(lastSql).toMatch(/istochnikSdelki/);
    expect(res.text).toContain('Proxy.Market');
    expect(res.text).not.toContain('PROXY_MARKET');
  });

  it('people: источник из сделки компании, без IMPORT', async () => {
    cannedRows = [{
      f: 'Иван', l: 'Иванов', co: 'Тест', em: '', ph: '', tg: '', jt: '', ci: '', li: '',
      src: 'RODION', cb: 'a', ca: null, ua: null,
    }];
    const res = await request(app).get('/api/admin/crm/export?object=people');
    expect(res.status).toBe(200);
    expect(lastSql).toMatch(/LEFT JOIN LATERAL[\s\S]*opportunity/);
    expect(lastSql).not.toMatch(/createdBySource/);
    expect(res.text).toContain('Родион');
    expect(res.text).not.toContain('IMPORT');
  });

  it('неизвестный ключ проходит как есть; пусто → пусто', async () => {
    cannedRows = [
      { nm: 'А', dom: '', inn: '', em: '', bs: '', pt: '', uc: '', pc: '', pv: '', ls: 'NEW_CHANNEL_X', cs: '', emp: '', ci: '', ctr: '', li: '', icp: '', cb: '', ca: null, ua: null },
      { nm: 'Б', dom: '', inn: '', em: '', bs: '', pt: '', uc: '', pc: '', pv: '', ls: '', cs: '', emp: '', ci: '', ctr: '', li: '', icp: '', cb: '', ca: null, ua: null },
    ];
    const res = await request(app).get('/api/admin/crm/export?object=companies');
    expect(res.status).toBe(200);
    expect(res.text).toContain('NEW_CHANNEL_X');
  });

  it('opportunities: свои поля, лейблы источников, Excel-формат (BOM+;)', async () => {
    cannedRows = [{
      nm: 'Сделка 1', co: 'ТестКо', rd: '2026-08-01T00:00:00Z', mrr: 500, wu: 'https://t.co', wl: 'сайт',
      wsl: '{https://a.ru,https://b.ru}', pt: 'MOBILE', pc: '{MD,RO}', npd: '2026-08-15T00:00:00Z',
      pcf: 'да', tg: '@x', cm: 'комм', st: 'MEETING', ls: 'COLD_OUTREACH', ist: 'RODION', ca: null,
    }];
    const res = await request(app).get('/api/admin/crm/export?object=opportunities');
    expect(res.status).toBe(200);
    expect(lastSql).toMatch(/FROM \S+\.opportunity/);
    expect(res.text.charCodeAt(0)).toBe(0xFEFF);            // BOM — Excel видит кириллицу
    const hdr = res.text.split('\r\n')[0];
    expect(hdr).toContain(';');                              // разделитель русской локали
    expect(hdr).toContain('Источник сделки');
    expect(res.text).toContain('Холодный аутрич');           // ls → лейбл
    expect(res.text).toContain('Родион');                    // ist → лейбл
    expect(res.text).toContain('https://a.ru, https://b.ru');// {a,b} → "a, b"
    expect(res.text).toContain('500');
  });
});
