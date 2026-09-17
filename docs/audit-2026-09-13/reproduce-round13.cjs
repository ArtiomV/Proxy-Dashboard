'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const ROOT = path.resolve(__dirname, '../..');
const noop = () => {};
const db = new Database(':memory:');
try {
  db.exec(fs.readFileSync(path.join(ROOT, 'schema.sql'), 'utf8'));
  db.exec("ALTER TABLE daily_traffic ADD COLUMN client_name TEXT DEFAULT ''");
  const repo = require('../../src/db/traffic'); repo.init(db);
  const cache = {};
  const writer = require('../../src/traffic/daily'); writer.init({ dailyUpsertStmt: repo.dailyUpsertStmt(), dailyTraffic: cache });
  db.exec("INSERT INTO traffic_hourly(server_name,port_id,client_name,hour_start,bytes_in) VALUES('S1','S1_p1','alice','2026-09-01 12:00',100)");
  writer.recordDailyTraffic('S1_p1', '2026-09-01', 1000, 0, 'alice');
  const middleware = (req, res, next) => next();
  const router = require('../../src/routes/traffic')({ db, logger: { info: noop, error: noop }, logActivity: noop,
    authMiddleware: middleware, adminMiddleware: middleware, getMoscowToday: () => '2026-09-14', recordDailyTraffic: writer.recordDailyTraffic });
  const h = router.stack.find(l => l.route.path === '/api/admin/backfill_daily_traffic').route.stack.at(-1).handle;
  const response = () => ({ status(n) { this.statusCode = n; return this; }, json(body) { this.body = body; } });
  const forced = response(); h({ body: { date: '2026-09-01', force: true } }, forced);
  const actual = db.prepare('SELECT bytes_in FROM daily_traffic').get().bytes_in;
  assert.equal(forced.body.total_bytes, 100); assert.equal(actual, 1000);
  db.exec("DELETE FROM daily_traffic; INSERT INTO traffic_hourly(server_name,port_id,client_name,hour_start,bytes_in) VALUES('S1','S1_p2','bob','2026-09-01 12:00',200); CREATE TRIGGER deny_second BEFORE INSERT ON daily_traffic WHEN NEW.port_name='S1_p2' BEGIN SELECT RAISE(ABORT,'injected second row failure'); END;");
  delete cache.S1_p1;
  const failed = response(); h({ body: { date: '2026-09-01', force: true } }, failed);
  assert.equal(failed.statusCode, 500);
  assert.equal(db.prepare('SELECT count(*) n FROM daily_traffic').get().n, 0);
  assert.equal(cache.S1_p1['2026-09-01'].in, 100);
  console.log(JSON.stringify({ isolation: 'real route, repositories, SQLite in memory', results: [
    { finding: 'DEEP-65', forceReportedBytes: 100, actualPersistedBytes: actual },
    { finding: 'DEEP-66', transactionRolledBack: true, sqliteRows: 0, memoryBytes: cache.S1_p1['2026-09-01'].in },
  ] }, null, 2));
} finally { db.close(); }
