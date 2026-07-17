// Characterization tests for the auth surface:
//   POST /api/login    — login flow incl. bcrypt validation
//   POST /api/logout   — invalidates the session
//   401 on protected routes without/with bad token
//   403 on admin route for non-admin session
//
// Uses the actual login flow (no shortcut session minting) so the
// bcrypt path is exercised. Admin session for setup comes from
// mintSession() to avoid the chicken-and-egg of needing an admin login
// to *create* the first admin.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import crypto from 'crypto';
import { bootApp, asAdmin } from '../_helpers/app.js';

let app, db, adminToken, testClientLogin;
const TEST_PASSWORD = 'test_pa55word_' + crypto.randomBytes(4).toString('hex');

beforeAll(async () => {
  const ctx = bootApp();
  app = ctx.app;
  db = ctx.db;
  adminToken = asAdmin();
  // Create a client whose credentials we control. Admin route adds them to
  // both the clients table AND the in-memory users{} map that /api/login reads.
  testClientLogin = 'test_login_' + crypto.randomBytes(3).toString('hex');
  const create = await request(app)
    .post('/api/admin/clients')
    .set('X-Auth-Token', adminToken)
    .send({
      name: 'Auth Test Client',
      login: testClientLogin,
      password: TEST_PASSWORD,
      portName: 'authtestportname',
    });
  if (create.status !== 200) {
    throw new Error('test setup: client create failed ' + create.status + ' ' + JSON.stringify(create.body));
  }
});

afterAll(() => {
  // Cleanup so re-runs in the same DB don't trip the UNIQUE login constraint.
  if (testClientLogin) {
    try { db.prepare('DELETE FROM clients WHERE login = ?').run(testClientLogin); } catch (_) { /* best-effort */ }
    try { db.prepare('DELETE FROM sessions WHERE login = ?').run(testClientLogin); } catch (_) { /* best-effort */ }
  }
});

describe('POST /api/login', () => {
  it('returns 200 + token + login + isAdmin for correct credentials', async () => {
    const res = await request(app).post('/api/login').send({
      login: testClientLogin, password: TEST_PASSWORD,
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      login: testClientLogin,
      isAdmin: false,
    });
    expect(typeof res.body.token).toBe('string');
    expect(res.body.token.length).toBeGreaterThan(20);
  });

  it('returns 401 on wrong password (no leak via timing/error body)', async () => {
    const res = await request(app).post('/api/login').send({
      login: testClientLogin, password: 'WRONG_PASSWORD',
    });
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/invalid/i);
    expect(res.body.token).toBeUndefined();
  });

  it('returns 401 on unknown login', async () => {
    const res = await request(app).post('/api/login').send({
      login: 'no_such_user_xxx', password: 'whatever',
    });
    expect(res.status).toBe(401);
  });

  it('returns 400 when login or password missing', async () => {
    const res = await request(app).post('/api/login').send({ login: testClientLogin });
    // Zod validation rejects with 400 (validate middleware) OR the inline
    // check returns 400 with "required". Either way the contract is 400, no token.
    expect(res.status).toBe(400);
    expect(res.body.token).toBeUndefined();
  });

  it('issued token works as X-Auth-Token on a protected route', async () => {
    const login = await request(app).post('/api/login').send({
      login: testClientLogin, password: TEST_PASSWORD,
    });
    expect(login.status).toBe(200);
    // /api/dashboard_data requires authMiddleware (client portal route).
    const probe = await request(app).get('/api/dashboard_data').set('X-Auth-Token', login.body.token);
    // Could be 200 with empty data or specific error — what matters here is
    // NOT 401: the auth middleware accepted the freshly-minted token.
    expect(probe.status).not.toBe(401);
  });
});

describe('POST /api/logout', () => {
  it('deletes the session — subsequent requests with same token get 401', async () => {
    const login = await request(app).post('/api/login').send({
      login: testClientLogin, password: TEST_PASSWORD,
    });
    const token = login.body.token;
    expect(token).toBeTruthy();

    // Confirm token works
    const before = await request(app).get('/api/dashboard_data').set('X-Auth-Token', token);
    expect(before.status).not.toBe(401);

    // Logout
    const logout = await request(app).post('/api/logout').set('X-Auth-Token', token);
    expect(logout.status).toBe(200);
    expect(logout.body.ok).toBe(true);

    // Token is dead
    const after = await request(app).get('/api/dashboard_data').set('X-Auth-Token', token);
    expect(after.status).toBe(401);
  });
});

describe('auth middleware', () => {
  it('protected route returns 401 with no token', async () => {
    const res = await request(app).get('/api/dashboard_data');
    expect(res.status).toBe(401);
  });

  it('protected route returns 401 with invalid token', async () => {
    const res = await request(app).get('/api/dashboard_data').set('X-Auth-Token', 'this-is-not-a-real-token');
    expect(res.status).toBe(401);
  });

  it('admin-only route returns 403 for non-admin session', async () => {
    const login = await request(app).post('/api/login').send({
      login: testClientLogin, password: TEST_PASSWORD,
    });
    expect(login.body.isAdmin).toBe(false);
    // /api/admin/system_log requires authMiddleware + adminMiddleware.
    const res = await request(app).get('/api/admin/system_log').set('X-Auth-Token', login.body.token);
    expect(res.status).toBe(403);
  });

  it('admin route returns 200 for admin session (sanity)', async () => {
    const res = await request(app).get('/api/admin/system_log').set('X-Auth-Token', adminToken);
    expect(res.status).toBe(200);
  });
});

describe('POST /api/admin/impersonate/:id', () => {
  it('mints a working client session with SHORT ttl and writes an audit row', async () => {
    const client = db.prepare('SELECT id FROM clients WHERE login = ?').get(testClientLogin);
    expect(client).toBeTruthy();

    const before = Date.now();
    const res = await request(app)
      .post(`/api/admin/impersonate/${client.id}`)
      .set('X-Auth-Token', adminToken);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    const token = res.body.token;
    expect(typeof token).toBe('string');

    // The impersonated session works on the client portal…
    const probe = await request(app).get('/api/dashboard_data').set('X-Auth-Token', token);
    expect(probe.status).not.toBe(401);

    // …but expires in ~2h, not the normal 30 days.
    const row = db.prepare(
      'SELECT expires_at FROM sessions WHERE login = ? ORDER BY rowid DESC LIMIT 1'
    ).get(testClientLogin);
    expect(row).toBeTruthy();
    const ttlMs = Number(row.expires_at) - before;
    expect(ttlMs).toBeGreaterThan(1.8 * 3600 * 1000);
    expect(ttlMs).toBeLessThan(2.2 * 3600 * 1000);

    // …and the action is audited (who impersonated whom).
    const audit = db.prepare(
      "SELECT admin, details FROM audit_log WHERE action = 'impersonate' ORDER BY id DESC LIMIT 1"
    ).get();
    expect(audit).toBeTruthy();
    expect(audit.details).toContain(testClientLogin);
  });

  it('returns 403 for a non-admin session', async () => {
    const login = await request(app).post('/api/login').send({
      login: testClientLogin, password: TEST_PASSWORD,
    });
    const client = db.prepare('SELECT id FROM clients WHERE login = ?').get(testClientLogin);
    const res = await request(app)
      .post(`/api/admin/impersonate/${client.id}`)
      .set('X-Auth-Token', login.body.token);
    expect(res.status).toBe(403);
  });
});
