'use strict';
const fs = require('node:fs');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const incidents = require('../../src/telegram/incidents');
const ping = require('../../src/jobs/modem-ping');
const db = new Database(':memory:');
let manager;
try {
  db.exec(fs.readFileSync(require.resolve('../../migrations/082_correlated_incidents.sql'), 'utf8'));
  db.exec(`CREATE TABLE modem_meta(server_name TEXT,imei TEXT,nick TEXT,operator TEXT,updated_at TEXT);
    CREATE TABLE known_modems(server_name TEXT,data TEXT);
    CREATE TABLE modem_ping(ts TEXT,server TEXT,nick TEXT,latency_ms REAL,loss_pct REAL,ok INTEGER);`);
  db.exec(fs.readFileSync(require.resolve('../../migrations/093_modem_ping_state.sql'), 'utf8'));
  const emitted = [], logger = { warn() {}, error() {} };
  const getSetting = (k, d) => k === 'alert_incident_grace_min' ? 0 : d;
  manager = incidents.create({ db, logger, getSetting, emit(rule, payload) { emitted.push({ rule, payload }); } });
  for (const i of [1, 2, 3]) manager.handle('modem_http_fail', { server: 'S1', imei: 'i' + i, nick: 'M' + i, operator: 'A' });
  assert.equal(manager._open.size, 1);
  const before = JSON.parse(db.prepare('SELECT members_json FROM monitoring_incidents').get().members_json);
  assert.ok(before.every(m => m.rules.includes('modem_http_fail')));
  const detector = ping.create({ db, logger, getSetting, alerts: {
    trigger: (r, p) => manager.handle(r, p), reconcileIncidents: entries => manager.reconcile(entries)
  } });
  detector.ingest('S1', [1, 2, 3].map(i => ({ modem_details: { IMEI: 'i' + i, NICK: 'M' + i },
    net_details: { IS_ONLINE: 'yes', CELLOP: 'A', ping_stats: '100ms, 0% loss' } })), Date.now());
  assert.equal(manager._open.size, 0);
  assert.equal(db.prepare('SELECT state FROM monitoring_incidents').get().state, 'closed');
  assert.equal(emitted.at(-1).rule, 'fleet_incident_closed');
  console.log(JSON.stringify({ finding: 'DEEP-85',
    isolation: 'actual ping ingest -> incident reconcile -> SQLite in memory; no network',
    initialSymptom: 'modem_http_fail', successfulHttpChecks: 0,
    successfulPingSamples: 3, finalIncidentState: 'closed', closeEventEmitted: true }, null, 2));
} finally { if (manager) manager.shutdown(); db.close(); }
