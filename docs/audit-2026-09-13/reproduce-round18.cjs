'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const Database = require('better-sqlite3');
const incidents = require('../../src/telegram/incidents');
const ping = require('../../src/jobs/modem-ping');
const db = new Database(':memory:');
const managers = [];
const emitted = [];
const warnings = [];
const logger = { warn(message) { warnings.push(message); } };
const getSetting = (key, def) => def;
function manager() {
  const m = incidents.create({ db, logger, getSetting, emit(rule, payload) { emitted.push({ rule, payload }); } });
  managers.push(m);
  return m;
}
function statuses(loss) {
  return [1, 2, 3].map(i => ({ modem_details: { IMEI: 'i' + i, NICK: 'M' + i },
    net_details: { IS_ONLINE: 'yes', CELLOP: 'test-operator', ping_stats: '100ms, ' + loss + '% loss' } }));
}
try {
  db.exec(fs.readFileSync(require.resolve('../../migrations/082_correlated_incidents.sql'), 'utf8'));
  db.exec(`CREATE TABLE modem_meta(server_name TEXT,imei TEXT,nick TEXT,operator TEXT,updated_at TEXT);
    CREATE TABLE known_modems(server_name TEXT,data TEXT);
    CREATE TABLE modem_ping(ts TEXT,server TEXT,nick TEXT,latency_ms REAL,loss_pct REAL,ok INTEGER);`);
  const before = manager();
  const oldPing = ping.create({ db, logger, getSetting, alerts: { trigger: (r, p) => before.handle(r, p) } });
  oldPing.ingest('S1', statuses(100), Date.now());
  oldPing.ingest('S1', statuses(100), Date.now());
  assert.equal(before._open.size, 1);
  assert.equal(emitted[0].rule, 'fleet_incident_opened');
  before.shutdown();
  // Process restart equivalent at factory boundary: persistent DB, new module instances/state.
  const after = manager();
  let recoveryCalls = 0;
  const newPing = ping.create({ db, logger, getSetting, alerts: { trigger(r, p) {
    if (r === 'modem_ping_recovered') recoveryCalls++;
    return after.handle(r, p);
  } } });
  for (let i = 0; i < 3; i++) newPing.ingest('S1', statuses(0), Date.now());
  assert.equal(recoveryCalls, 0);
  assert.equal(after._open.size, 1);
  assert.equal(db.prepare("SELECT state FROM monitoring_incidents").get().state, 'open');
  assert.equal(newPing.alive('S1', 'i1'), true);

  // Separate fault: even explicit recovery cannot persist closure when UPDATE fails.
  db.exec(`CREATE TRIGGER deny_close BEFORE UPDATE ON monitoring_incidents
    WHEN NEW.state='closed' BEGIN SELECT RAISE(ABORT,'injected close failure'); END;`);
  for (let i = 1; i <= 3; i++) after.handle('modem_ping_recovered', { server: 'S1', imei: 'i' + i, nick: 'M' + i });
  assert.equal(after._open.size, 0);
  assert.equal(emitted.at(-1).rule, 'fleet_incident_closed');
  assert.equal(db.prepare('SELECT state FROM monitoring_incidents').get().state, 'open');
  assert.ok(warnings.some(x => x.includes('injected close failure')));
  const resurrected = manager();
  assert.equal(resurrected._open.size, 1);
  // Alert gate rejects the first attempt (e.g. boot grace); continuous failure never retries.
  const rejectedRules = [];
  const gatedPing = ping.create({ db, logger, getSetting, alerts: { trigger(r) { rejectedRules.push(r); return false; } } });
  for (let i = 0; i < 10; i++) gatedPing.ingest('S2', statuses(100).slice(0, 1), Date.now());
  assert.equal(rejectedRules.filter(r => r === 'modem_ping_dead').length, 1);
  gatedPing.ingest('S2', statuses(0).slice(0, 1), Date.now());
  assert.equal(rejectedRules.filter(r => r === 'modem_ping_recovered').length, 1);
  console.log(JSON.stringify({ findings: ['DEEP-75', 'DEEP-76', 'DEEP-77'],
    isolation: 'actual incident and ping factories, SQLite in memory, injected SQLite trigger; no network',
    restart: { healthySamples: 9, recoveryCalls, incidentStillOpen: true },
    failedClose: { closedEventEmitted: true, removedFromMemory: true, durableState: 'open', restoredAsOpen: true },
    suppressedFailure: { badSamples: 10, openAttempts: 1, recoveryWithoutAcceptedOpen: true },
    limitation: 'factory reinitialization models restart; full server boot not executed' }, null, 2));
} finally { for (const m of managers) m.shutdown(); db.close(); }
