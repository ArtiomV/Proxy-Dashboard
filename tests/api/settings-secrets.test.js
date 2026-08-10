// WP7.5: Anthropic key must be encrypted at rest in kv_store,
// masked in GET /api/admin/settings, and still decryptable by readers.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import crypto from 'crypto';
import os from 'os';
import fs from 'fs';
import { bootApp, asAdmin } from '../_helpers/app.js';

let app, db, adminToken;
const KEY = 'sk-ant-test-' + crypto.randomBytes(6).toString('hex');

// Decrypt an 'enc1:' payload the same way server.js does (AES-256-GCM,
// tochka-config-v1 key scheme). setup-env.js clears TOCHKA_CONFIG_KEY, so the
// env candidate is absent in tests; machine-id and legacy-hostname remain.
function decryptSettingVal(payload) {
  const wrap = JSON.parse(payload);
  const candidates = [];
  try {
    const id = fs.readFileSync('/etc/machine-id', 'utf8').trim();
    if (id) candidates.push(crypto.createHash('sha256').update('tochka-config-v1|machine-id|' + id).digest());
  } catch (_) { /* no machine-id on this host */ }
  candidates.push(crypto.createHash('sha256').update('tochka-config-v1|' + os.hostname() + '|' + process.platform).digest());
  for (const key of candidates) {
    try {
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(wrap.iv, 'base64'));
      decipher.setAuthTag(Buffer.from(wrap.tag, 'base64'));
      const dec = Buffer.concat([decipher.update(Buffer.from(wrap.ct, 'base64')), decipher.final()]);
      return JSON.parse(dec.toString('utf8')).v;
    } catch (_) { /* wrong candidate — try the next one */ }
  }
  throw new Error('no candidate key decrypted the payload');
}

function storedSecret() {
  const row = db.prepare("SELECT value FROM kv_store WHERE key = 'app_settings'").get();
  return JSON.parse(row.value).anthropic_api_key;
}

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
  it('kv blob stores NO plaintext; GET masks the value; readers can decrypt', async () => {
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

    // Decryptable: what getSetting() hands to backend readers is the real key.
    expect(decryptSettingVal(storedSecret().slice(5))).toBe(KEY);
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
    expect(decryptSettingVal(storedSecret().slice(5))).toBe(KEY);   // still the real key
  });
});
