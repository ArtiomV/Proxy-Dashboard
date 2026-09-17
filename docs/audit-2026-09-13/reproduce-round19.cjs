'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const Database = require('better-sqlite3');
const { create } = require('../../src/telegram/incidents');
const db = new Database(':memory:');
let manager;
try {
  db.exec(fs.readFileSync(require.resolve('../../migrations/082_correlated_incidents.sql'), 'utf8'));
  db.exec(`CREATE TABLE modem_meta(server_name TEXT,imei TEXT,nick TEXT,operator TEXT,updated_at TEXT);
    CREATE TABLE known_modems(server_name TEXT,data TEXT);
    INSERT INTO modem_meta VALUES('S1','exact-imei','reused-nick','correct-operator','2026-09-01');
    INSERT INTO modem_meta VALUES('S1','different-imei','reused-nick','wrong-operator','2026-09-02');`);
  const emitted = [];
  manager = create({ db, logger: { warn() {} }, getSetting: (key, def) => def,
    emit(rule, payload) { emitted.push({ rule, payload }); } });
  manager.handle('modem_ping_dead', { server: 'S1', imei: 'exact-imei', nick: 'reused-nick' });
  assert.equal(manager._pending.get('S1|exact-imei').member.operator, 'wrong-operator');
  manager.shutdown();

  const payload = (i, operator) => ({ server: 'S2', imei: 'i' + i, nick: 'M' + i, operator });
  for (const i of [1, 2, 3]) manager.handle('modem_ping_dead', payload(i, 'operator-A'));
  // One modem gets a different operator classification while the first episode remains open.
  for (const i of [1, 4, 5]) manager.handle('modem_ping_dead', payload(i, 'operator-B'));
  assert.equal(manager._open.size, 2);
  manager.handle('modem_ping_recovered', payload(1, 'operator-B'));
  const groupB = Array.from(manager._open.values()).find(x => x.operator === 'operator-B');
  assert.equal(groupB.members.get('S2|i1').active, true);
  for (const i of [2, 3, 4, 5]) manager.handle('modem_ping_recovered', payload(i, i < 4 ? 'operator-A' : 'operator-B'));
  assert.equal(manager._open.size, 1);
  assert.equal(db.prepare("SELECT operator FROM monitoring_incidents WHERE state='open'").get().operator, 'operator-B');
  assert.equal(groupB.members.get('S2|i1').active, true);
  console.log(JSON.stringify({ findings: ['DEEP-78', 'DEEP-79'],
    isolation: 'real incident manager and SQLite in memory; controlled payloads, no network',
    metadata: { exactImeiProvided: true, selectedOperator: 'wrong-operator' },
    regroup: { incidentsBeforeRecovery: 2, recoveredModems: 5, incidentsStillOpen: 1,
      stuckMember: 'S2|i1', stuckOperator: 'operator-B' },
    limitation: 'operator-change payload sequence supplied directly; upstream feed change not simulated' }, null, 2));
} finally { if (manager) manager.shutdown(); db.close(); }
