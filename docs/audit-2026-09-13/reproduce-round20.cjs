'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const Database = require('better-sqlite3');
const maintenance = require('../../src/maintenance');
const alerts = require('../../src/telegram/alerts');
const db = new Database(':memory:');
async function main() {
  db.exec(fs.readFileSync(require.resolve('../../migrations/032_notifications.sql'), 'utf8'));
  db.exec('CREATE TABLE server_downtime(id INTEGER PRIMARY KEY)');
  db.exec(fs.readFileSync(require.resolve('../../migrations/076_monitoring_v2_stage4.sql'), 'utf8'));
  const now = Date.now();
  const window = maintenance.createWindow(db, { target_type: 'modem', target_id: 'same-nick',
    from_ts: now - 60000, to_ts: now + 3600000 });
  assert.equal(maintenance.isInMaintenance(db, { server: 'S1', nick: 'same-nick' }, now).id, window.id);
  assert.equal(maintenance.isInMaintenance(db, { server: 'S4', nick: 'same-nick' }, now).id, window.id);
  maintenance.deleteWindow(db, window.id);
  maintenance.createWindow(db, { target_type: 'server', target_id: 'S1', from_ts: now - 60000, to_ts: now + 3600000 });
  const logger = { warn() {}, error(message) { throw new Error(message); }, info() {} };
  const getSetting = (key, def) => def;
  alerts.init({ db, logger, getSetting, appSettings: {}, kvGet: { get() {} }, kvSetCritical() {},
    tgBot: { sendMessage() { throw new Error('Unexpected send'); } } });
  const filename = require.resolve('../../src/jobs/notify-collect');
  const box = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module: box, exports: box.exports, require: createRequire(filename),
    setTimeout() { return 1; }, setInterval() { return 2; }, clearInterval() {}
  }, { filename });
  const collector = box.exports;
  collector.init({ db, logger, alerts, getSetting, clients: [], knownModems: {},
    uptimeTracking: { S1_i1: { last_online_check: new Date(now - 3600000).toISOString() } },
    trackingDb: { metaFleetRosterStmt: () => ({ all: () => [{ srv: 'S1', imei: 'i1', nick: 'M1' }] }) },
    fetchAllServersDataCached: async () => [], mergeServerData: () => ({ status: [] }) });
  assert.ok(maintenance.isInMaintenance(db, { server: 'S1', nick: 'M1' }, now));
  await collector.runOnce();
  const row = db.prepare('SELECT rule_id,payload_json FROM notifications').get();
  assert.equal(row.rule_id, 'modem_offline_20m');
  assert.equal(JSON.parse(row.payload_json).server, 'S1');
  console.log(JSON.stringify({ findings: ['DEEP-80', 'DEEP-81'],
    isolation: 'actual maintenance, collector, fleet and bell persistence; SQLite in memory, timers disabled, no network',
    sameNickWindowMatchesServers: ['S1', 'S4'], serverMaintenanceActive: true,
    offlineEventPersistedDuringMaintenance: true }, null, 2));
}
main().catch(e => { console.error(e); process.exitCode = 1; }).finally(() => { maintenance.invalidateMaintenanceCache(); db.close(); });
