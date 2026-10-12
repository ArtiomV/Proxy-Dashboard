'use strict';
// Production write statement, isolated SQLite. Passing means defects exist.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const espree = require('espree');
const Database = require('better-sqlite3');
const source = fs.readFileSync(require.resolve('../../src/db/traffic'), 'utf8');
const ast = espree.parse(source, { ecmaVersion: 'latest', range: true });
let target;
function walk(n) {
  if (!n || typeof n !== 'object' || target) return;
  if (n.type === 'AssignmentExpression' && n.left.type === 'MemberExpression' &&
      n.left.object.name === 'S' && n.left.property.name === 'hourlyUpsert') { target = n; return; }
  for (const v of Object.values(n)) {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') walk(v);
  }
}
walk(ast); assert.ok(target);
const db = new Database(':memory:');
try {
  db.exec(`CREATE TABLE traffic_hourly(server_name TEXT,port_id TEXT,nick TEXT,operator TEXT,
    client_name TEXT,hour_start TEXT,bytes_in INTEGER,bytes_out INTEGER,uncertain INTEGER,
    raw_bytes_in INTEGER,raw_bytes_out INTEGER,UNIQUE(port_id,hour_start));`);
  const S = {};
  vm.runInNewContext(source.slice(...target.range), { db, S });
  const write = (client, bytes, raw = null) => S.hourlyUpsert.run(
    'S4', 'S4_p1', 'MD_01', 'Moldcell', client, '2026-10-12 09:00', bytes, 0,
    raw === null ? 0 : 3, raw, raw === null ? null : 0);
  write('A', 100);
  write('B', 200);
  let row = db.prepare('SELECT * FROM traffic_hourly').get();
  assert.equal(row.client_name, 'A');
  assert.equal(row.bytes_in, 300);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM traffic_hourly WHERE client_name='B'").get().n, 0);
  console.log(JSON.stringify({ requirement: 'DEEP-63/64 historical ownership, write-path evidence',
    confirmed: true, inputBytes: { A: 100, B: 200 }, persistedBytes: { A: 300, B: 0 } }, null, 2));

  db.exec('DELETE FROM traffic_hourly');
  write('A', 10, 100);
  write('A', 20, 200);
  row = db.prepare('SELECT * FROM traffic_hourly').get();
  assert.equal(row.bytes_in, 30);
  assert.equal(row.raw_bytes_in, 200);
  console.log(JSON.stringify({ requirement: 'DEEP-31 retained raw observations', confirmed: true,
    correctedSum: row.bytes_in, rawInputSum: 300, persistedRaw: row.raw_bytes_in,
    isolation: 'Actual SQL on SQLite :memory:; direct repository writes, not full aggregator' }, null, 2));
} finally { db.close(); }
