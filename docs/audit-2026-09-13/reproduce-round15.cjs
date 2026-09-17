'use strict';
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const uptime = require('../../src/uptime-period');
const db = new Database(':memory:');
try {
  db.exec(`CREATE TABLE modem_meta(id INTEGER PRIMARY KEY, server_name TEXT, imei TEXT, nick TEXT, operator TEXT, updated_at TEXT);
    CREATE TABLE uptime_daily(key TEXT,date TEXT,total INTEGER,online INTEGER);
    INSERT INTO modem_meta VALUES(1,'S1','imei1','old-nick','old-operator','2026-08-01');
    INSERT INTO uptime_daily VALUES('S1_imei1','2026-08-01',100,50);`);
  const before = uptime.modemRows(db, '2026-08-01', '2026-09-01');
  assert.equal(before[0].checks, 100);
  db.exec("UPDATE modem_meta SET nick='new-nick',operator='new-operator'");
  const renamed = uptime.modemRows(db, '2026-08-01', '2026-09-01');
  assert.equal(renamed[0].operator, 'new-operator');
  db.exec('DELETE FROM modem_meta');
  assert.equal(uptime.modemRows(db, '2026-08-01', '2026-09-01').length, 0);
  assert.equal(db.prepare('SELECT count(*) n FROM uptime_daily').get().n, 1);
  console.log(JSON.stringify({ finding: 'DEEP-68', isolation: 'real uptime query, SQLite in memory',
    historyChecksBefore: 100, historicalOperatorAfterMetadataUpdate: renamed[0].operator,
    historyRowsAfterMetadataDelete: 0, originalMeasurementsStillStored: true }, null, 2));
} finally { db.close(); }
