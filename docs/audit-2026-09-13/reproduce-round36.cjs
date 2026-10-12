'use strict';
// Passing assertions confirm a residual DEEP-76 defect, not acceptance.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const Database = require('better-sqlite3');
const { create } = require('../../src/telegram/incidents');
const db = new Database(':memory:');
let manager;
try {
  db.exec(fs.readFileSync(require.resolve('../../migrations/082_correlated_incidents.sql'), 'utf8'));
  db.exec(`CREATE TABLE modem_meta(server_name TEXT,imei TEXT,nick TEXT,operator TEXT,updated_at TEXT);
    CREATE TABLE known_modems(server_name TEXT,data TEXT);`);
  const emitted = [], warnings = [];
  manager = create({ db, logger: { warn: m => warnings.push(m), error: m => warnings.push(m) },
    getSetting: (key, fallback) => key === 'alert_incident_grace_min' ? 0 : fallback,
    emit: (rule, payload) => emitted.push({ rule, payload }) });
  const observations = [1, 2, 3].map(n => ({ server: 'S4', nick: 'MD_' + n, imei: String(n), operator: 'Moldcell', online: true }));
  for (const p of observations) manager.handle('modem_ping_dead', p);
  assert.equal(manager._open.size, 1);
  db.exec(`CREATE TRIGGER fail_close BEFORE UPDATE ON monitoring_incidents
    WHEN NEW.state='closed' BEGIN SELECT RAISE(ABORT,'injected temporary write failure'); END;`);
  manager.reconcile(observations);
  assert.equal(manager._open.size, 1);
  assert.equal([...manager._open.values()][0].members.size, 3);
  assert.ok([...([...manager._open.values()][0].members.values())].every(m => !m.active));
  assert.equal(warnings.length, 1);
  db.exec('DROP TRIGGER fail_close');
  // Ten subsequent healthy cycles after SQLite is writable again.
  for (let i = 0; i < 10; i++) manager.reconcile(observations);
  assert.equal(manager._open.size, 1);
  assert.equal(db.prepare('SELECT state FROM monitoring_incidents').get().state, 'open');
  assert.equal(emitted.filter(e => e.rule === 'fleet_incident_closed').length, 0);
  assert.equal(warnings.length, 1);
  console.log(JSON.stringify({ defect: 'DEEP-76 residual reconcile retry', confirmed: true,
    healthyCyclesAfterRecovery: 10, memoryActiveMembers: 0, persistedState: 'open', closeEvents: 0,
    isolation: 'Actual incident manager, SQLite :memory:, local emit capture; no network' }, null, 2));

  manager.shutdown();
  db.exec(`DELETE FROM monitoring_incidents;
    CREATE TRIGGER fail_insert BEFORE INSERT ON monitoring_incidents
    BEGIN SELECT RAISE(ABORT,'injected insert failure'); END;`);
  const insertEvents = [], insertWarnings = [];
  manager = create({ db, logger: { warn: m => insertWarnings.push(m), error: m => insertWarnings.push(m) },
    getSetting: (key, fallback) => key === 'alert_incident_grace_min' ? 0 : fallback,
    emit: (rule, payload) => insertEvents.push({ rule, payload }) });
  for (const p of observations) manager.handle('modem_ping_dead', p);
  assert.equal(insertWarnings.length, 1);
  assert.equal(manager._open.size, 1);
  assert.equal(insertEvents.filter(e => e.rule === 'fleet_incident_opened').length, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM monitoring_incidents').get().n, 0);
  db.exec('DROP TRIGGER fail_insert');
  manager.reconcile(observations);
  assert.equal(manager._open.size, 0);
  assert.equal(insertEvents.filter(e => e.rule === 'fleet_incident_closed').length, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM monitoring_incidents').get().n, 0);
  console.log(JSON.stringify({ defect: 'DEEP-76 insert failure followed by zero-row update', confirmed: true,
    openedEvents: 1, closedEvents: 1, persistedIncidents: 0,
    isolation: 'Actual manager; injected INSERT failure; real SQLite zero-row UPDATE' }, null, 2));
} finally { if (manager) manager.shutdown(); db.close(); }
