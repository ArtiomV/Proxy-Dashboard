// POST /api/public/lead — публичный приём заявок с лендинга.
//   • без авторизации, CORS '*', OPTIONS preflight
//   • валидация: без contact → 400
//   • honeypot website → молчаливый ok БЕЗ записи в leads
//   • валидная заявка → 200, строка в leads; Twenty в тесте недоступна →
//     crm_status='failed', но ответ всё равно ok (заявка не теряется)

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { bootApp } from '../_helpers/app.js';

let app, db;

beforeAll(() => {
  const ctx = bootApp();
  app = ctx.app;
  db = ctx.db;
});

afterAll(() => {
  try { db.prepare("DELETE FROM leads WHERE contact LIKE 'leadtest_%' OR contact = '+373 60 000-111'").run(); } catch (_) { /* best-effort */ }
});

describe('POST /api/public/lead', () => {
  it('без auth, CORS *, preflight OPTIONS → 204', async () => {
    const res = await request(app).options('/api/public/lead');
    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe('*');
  });

  it('без contact → 400', async () => {
    const res = await request(app).post('/api/public/lead').send({ text: 'hi' });
    expect(res.status).toBe(400);
  });

  it('honeypot website заполнен → ok:true, но БЕЗ записи в leads', async () => {
    const before = db.prepare("SELECT COUNT(*) c FROM leads WHERE contact LIKE 'leadtest_%'").get().c;
    const res = await request(app).post('/api/public/lead')
      .send({ contact: 'leadtest_bot', website: 'http://spam.example' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    const after = db.prepare("SELECT COUNT(*) c FROM leads WHERE contact LIKE 'leadtest_%'").get().c;
    expect(after).toBe(before);
  });

  it('валидная заявка → 200, строка в leads (телефон → contact_type=phone)', async () => {
    const res = await request(app).post('/api/public/lead').send({
      contact: '+373 60 000-111',
      text: 'Хочу мобильные прокси',
      product: 'mobile',
      offer: 'trial_24h',
      page: '/mobile/',
      ctaPosition: 'hero',
      utm: { utm_source: 'google', utm_campaign: 'md' },
    });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    const row = db.prepare("SELECT * FROM leads WHERE contact = '+373 60 000-111' ORDER BY id DESC LIMIT 1").get();
    expect(row).toBeTruthy();
    expect(row.contact_type).toBe('phone');
    expect(row.product).toBe('mobile');
    expect(JSON.parse(row.utm_json)).toMatchObject({ utm_source: 'google' });
    // Twenty в тестовом окружении недоступна → честный failed, заявка не потеряна.
    expect(['pending', 'failed']).toContain(row.crm_status);
  });

  it('telegram-контакт → contact_type=telegram', async () => {
    const res = await request(app).post('/api/public/lead').send({ contact: 'leadtest_@some_user' });
    expect(res.status).toBe(200);
    const row = db.prepare("SELECT * FROM leads WHERE contact = 'leadtest_@some_user' ORDER BY id DESC LIMIT 1").get();
    expect(row.contact_type).toBe('telegram');
  });
});
