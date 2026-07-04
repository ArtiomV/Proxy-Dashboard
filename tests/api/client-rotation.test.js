// Regression test for POST /api/client/set_rotation ownership.
//
// Bug: the ownership check compared a server-prefixed portID (minus a stale
// "S1_/S2_" prefix) against the modem nick — portID is not the nick, so every
// real modem was denied with "Modem not assigned to your account". The fix
// resolves ownership from the live assignment (nick -> modem -> port.portName)
// with a fallback to historical traffic attribution (traffic_hourly).
//
// In the test environment fetchAllServersDataCached returns [] (no live data),
// so these exercise the traffic_hourly fallback path.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import crypto from 'crypto';
import { bootApp, asAdmin } from '../_helpers/app.js';

let app, db, adminToken, clientToken, clientLogin, portName;
const OWNED_NICK = 'TST_owned_' + crypto.randomBytes(2).toString('hex');
const OTHER_NICK = 'TST_other_' + crypto.randomBytes(2).toString('hex');
const PASSWORD = 'rot_' + crypto.randomBytes(4).toString('hex');

beforeAll(async () => {
  const ctx = bootApp();
  app = ctx.app;
  db = ctx.db;
  adminToken = asAdmin();
  clientLogin = 'rot_' + crypto.randomBytes(3).toString('hex');
  portName = 'rot_p_' + crypto.randomBytes(2).toString('hex');
  const create = await request(app).post('/api/admin/clients').set('X-Auth-Token', adminToken).send({
    name: 'Rotation Test', login: clientLogin, password: PASSWORD, portName,
    billingType: 'per_gb', price: 10, currency: 'RUB',
  });
  if (create.status !== 200) throw new Error('seed failed: ' + create.status + ' ' + JSON.stringify(create.body));
  const login = await request(app).post('/api/login').send({ login: clientLogin, password: PASSWORD });
  if (login.status !== 200) throw new Error('client login failed: ' + login.status);
  clientToken = login.body.token;
  // Attribute OWNED_NICK to this client via a traffic_hourly row.
  db.prepare(`INSERT INTO traffic_hourly
      (server_name, port_id, nick, operator, client_name, hour_start, bytes_in, bytes_out, uncertain)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`)
    .run('TST', 'TST_p1', OWNED_NICK, 'op', portName, '2026-06-01 00:00', 1000, 1000);
});

afterAll(() => {
  try { db.prepare('DELETE FROM traffic_hourly WHERE nick IN (?, ?)').run(OWNED_NICK, OTHER_NICK); } catch (_) { /* best-effort */ }
  try { db.prepare('DELETE FROM clients WHERE login = ?').run(clientLogin); } catch (_) { /* best-effort */ }
  try { db.prepare('DELETE FROM sessions WHERE login = ?').run(clientLogin); } catch (_) { /* best-effort */ }
});

describe('POST /api/client/set_rotation — ownership', () => {
  it('passes the ownership gate for an OWNED modem (no 403)', async () => {
    // Bogus server so the handler stops at findServer() AFTER the ownership
    // check — proving the gate passed without mutating any real modem.
    const res = await request(app).post('/api/client/set_rotation').set('X-Auth-Token', clientToken)
      .send({ nick: OWNED_NICK, serverName: '__nope__', minutes: 30 });
    expect(res.status).not.toBe(403);
    expect(res.status).toBe(400); // 'Server not found'
  });

  it('403 for a modem NOT assigned to the client', async () => {
    const res = await request(app).post('/api/client/set_rotation').set('X-Auth-Token', clientToken)
      .send({ nick: OTHER_NICK, serverName: '__nope__', minutes: 30 });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/not assigned/i);
  });

  it('400 for out-of-range minutes (validated before ownership)', async () => {
    const res = await request(app).post('/api/client/set_rotation').set('X-Auth-Token', clientToken)
      .send({ nick: OWNED_NICK, serverName: 'MD2', minutes: 5000 });
    expect(res.status).toBe(400);
  });

  it('401 without a session', async () => {
    const res = await request(app).post('/api/client/set_rotation')
      .send({ nick: OWNED_NICK, serverName: '__nope__', minutes: 30 });
    expect(res.status).toBe(401);
  });
});
