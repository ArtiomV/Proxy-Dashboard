// WP4.2: the bell's offline set must equal the card's fleet.disconnectedList —
// blips <10 min stay out, glitched-to-random twins are credited OUT of alerts
// exactly like the card credits them.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const notifyCollect = require('../src/jobs/notify-collect.js');

const NOW = Date.now();
const iso = (msAgo) => new Date(NOW - msAgo).toISOString();
const mins = (m) => m * 60 * 1000;

let db, bells, job;
const silentLogger = { info() {}, warn() {}, error() {}, debug() {} };

beforeAll(() => {
  db = new Database(':memory:');
  db.exec('CREATE TABLE notifications (id INTEGER PRIMARY KEY, created_at TEXT)');
  bells = [];

  const uptime = {
    'S1_A': { last_online_check: iso(mins(30)) },    // dark 30 min → card + bell
    'S1_B': { last_online_check: iso(mins(3)) },     // blip 3 min → neither
    'S1_G': { last_online_check: iso(mins(450)) },   // dark 7.5h BUT glitched-to-random → neither
  };
  const live = [
    { _server: 'S1', modem_details: { IMEI: 'S1_A', NICK: 'MD_A', USB_ID: '1-1.1' }, net_details: { IS_ONLINE: 'no' } },
    { _server: 'S1', modem_details: { IMEI: 'S1_B', NICK: 'MD_B', USB_ID: '1-1.2' }, net_details: { IS_ONLINE: 'no' } },
    { _server: 'S1', modem_details: { IMEI: 'S1_G', NICK: 'MD_G', USB_ID: '' }, net_details: { IS_ONLINE: 'no' } },
    // the random re-enumeration that "covers" G (physically up)
    { _server: 'S1', modem_details: { IMEI: 'S1_1-4.3.1.1', NICK: 'random4311', USB_ID: '1-4.3.1.1' }, net_details: { IS_ONLINE: 'yes' } },
  ];

  job = notifyCollect.init({
    logger: silentLogger, db,
    alerts: {
      isRuleEnabled: (r) => r === 'modem_offline',
      recordBellEvent: (e) => bells.push(e),
      trigger: () => true,
    },
    uptimeTracking: uptime,
    knownModems: {}, clients: [],
    getStaleNicks: () => new Set(),
    getSetting: (k, d) => d,
    trackingDb: {
      metaFleetRoster: { all: () => [
        { srv: 'S1', imei: 'A', nick: 'MD_A' },
        { srv: 'S1', imei: 'B', nick: 'MD_B' },
        { srv: 'S1', imei: 'G', nick: 'MD_G' },
      ] },
    },
    fetchAllServersDataCached: async () => [],
    mergeServerData: () => ({ status: live }),
  });
});

afterAll(() => { if (job && job.stop) job.stop(); });

describe('notify-collect offline pass == fleet card (WP4.2)', () => {
  it('bells exactly the disconnected set: dark ≥10min yes, blip no, glitched-twin no', async () => {
    await notifyCollect.runOnce();
    const ids = bells.map(b => b.entity_id).sort();
    expect(ids).toEqual(['MD_A']);
    // sanity: the single event looks like the card entry
    expect(bells[0].rule_id).toBe('modem_offline');
    expect(bells[0].payload.server).toBe('S1');
    expect(bells[0].payload.mins).toBeGreaterThanOrEqual(29);
  });
});
