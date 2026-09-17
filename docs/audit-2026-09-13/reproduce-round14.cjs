'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Database = require('better-sqlite3');
const ROOT = path.resolve(__dirname, '../..');
const noop = () => {};
const logger = { info: noop, warn: noop, error: noop };
const flush = () => new Promise(resolve => setImmediate(resolve));
function scheduler(aggregate, db) {
  let seq = 0;
  const timers = new Map();
  const context = { module: { exports: {} }, setTimeout: (fn, ms) => { const id = ++seq; timers.set(id, { fn, ms }); return id; }, clearTimeout: id => timers.delete(id) };
  vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'src/jobs/hourly-agg-schedule.js'), 'utf8'), context);
  const job = context.module.exports.create({ logger, logActivity: noop, aggregateHourlyTraffic: aggregate,
    kvGet: db.prepare('SELECT value FROM kv_store WHERE key=?'),
    kvSet: db.prepare('INSERT OR REPLACE INTO kv_store(key,value) VALUES(?,?)'),
    trafficDb: { hourlyExistsForHourStmt: () => ({ get: () => ({ cnt: 0 }) }) },
  });
  return { job, timers, fire(id) { const t = timers.get(id); timers.delete(id); t.fn(); } };
}
async function main() {
  const db = new Database(':memory:');
  try {
    db.exec(fs.readFileSync(path.join(ROOT, 'schema.sql'), 'utf8'));
    let attempts = 0;
    const hourly = require('../../src/traffic/hourly');
    hourly.init({ db, logger, _snapGetAll: db.prepare('SELECT * FROM hourly_snapshots'),
      fetchAllServersDataCached: async () => { attempts++; throw new Error('injected feed failure'); } });
    const first = scheduler(hourly.aggregateHourlyTraffic, db);
    first.job.start(); first.fire([...first.timers.keys()][0]); await flush();
    assert.equal(attempts, 1);
    assert.ok(db.prepare("SELECT value FROM kv_store WHERE key='hourly_last_recorded'").get());
    assert.ok(![...first.timers.values()].some(t => t.ms === 60000));
    first.job.stop();
    db.exec("DELETE FROM kv_store WHERE key='hourly_last_recorded'");
    let retried = 0;
    const second = scheduler(async () => { retried++; if (retried === 1) throw new Error('retryable'); }, db);
    second.job.start(); second.fire([...second.timers.keys()][0]); await flush();
    const retry = [...second.timers].find(([id, timer]) => timer.ms === 60000);
    assert.ok(retry); second.job.stop();
    assert.ok(second.timers.has(retry[0])); second.fire(retry[0]); await flush();
    assert.equal(retried, 2);
    console.log(JSON.stringify({ isolation: 'real aggregator and scheduler, SQLite in memory, controlled timers', results: [
      { finding: 'DEEP-35', feedFailed: true, markedHourRecorded: true, retriesScheduled: 0 },
      { finding: 'DEEP-67', stopCalledBeforeRetry: true, attemptsAfterStop: retried - 1 },
    ] }, null, 2));
  } finally { db.close(); }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
