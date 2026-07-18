// Characterization + regression tests for the public programmatic API
// (/api/v1/*) and the inbound api_access_log feature.
//
// In the test environment fetchAllServersDataCached returns an empty array
// (no API_*_URL set), so valid-key requests succeed with an empty proxy list —
// we assert status + shape + auth, not data values.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import crypto from 'crypto';
import { bootApp, asAdmin } from '../_helpers/app.js';

let app, db, adminToken, clientLogin, portName, apiKey;
const NAME = 'API Test Co ' + crypto.randomBytes(2).toString('hex');
const PASSWORD = 'apitest_' + crypto.randomBytes(4).toString('hex');
const BAD_KEY = 'prx_invalid_key_000000';

beforeAll(async () => {
  const ctx = bootApp();
  app = ctx.app;
  db = ctx.db;
  adminToken = asAdmin();
  clientLogin = 'apitest_' + crypto.randomBytes(3).toString('hex');
  portName = 'apitest_p_' + crypto.randomBytes(2).toString('hex');
  const create = await request(app).post('/api/admin/clients').set('X-Auth-Token', adminToken).send({
    name: NAME, login: clientLogin, password: PASSWORD,
    portName, billingType: 'per_gb', price: 10, currency: 'RUB',
  });
  if (create.status !== 200) throw new Error('seed failed: ' + create.status + ' ' + JSON.stringify(create.body));
  // Keys are hashed at rest (migration 043) — the DB column no longer holds a
  // usable key; the plaintext is returned once in the create response.
  apiKey = create.body && create.body.client && create.body.client.apiKey;
  if (!apiKey) throw new Error('seeded client has no api_key in create response');
});

afterAll(() => {
  try { db.prepare('DELETE FROM clients WHERE login = ?').run(clientLogin); } catch (_) { /* best-effort */ }
  try { db.prepare('DELETE FROM sessions WHERE login IN (?, ?)').run(clientLogin, 'test_admin'); } catch (_) { /* best-effort */ }
  try { db.prepare("DELETE FROM api_access_log WHERE path LIKE '/api/v1/%' OR client_name = ?").run(NAME); } catch (_) { /* best-effort */ }
  try { db.prepare('DELETE FROM api_usage WHERE client_name = ?').run(NAME); } catch (_) { /* best-effort */ }
});

describe('GET /api/v1/proxy', () => {
  it('401 without a key', async () => {
    const res = await request(app).get('/api/v1/proxy');
    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });
  it('401 with an invalid key', async () => {
    const res = await request(app).get('/api/v1/proxy').set('X-API-Key', BAD_KEY);
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/invalid/i);
  });
  it('200 + shape with a valid key (X-API-Key header)', async () => {
    const res = await request(app).get('/api/v1/proxy').set('X-API-Key', apiKey);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body).toHaveProperty('proxies');
    expect(res.body).toHaveProperty('proxy_count');
    expect(res.body).toHaveProperty('billing');
  });
  it('200 + Deprecation header when key passed via ?apiKey= query', async () => {
    const res = await request(app).get('/api/v1/proxy').query({ apiKey });
    expect(res.status).toBe(200);
    expect(res.headers.deprecation).toBe('true');
    // WP7.3: the query-fallback usage is recorded as key_via='query' so the
    // sunset decision is data-driven.
    const row = db.prepare("SELECT key_via FROM api_usage WHERE api_key_prefix = ? ORDER BY id DESC LIMIT 1").get(apiKey.slice(0, 8));
    expect(row).toBeTruthy();
    expect(row.key_via).toBe('query');
  });
  it('header-presented keys are recorded as key_via=header', async () => {
    await request(app).get('/api/v1/proxy').set('X-API-Key', apiKey);
    const row = db.prepare("SELECT key_via FROM api_usage WHERE api_key_prefix = ? ORDER BY id DESC LIMIT 1").get(apiKey.slice(0, 8));
    expect(row).toBeTruthy();
    expect(row.key_via).toBe('header');
  });
  it('404 for a non-GET method', async () => {
    const res = await request(app).post('/api/v1/proxy').set('X-API-Key', apiKey);
    expect(res.status).toBe(404);
  });
});

describe('GET /api/v1/proxies', () => {
  it('400 without a key', async () => {
    const res = await request(app).get('/api/v1/proxies');
    expect(res.status).toBe(400);
  });
  // Regression guard: this endpoint used to read req.query.apiKey ONLY and
  // returned 400 when the canonical X-API-Key header was supplied. It must now
  // accept the header (via _readApiKey) like /api/v1/proxy.
  it('401 (not 400) when an INVALID key is supplied via X-API-Key header', async () => {
    const res = await request(app).get('/api/v1/proxies').set('X-API-Key', BAD_KEY);
    expect(res.status).toBe(401);
  });
  it('200 with a VALID key via X-API-Key header', async () => {
    const res = await request(app).get('/api/v1/proxies').set('X-API-Key', apiKey);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('proxies');
    expect(res.body).toHaveProperty('count');
  });
  it('200 with a valid key via ?apiKey= query (backward compatible)', async () => {
    const res = await request(app).get('/api/v1/proxies').query({ apiKey });
    expect(res.status).toBe(200);
  });
  it('format=txt returns text/plain', async () => {
    const res = await request(app).get('/api/v1/proxies').query({ apiKey, format: 'txt' });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/plain/);
  });
  it('format=csv returns text/csv with a header row', async () => {
    const res = await request(app).get('/api/v1/proxies').query({ apiKey, format: 'csv' });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.text.split('\n')[0]).toMatch(/^ip,http_port/);
  });
});

describe('GET /api/admin/api_access_log', () => {
  it('401 without an admin token', async () => {
    const res = await request(app).get('/api/admin/api_access_log');
    expect(res.status).toBe(401);
  });
  it('200 + shape with an admin token', async () => {
    const res = await request(app).get('/api/admin/api_access_log').set('X-Auth-Token', adminToken).query({ hours: 1, limit: 5 });
    expect(res.status).toBe(200);
    for (const k of ['summary', 'by_type', 'by_purpose', 'top_clients', 'recent']) {
      expect(res.body).toHaveProperty(k);
    }
    expect(res.body.summary).toHaveProperty('total');
  });
  it('clamps an out-of-range hours param to 720', async () => {
    const res = await request(app).get('/api/admin/api_access_log').set('X-Auth-Token', adminToken).query({ hours: 99999, limit: 99999 });
    expect(res.status).toBe(200);
    expect(res.body.hours).toBe(720);
    expect(res.body.recent.length).toBeLessThanOrEqual(1000);
  });
});

describe('api_access_log middleware', () => {
  it('records a client-facing API request', async () => {
    await request(app).get('/api/v1/proxy').set('X-API-Key', BAD_KEY);
    await new Promise((r) => setTimeout(r, 50)); // let res.on('finish') flush
    const row = db.prepare(
      "SELECT * FROM api_access_log WHERE path = '/api/v1/proxy' AND caller_type = 'api_key' ORDER BY id DESC LIMIT 1"
    ).get();
    expect(row).toBeTruthy();
    expect(row.status).toBe(401);
    expect(row.purpose).toMatch(/прокси/i);
  });
  it('does NOT record admin self-traffic', async () => {
    await request(app).get('/api/admin/api_access_log').set('X-Auth-Token', adminToken);
    await new Promise((r) => setTimeout(r, 50));
    const cnt = db.prepare("SELECT COUNT(*) AS c FROM api_access_log WHERE path LIKE '/api/admin/%'").get().c;
    expect(cnt).toBe(0);
  });
});
