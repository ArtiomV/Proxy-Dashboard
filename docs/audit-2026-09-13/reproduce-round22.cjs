'use strict';
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const Database = require('better-sqlite3');
const filename = require.resolve('../../src/telegram/incidents');
const fixtures = [];
function fixture() {
  const db = new Database(':memory:');
  db.exec(fs.readFileSync(require.resolve('../../migrations/082_correlated_incidents.sql'), 'utf8'));
  db.exec('CREATE TABLE modem_meta(server_name TEXT,imei TEXT,nick TEXT,operator TEXT,updated_at TEXT); CREATE TABLE known_modems(server_name TEXT,data TEXT);');
  const timers = new Set(), emitted = [], managers = [], box = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module: box, exports: box.exports, require: createRequire(filename),
    setTimeout(fn, delay) { const t = { fn, delay, unref() {} }; timers.add(t); return t; },
    clearTimeout(t) { timers.delete(t); } }, { filename });
  const make = () => {
    const m = box.exports.create({ db, logger: { warn() {}, error() {} }, getSetting: (k, d) => d,
      emit(rule, payload) { emitted.push({ rule, payload }); } });
    managers.push(m); return m;
  };
  const f = { db, timers, emitted, make, managers }; fixtures.push(f); return f;
}
const p = (i, operator = 'A') => ({ server: 'S1', imei: 'i' + i, nick: 'M' + i, operator, clients: ['c' + i] });
try {
  const restart = fixture();
  const first = restart.make();
  for (const i of [1, 2, 3]) first.handle('modem_ping_dead', p(i));
  assert.equal(restart.emitted.length, 0);
  assert.equal(restart.timers.size, 1);
  first.shutdown();
  const restored = restart.make();
  assert.equal(restart.timers.size, 0);
  assert.equal(Array.from(restored._open.values())[0].announced, true);
  for (const i of [1, 2, 3]) restored.handle('modem_ping_recovered', p(i));
  assert.equal(restart.emitted.length, 1);
  assert.equal(restart.emitted[0].rule, 'fleet_incident_closed');

  const moved = fixture(), mover = moved.make();
  for (const i of [1, 2, 3]) mover.handle('modem_ping_dead', p(i));
  for (const i of [1, 2, 3]) mover.handle('modem_ping_dead', p(i, 'B'));
  assert.equal(moved.emitted.length, 1);
  assert.equal(moved.emitted[0].rule, 'fleet_incident_closed');

  const growth = fixture(), growing = growth.make();
  for (const i of [1, 2, 3, 4]) growing.handle('modem_ping_dead', p(i));
  assert.equal(growth.timers.size, 1);
  // Execute only the pending announcement, no wall-clock delay and no real timer.
  const announcement = Array.from(growth.timers)[0];
  growth.timers.delete(announcement); announcement.fn();
  assert.equal(growth.emitted[0].payload.modems, 3);
  assert.equal(growth.emitted[0].payload.clients, 3);
  assert.equal(growth.emitted[0].payload.modem_list.split(', ').length, 4);
  assert.equal(growth.db.prepare('SELECT modem_count FROM monitoring_incidents').get().modem_count, 4);
  console.log(JSON.stringify({ findings: ['DEEP-83', 'DEEP-84'],
    isolation: 'actual incident module in VM, controlled timers, SQLite in memory, emit captured; no network',
    restart: { noOpeningEmitted: true, timerRestored: false, onlyEvent: restart.emitted[0].rule },
    regroupDuringGrace: { onlyEvent: moved.emitted[0].rule },
    delayedAnnouncement: { modems: 3, clients: 3, listedModems: 4, persistedModems: 4 },
    limitation: 'manager recreation models restart; full server boot and delivery not executed' }, null, 2));
} finally { for (const f of fixtures) { for (const m of f.managers) m.shutdown(); f.db.close(); } }
