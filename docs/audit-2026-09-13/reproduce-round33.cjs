'use strict';
// Passing assertions confirm defects in live preview, not in billing.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const { computeLiveCells } = require('../../src/routes/analytics');
const db = new Database(':memory:');
try {
  db.exec(fs.readFileSync(path.join(__dirname, '../../migrations/106_live_hour_baseline.sql'), 'utf8'));
  const get = db.prepare('SELECT hour_key, bytes FROM live_hour_baseline WHERE port_id = ?');
  const upsert = db.prepare(`INSERT INTO live_hour_baseline(port_id,hour_key,bytes) VALUES(?,?,?)
    ON CONFLICT(port_id) DO UPDATE SET hour_key=excluded.hour_key,bytes=excluded.bytes`);
  const hk = '2026-10-11 12';
  function sample(gb, client = 'A') {
    return computeLiveCells([{
      serverName: 'S4', status: [{ modem_details: { IMEI: '123', NICK: 'MD_01' }, net_details: { CELLOP: 'moldcell' } }],
      ports: { '123': [{ portID: 'p1', portName: client }] },
      bw: { p1: { bandwidth_bytes_day_in: gb * 1e9, bandwidth_bytes_day_out: 0 } }
    }], hk, get, upsert, {}, {}, x => x);
  }
  assert.deepEqual(sample(100), []);
  const beforeTransfer = sample(120);
  assert.equal(beforeTransfer[0].client, 'A');
  assert.equal(beforeTransfer[0].bytes, 20e9);
  // Transfer ownership with no intervening byte growth: all 20 GB belonged to A.
  const afterTransfer = sample(120, 'B');
  assert.equal(afterTransfer[0].client, 'B');
  assert.equal(afterTransfer[0].bytes, 20e9);
  console.log(JSON.stringify({ defect: 'DEEP-97', confirmed: true,
    beforeTransfer, afterTransfer, bytesSinceTransfer: 0 }, null, 2));

  db.exec('DELETE FROM live_hour_baseline');
  sample(100);
  assert.equal(sample(120)[0].bytes, 20e9);
  assert.deepEqual(sample(0), []);
  assert.deepEqual(sample(5), []);
  assert.deepEqual(sample(10), []);
  assert.equal(get.get('S4_p1').bytes, 100e9);
  console.log(JSON.stringify({ defect: 'DEEP-98', confirmed: true,
    observedGbBeforeReset: 20, observedGbAfterReset: 10,
    returnedCellsAfterReset: [], unchangedBaselineGb: 100,
    isolation: 'Production computeLiveCells; SQLite :memory:; synthetic feeds; no network' }, null, 2));
} finally { db.close(); }
