// WP7.5: Anthropic/Tavily keys must be encrypted at rest in kv_store,
// masked in GET /api/admin/settings, and still decryptable by readers.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import crypto from 'crypto';
import { bootApp, asAdmin } from '../_helpers/app.js';

let app, db, adminToken;
const KEY = 'sk-ant-test-' + crypto.randomBytes(6).toString('hex');

beforeAll(() => {
  const ctx = bootApp();
  app = ctx.app;
  db = ctx.db;
  adminToken = asAdmin();
});

afterAll(() => {
  // Clean the secret out of the shared test settings blob.
  try {
    const row = db.prepare("SELECT value FROM kv_store WHERE key = 'app_settings'").get();
    if (row) {
      const s = JSON.parse(row.value);
      delete s.anthropic_api_key;
      db.prepare("UPDATE kv_store SET value = ? WHERE key = 'app_settings'").run(JSON.stringify(s));
    }
  } catch (_) { /* best-effort */ }
});

describe('WP7.5: sensitive settings encrypted at rest', () => {
  it('kv blob stores NO plaintext; GET masks the value; readers can decrypt (status=true)', async () => {
    const put = await request(app).put('/api/admin/settings')
      .set('X-Auth-Token', adminToken).send({ anthropic_api_key: KEY });
    expect(put.status).toBe(200);

    // At rest: ciphertext only.
    const row = db.prepare("SELECT value FROM kv_store WHERE key = 'app_settings'").get();
    expect(row).toBeTruthy();
    expect(row.value).not.toContain(KEY);
    expect(row.value).toContain('enc1:');

    // GET: masked, no plaintext anywhere in the response.
    const get = await request(app).get('/api/admin/settings').set('X-Auth-Token', adminToken);
    expect(get.body.anthropic_api_key).toBe('••••••••');
    expect(JSON.stringify(get.body)).not.toContain(KEY);

    // End-to-end decrypt: ai_sales status sees a configured key (getSetting
    // must return the real plaintext to backend readers).
    const st = await request(app).get('/api/admin/ai_sales/status').set('X-Auth-Token', adminToken);
    expect(st.status).toBe(200);
    expect(st.body.keys.anthropic).toBe(true);
  });

  it('PUT with the mask value does NOT clobber the real key', async () => {
    await request(app).put('/api/admin/settings')
      .set('X-Auth-Token', adminToken).send({ anthropic_api_key: KEY });
    const before = db.prepare("SELECT value FROM kv_store WHERE key = 'app_settings'").get().value;

    const put = await request(app).put('/api/admin/settings')
      .set('X-Auth-Token', adminToken).send({ anthropic_api_key: '••••••••' });
    expect(put.status).toBe(200);

    const after = db.prepare("SELECT value FROM kv_store WHERE key = 'app_settings'").get().value;
    expect(after).toBe(before);   // untouched — mask is not a value
    const st = await request(app).get('/api/admin/ai_sales/status').set('X-Auth-Token', adminToken);
    expect(st.body.keys.anthropic).toBe(true);   // still decrypts to the real key
  });
});
