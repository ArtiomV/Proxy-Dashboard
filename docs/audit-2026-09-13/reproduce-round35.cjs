'use strict';
// Reproduce the residual FIX-04 retention conflict on an isolated database.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const espree = require('espree');
const Database = require('better-sqlite3');
const { create, RETENTION_POLICIES } = require('../../src/jobs/cleanup');
async function main() {
  const db = new Database(':memory:');
  try {
    for (const [table, { col }] of Object.entries(RETENTION_POLICIES)) {
      assert.match(table, /^\w+$/); assert.match(col, /^\w+$/);
      db.exec(`CREATE TABLE ${table} (${col} TEXT)`);
    }
    db.exec(`CREATE TABLE daily_traffic(port_name TEXT, date TEXT, bytes_in REAL, bytes_out REAL, client_name TEXT);
      INSERT INTO daily_traffic VALUES('S4_p1', date('now','-120 days'), 1000, 0, 'client');
      INSERT INTO daily_traffic VALUES('S4_p1', date('now','-400 days'), 2000, 0, 'client');`);
    const dates = db.prepare('SELECT date,bytes_in FROM daily_traffic ORDER BY date DESC').all();
    const dailyTraffic = { S4_p1: Object.fromEntries(dates.map(r => [r.date, { in: r.bytes_in, out: 0 }])) };
    const warnings = [];
    const job = create({ db, appSettings: { retention_daily_traffic: 365 }, dailyTraffic,
      ipTracking: {}, uptimeTracking: {}, modemRotationCache: {}, SERVER_CACHE_FILE: '/virtual/no-cache',
      fs: { readFileSync() { throw new Error('No cache in fixture'); }, statSync() { throw new Error('No WAL in fixture'); } },
      logger: { info() {}, warn: m => warnings.push(m), error: m => { throw new Error(m); } }, logActivity() {} });
    const result = await job.runRetentionCleanup();
    assert.equal(result.daily_traffic.changes, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM daily_traffic').get().n, 1);
    assert.ok(dailyTraffic.S4_p1[dates[0].date]);
    // Execute the same prepared assignment invoked by server.js at startup.
    const source = fs.readFileSync(path.join(__dirname, '../../src/db/traffic.js'), 'utf8');
    const ast = espree.parse(source, { ecmaVersion: 'latest', range: true });
    let found;
    function walk(n) {
      if (!n || typeof n !== 'object' || found) return;
      if (n.type === 'AssignmentExpression' && n.left.type === 'MemberExpression' &&
          n.left.object.name === 'S' && n.left.property.name === 'dailyPurge90d') { found = n; return; }
      for (const v of Object.values(n)) {
        if (Array.isArray(v)) v.forEach(walk);
        else if (v && typeof v === 'object') walk(v);
      }
    }
    walk(ast); assert.ok(found);
    const S = {};
    vm.runInNewContext(source.slice(...found.range), { db, S });
    const startup = S.dailyPurge90d.run();
    assert.equal(startup.changes, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM daily_traffic').get().n, 0);
    console.log(JSON.stringify({ requirement: 'FIX-04 unified retention, residual startup purge',
      confirmed: true, retentionDays: 365, retainedAgeDays: 120,
      nightlyRowsRemaining: 1, startupRowsRemaining: 0,
      isolation: 'Actual cleanup factory and startup SQL; SQLite :memory:; no network or filesystem writes' }, null, 2));
  } finally { db.close(); }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
