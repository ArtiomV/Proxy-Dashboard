import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { bootApp, asAdmin } from '../_helpers/app.js';

let app, db, token;

beforeAll(() => {
  const ctx = bootApp();
  app = ctx.app;
  db = ctx.db;
  token = asAdmin('sse_setting_admin');
});

afterAll(async () => {
  try {
    await request(app).put('/api/admin/settings').set('X-Auth-Token', token).send({ sse_enabled: true });
  } catch (_) { /* best-effort restore for the shared app harness */ }
});

describe('realtime setting persistence', () => {
  it('persists both toggle states and GET returns the stored value', async () => {
    const off = await request(app).put('/api/admin/settings')
      .set('X-Auth-Token', token).send({ sse_enabled: false });
    expect(off.status).toBe(200);
    expect(off.body.settings.sse_enabled).toBe(false);

    let stored = JSON.parse(db.prepare("SELECT value FROM kv_store WHERE key = 'app_settings'").get().value);
    expect(stored.sse_enabled).toBe(false);
    const readOff = await request(app).get('/api/admin/settings').set('X-Auth-Token', token);
    expect(readOff.body.sse_enabled).toBe(false);

    const on = await request(app).put('/api/admin/settings')
      .set('X-Auth-Token', token).send({ sse_enabled: true });
    expect(on.status).toBe(200);
    expect(on.body.settings.sse_enabled).toBe(true);
    stored = JSON.parse(db.prepare("SELECT value FROM kv_store WHERE key = 'app_settings'").get().value);
    expect(stored.sse_enabled).toBe(true);
  });
});
