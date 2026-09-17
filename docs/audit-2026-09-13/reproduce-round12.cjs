'use strict';
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '../..');
const noop = () => {};
const middleware = (req, res, next) => next();
async function main() {
  const db = new Database(':memory:');
  try {
    db.exec(fs.readFileSync(path.join(ROOT, 'schema.sql'), 'utf8'));
    const date = days => new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
    const older = date(3), newer = date(2);
    const dailyTraffic = { S1_p1: { [older]: { in: 100, out: 0, portName: 'alice' }, [newer]: { in: 200, out: 0, portName: 'bob' } } };
    db.prepare('INSERT INTO traffic_hourly(server_name,port_id,nick,client_name,hour_start,bytes_in,bytes_out) VALUES(?,?,?,?,?,?,?)')
      .run('S1', 'S1_p1', 'M1', 'alice', older + ' 12:00', 100, 0);
    const router = require(path.join(ROOT, 'src/routes/traffic'))({
      db, logger: { warn: noop }, authMiddleware: middleware, adminMiddleware: middleware,
      dailyTraffic, portKeyToPortName: { S1_p1: 'bob' },
      clientByLogin: new Map([['alice', { id: 'a', portName: 'alice' }]]),
      parseBwToBytes: x => Number(x) || 0,
      fetchAllServersDataCached: async () => [{ serverName: 'S1', bw: { p1: { portName: 'bob' } } }],
    });
    const get = url => router.stack.find(l => l.route.path === url).route.stack.at(-1).handle;
    const response = () => ({ json(body) { this.body = body; } });
    const admin = response(); await get('/api/admin/daily_traffic')({ query: {} }, admin);
    assert.equal(admin.body.alice[older].in, 100);
    assert.equal(admin.body.bob[older].in, 100);
    const client = response();
    await get('/api/client/daily_traffic')({ user: { login: 'alice', portNameFilter: 'alice' }, query: {} }, client);
    assert.equal(client.body.daily.S1_p1[newer].portName, 'bob');
    console.log(JSON.stringify({ isolation: 'real route handlers and SQLite in memory, no network', results: [
      { finding: 'DEEP-63', actualOlderDayBytes: 100, adminAliceBytes: admin.body.alice[older].in, adminBobBytes: admin.body.bob[older].in },
      { finding: 'DEEP-64', authenticatedClient: 'alice', returnedLaterDayOwner: client.body.daily.S1_p1[newer].portName },
    ] }, null, 2));
  } finally { db.close(); }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
