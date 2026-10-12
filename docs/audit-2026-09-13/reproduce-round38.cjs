'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const espree = require('espree');
const Database = require('better-sqlite3');
const trafficDb = require('../../src/db/traffic');
const hourly = require('../../src/traffic/hourly');
async function main() {
  // Reuse only the existing isolated schema fixture, not the test runner.
  const source = fs.readFileSync(require.resolve('../../tests/traffic-hourly-integrity.test.js'), 'utf8');
  const ast = espree.parse(source, { ecmaVersion: 'latest', sourceType: 'module', range: true });
  const factory = ast.body.find(n => n.type === 'FunctionDeclaration' && n.id.name === 'makeDb');
  assert.ok(factory);
  const makeDb = vm.runInNewContext('(' + source.slice(...factory.range) + ')', { Database });
  const db = makeDb();
  try {
    db.exec('CREATE TABLE kv_store(key TEXT,value TEXT)');
    trafficDb.init(db);
    let counter = 100;
    const errors = [];
    hourly.init({ db, logger: { info() {}, warn() {}, error: (...a) => errors.push(a.join(' ')) },
      fetchAllServersDataCached: async () => [{ serverName: 'S4', bw: {
        p1: { bandwidth_bytes_day_in: counter, bandwidth_bytes_month_in: counter },
        p2: { bandwidth_bytes_day_in: counter, bandwidth_bytes_month_in: counter }
      } }], refreshPortKeyMapping() {}, getPortKeyToPortName: () => ({}),
      _htUpsert: trafficDb.hourlyUpsertStmt(), _htCleanup() {}, _metaOpGet: { get: () => null },
      _snapUpsert: trafficDb.snapshotUpsertStmt(), _snapUpsertPreserve: trafficDb.snapshotUpsertPreserveStmt(),
      _snapGet: trafficDb.snapshotGetStmt(), _snapGetAll: trafficDb.snapshotGetAllStmt() });
    db.exec(`CREATE TRIGGER fail_second BEFORE INSERT ON hourly_snapshots WHEN NEW.port_id='S4_p2'
      BEGIN SELECT RAISE(ABORT,'injected second-port failure'); END;`);
    await hourly.refreshSnapshotsOnly();
    assert.equal(errors.length, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM hourly_snapshots').get().n, 0);
    assert.equal(hourly.getSnapshotCount(), 1);
    db.exec('DROP TRIGGER fail_second');
    counter = 200;
    await hourly.refreshSnapshotsOnly();
    const first = trafficDb.snapshotGetStmt().get('S4_p1');
    const second = trafficDb.snapshotGetStmt().get('S4_p2');
    assert.equal(first.day_in, 100);
    assert.equal(second.day_in, 200);
    console.log(JSON.stringify({ defect: 'DEEP-101', confirmed: true,
      afterRollback: { sqliteSnapshots: 0, cachedSnapshots: 1 },
      afterRetry: { currentCounter: 200, firstBaseline: first.day_in, secondBaseline: second.day_in },
      isolation: 'Actual refresh factory and SQLite transaction; synthetic feed; no network' }, null, 2));
  } finally { db.close(); }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
