// Stage 18 characterization — injectOfflineModems() dual-source behavior.
//
// Contract:
//   - Modems in known_modems[srv] that aren't in live data → injected as offline.
//   - Modems in modem_meta (WHERE updated_at >= now() - N days) that are
//     missing from BOTH live data AND known_modems → also injected as offline,
//     under a synthetic port_id of the form `meta_<imei>`.
//   - A modem in both sources is injected only ONCE (no duplicates).
//   - A modem already online in live data is NOT injected (even if known_modems
//     or modem_meta also remember it).
//   - Old modem_meta rows (older than retention) are NOT injected.
//
// The whole point is: deleting known_modems by accident, or having it
// drift out of sync with the DB, no longer makes modems vanish from the
// admin UI. Pre-Stage-18 this was the WildBox-of-the-MD2_47 scenario.

import { describe, it, expect, beforeAll } from 'vitest';
import crypto from 'crypto';
import { createRequire } from 'module';
import { bootApp } from './_helpers/app.js';

const cjsRequire = createRequire(import.meta.url);

let app, db, injectOfflineModems, knownModems;

beforeAll(() => {
  const booted = bootApp();
  app = booted.app;
  db = booted.db;
  const srv = cjsRequire('../server.js');
  injectOfflineModems = srv.injectOfflineModems;
  knownModems = srv.knownModems;
  // appSettings has the retention key; default 60 days, fine for tests.
  // Reset known_modems to a clean slate so prior tests don't leak state.
  for (const k of Object.keys(knownModems)) delete knownModems[k];
});

function insertMeta({ server_name, nick, imei, operator = '', model = '', updated_at = null }) {
  // datetime('now') by default. updated_at lets us pin a row into the past
  // to test retention behavior.
  if (updated_at) {
    db.prepare(`INSERT OR REPLACE INTO modem_meta (server_name, imei, nick, operator, model, phone, updated_at)
                VALUES (?, ?, ?, ?, ?, '', ?)`)
      .run(server_name, imei, nick, operator, model, updated_at);
  } else {
    db.prepare(`INSERT OR REPLACE INTO modem_meta (server_name, imei, nick, operator, model, phone, updated_at)
                VALUES (?, ?, ?, ?, ?, '', datetime('now'))`)
      .run(server_name, imei, nick, operator, model);
  }
}

function imei() { return '99' + crypto.randomBytes(7).toString('hex'); }

describe('injectOfflineModems (Stage 18 dual source)', () => {
  it('injects modem from known_modems when missing from live (Pass 1)', () => {
    const im = imei();
    const srv = 'S1';
    knownModems[srv] = { 'port-A': { imei: im, nick: 'TEST_KM1', model: 'X', lastSeen: Date.now() } };
    const data = { serverName: srv, bw: {}, status: [], ports: {} };
    injectOfflineModems(data);
    expect(data.bw['port-A']).toBeDefined();
    expect(data.bw['port-A']._offline).toBe(true);
    const statusEntry = data.status.find(m => m.modem_details.IMEI === im);
    expect(statusEntry).toBeDefined();
    expect(statusEntry.modem_details.NICK).toBe('TEST_KM1');
    expect(statusEntry._offline).toBe(true);
  });

  it('Stage 18: injects modem from modem_meta when known_modems forgot it (Pass 2)', () => {
    const im = imei();
    const srv = 'S1';
    insertMeta({ server_name: srv, imei: im, nick: 'TEST_META1', operator: 'Orange MD' });
    // known_modems intentionally has NO entry for this IMEI — the whole
    // point of the regression is that the modem must still appear.
    knownModems[srv] = {};
    const data = { serverName: srv, bw: {}, status: [], ports: {} };
    injectOfflineModems(data);
    const statusEntry = data.status.find(m => m.modem_details.IMEI === im);
    expect(statusEntry).toBeDefined();
    expect(statusEntry.modem_details.NICK).toBe('TEST_META1');
    expect(statusEntry._offline).toBe(true);
    // Synthetic port_id format
    const bwKey = Object.keys(data.bw).find(k => k === 'meta_' + im);
    expect(bwKey).toBeDefined();
  });

  it('does NOT inject modem already online in live data (no duplicates)', () => {
    const im = imei();
    const srv = 'S1';
    insertMeta({ server_name: srv, imei: im, nick: 'TEST_LIVE', operator: 'Moldtelecom' });
    knownModems[srv] = { 'port-X': { imei: im, nick: 'TEST_LIVE', model: '', lastSeen: Date.now() } };
    // Modem IS live — already in status.
    const data = {
      serverName: srv,
      bw: { 'live-port': { portName: '', bandwidth_bytes_day_in: '1 MB' } },
      status: [{ modem_details: { IMEI: im, NICK: 'TEST_LIVE' }, net_details: { IS_ONLINE: 'yes' } }],
      ports: {}
    };
    injectOfflineModems(data);
    // Should still be exactly ONE entry for this IMEI — no offline placeholder added.
    const count = data.status.filter(m => m.modem_details.IMEI === im).length;
    expect(count).toBe(1);
    // The bw entries: 'live-port' from live, and 'port-X' from known_modems pass
    // (which DOES still get injected because IMEI-uniqueness in Pass 1 only
    // skips when seenImeis already has it — and we add it to seenImeis only
    // AFTER injecting). Actually the contract says: skip if IMEI is already
    // present in status. So Pass 1 should skip 'port-X' too.
    expect(data.bw['port-X']).toBeUndefined();
    // And Pass 2 (meta) should also skip it.
    expect(data.bw['meta_' + im]).toBeUndefined();
  });

  it('does NOT inject modem_meta rows older than retention (60d default)', () => {
    const im = imei();
    const srv = 'S1';
    // updated_at = 90 days ago (> default 60-day retention)
    insertMeta({
      server_name: srv, imei: im, nick: 'TEST_OLD',
      updated_at: new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 19).replace('T', ' ')
    });
    knownModems[srv] = {};
    const data = { serverName: srv, bw: {}, status: [], ports: {} };
    injectOfflineModems(data);
    const found = data.status.find(m => m.modem_details.IMEI === im);
    expect(found).toBeUndefined();
  });

  it('does not duplicate when modem is in BOTH known_modems and modem_meta', () => {
    const im = imei();
    const srv = 'S1';
    insertMeta({ server_name: srv, imei: im, nick: 'TEST_DUAL' });
    knownModems[srv] = { 'port-Y': { imei: im, nick: 'TEST_DUAL', model: '', lastSeen: Date.now() } };
    const data = { serverName: srv, bw: {}, status: [], ports: {} };
    injectOfflineModems(data);
    const count = data.status.filter(m => m.modem_details.IMEI === im).length;
    expect(count).toBe(1);
    // Pass 1 wins (uses real port_id, not synthetic), Pass 2 sees IMEI in
    // seenImeis and skips.
    expect(data.bw['port-Y']).toBeDefined();
    expect(data.bw['meta_' + im]).toBeUndefined();
  });
});
