// 2026-10-15: серверы тарифа выбираются из настроенных боксов и должны быть из
// страны тарифа (раньше строка вводилась руками: «S1, S3, S4, RO1» у тарифа MD).

import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'module';
import request from 'supertest';

const require = createRequire(import.meta.url);
const express = require('express');
const { z } = require('zod');
const createTariffsRouter = require('../src/routes/tariffs.js');

let store, app;
function mount() {
  store = [];
  const tariffsDb = {
    all: () => store, publicActive: () => store.filter(t => t.public && t.active),
    byId: (id) => store.find(t => t.id === Number(id)) || null,
    insert: (t) => { const row = { id: store.length + 1, type: 'per_modem', ...t }; store.push(row); return { lastInsertRowid: row.id }; },
    update: (id, t) => { Object.assign(store.find(x => x.id === Number(id)), t); },
    remove: () => {},
  };
  const a = express(); a.use(express.json());
  a.use(createTariffsRouter({
    logger: { info() {}, warn() {}, error() {} },
    authMiddleware: (req, res, next) => { req.user = { login: 'adm' }; next(); }, adminMiddleware: (req, res, next) => next(),
    validate: (schema) => (req, res, next) => { const r = schema.safeParse(req.body); if (!r.success) return res.status(400).json({ error: r.error.issues[0].message }); req.body = r.data; next(); },
    tariffsDb, auditLog() {}, getClientIp: () => '1.1.1.1', getSetting: () => true, db: { prepare: () => ({ get: () => ({ cnt: 0 }) }) },
    SERVER_COUNTRIES: { S1: { country: 'MD' }, S3: { country: 'MD' }, S4: { country: 'MD' }, 'RO1-MF289': { country: 'RO' } },
  }));
  return a;
}
beforeEach(() => { app = mount(); });

describe('тарифы: серверы из страны тарифа', () => {
  const base = { name: 'T', geo: 'MD', price: 4000 };
  it('серверы той же страны принимаются и нормализуются', async () => {
    const r = await request(app).post('/api/admin/tariffs').send({ ...base, server: 'S1,S3 ;S4' });
    expect(r.status).toBe(200);
    expect(r.body.tariff.server).toBe('S1, S3, S4');
  });
  it('румынский бокс у молдавского тарифа → 400 с понятным текстом', async () => {
    const r = await request(app).post('/api/admin/tariffs').send({ ...base, server: 'S1, RO1-MF289' });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/RO1-MF289.*страны RO.*MD/);
  });
  it('неизвестный сервер → 400; пустой список (пул розницы) разрешён', async () => {
    expect((await request(app).post('/api/admin/tariffs').send({ ...base, server: 'S9' })).status).toBe(400);
    expect((await request(app).post('/api/admin/tariffs').send({ ...base, server: '' })).status).toBe(200);
  });
  it('PUT только с ценой НЕ сбрасывает серверы, витрину и ступень (в zod 4 partial() подставлял defaults)', async () => {
    const c = await request(app).post('/api/admin/tariffs').send({ ...base, server: 'S1, S3', public: true, min_proxies: 30, sort: 7 });
    const r = await request(app).put('/api/admin/tariffs/' + c.body.tariff.id).send({ price: 4100 });
    expect(r.body.tariff).toMatchObject({ price: 4100, server: 'S1, S3', public: true, min_proxies: 30, sort: 7 });
  });
  it('PUT: смена гео при серверах другой страны отклоняется; правка цены старого тарифа проходит', async () => {
    const c = await request(app).post('/api/admin/tariffs').send({ ...base, server: 'S1' });
    const id = c.body.tariff.id;
    expect((await request(app).put('/api/admin/tariffs/' + id).send({ geo: 'RO' })).status).toBe(400);
    store[0].server = 'S1, RO1-MF289';      // «наследие»: тариф уже сохранён с кривым списком
    expect((await request(app).put('/api/admin/tariffs/' + id).send({ price: 4100 })).status).toBe(200);
  });
});
