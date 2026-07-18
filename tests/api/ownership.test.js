// WP2 regression tests for the unified ownership chain (src/modems/ownership.js).
//
// Prod bug being locked: a brand-new client with NO traffic history got 403 on
// their own reset-by-token link, because _resetIpImpl checked traffic_hourly
// ONLY. The unified chain is live binding → known_modems roster (24h) →
// traffic_hourly history.
//
// Test env has no live ProxySmart servers, so the live step never matches; we
// prove the roster and history steps (and the denial paths) end-to-end through
// the PUBLIC reset-by-token endpoint (the one that mattered).

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import crypto from 'crypto';
import { bootApp, asAdmin } from '../_helpers/app.js';
import { createRequire } from 'module';
const cjs = createRequire(import.meta.url);

let app, db, adminToken, resetToken, portName, clientLogin;
const ROSTER_NICK = 'OWN_roster_' + crypto.randomBytes(2).toString('hex');
const HISTORY_NICK = 'OWN_hist_' + crypto.randomBytes(2).toString('hex');
const OTHER_NICK = 'OWN_other_' + crypto.randomBytes(2).toString('hex');
let prevKnownModems;

beforeAll(async () => {
  const ctx = bootApp();
  app = ctx.app;
  db = ctx.db;
  adminToken = asAdmin();
  clientLogin = 'own_' + crypto.randomBytes(3).toString('hex');
  portName = 'own_p_' + crypto.randomBytes(2).toString('hex');
  const create = await request(app).post('/api/admin/clients').set('X-Auth-Token', adminToken).send({
    name: 'Ownership Test', login: clientLogin, password: 'pw_' + crypto.randomBytes(4).toString('hex'),
    portName, billingType: 'per_gb', price: 10, currency: 'RUB',
  });
  if (create.status !== 200) throw new Error('seed failed: ' + JSON.stringify(create.body));
  resetToken = db.prepare('SELECT reset_token FROM clients WHERE login = ?').get(clientLogin).reset_token;
  if (!resetToken) throw new Error('no reset_token on seeded client');

  // HISTORY_NICK attributed via traffic history only (no roster binding).
  db.prepare(`INSERT INTO traffic_hourly
      (server_name, port_id, nick, operator, client_name, hour_start, bytes_in, bytes_out, uncertain)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`)
    .run('TSTS', 'TSTS_p9', HISTORY_NICK, 'op', portName, '2026-06-01 00:00', 1000, 1000);

  // ROSTER_NICK bound via the known_modems roster only (no traffic history —
  // exactly the new-client case that 403'd before WP2).
  const { state, setKnownModems } = cjs('../../src/state/index.js');
  prevKnownModems = { ...state.knownModems };
  setKnownModems({
    ...prevKnownModems,
    TSTS: { TSTS_p1: { imei: 'OWNIMEI1', nick: ROSTER_NICK, portName, lastClientSeen: Date.now() } },
  });
});

afterAll(() => {
  try {
    const { setKnownModems } = cjs('../../src/state/index.js');
    setKnownModems(prevKnownModems || {});
  } catch (_) { /* best-effort */ }
  try { db.prepare('DELETE FROM traffic_hourly WHERE nick IN (?, ?)').run(HISTORY_NICK, OTHER_NICK); } catch (_) { /* best-effort */ }
  try { db.prepare('DELETE FROM clients WHERE login = ?').run(clientLogin); } catch (_) { /* best-effort */ }
});

describe('WP2: reset_ip_by_token — unified ownership chain', () => {
  it('new client with NO traffic history but roster-bound modem passes the gate (not 403)', async () => {
    // No live servers in test env → ownership passes, handler then 404s trying
    // to reach a server. What matters: NOT 403.
    const res = await request(app)
      .get('/api/client/reset_ip_by_token')
      .query({ nick: ROSTER_NICK, token: resetToken });
    expect(res.status).not.toBe(403);
    expect(res.status).not.toBe(401);
    expect(res.status).toBe(404); // 'Modem not found' — tried every (empty) server list
  });

  it('offline modem with traffic history only also passes (not 403)', async () => {
    const res = await request(app)
      .get('/api/client/reset_ip_by_token')
      .query({ nick: HISTORY_NICK, token: resetToken });
    expect(res.status).not.toBe(403);
    expect(res.status).toBe(404);
  });

  it('403 for a modem NOT assigned to the client', async () => {
    const res = await request(app)
      .get('/api/client/reset_ip_by_token')
      .query({ nick: OTHER_NICK, token: resetToken });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/not assigned/i);
  });

  it('401 for an invalid token', async () => {
    const res = await request(app)
      .get('/api/client/reset_ip_by_token')
      .query({ nick: ROSTER_NICK, token: 'deadbeef'.repeat(4) });
    expect(res.status).toBe(401);
  });
});
