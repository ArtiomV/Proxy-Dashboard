'use strict';
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const httpCheck = require('../../src/jobs/http-check');
const db = new Database(':memory:');
async function main() {
  db.exec('CREATE TABLE modem_httpcheck(ts TEXT,server TEXT,nick TEXT,status INTEGER,total_ms REAL,content_ok INTEGER,error TEXT,port_id TEXT,route_reason TEXT)');
  const proxyCalls = [];
  const monitor = httpCheck.create({ db, logger: { info() {}, warn() {} }, alerts: { trigger() { throw new Error('Unexpected alert'); } },
    getSetting: (k, d) => d,
    apiServers: [{ name: 'S1', publicIp: '192.0.2.1' }],
    knownModems: { S1: { p1: { nick: 'M1', imei: 'clone' }, p2: { nick: 'M2', imei: 'clone' } } },
    fetchAllServersDataCached: async () => [{ serverName: 'S1',
      status: [1, 2].map(i => ({ modem_details: { IMEI: 'clone', NICK: 'M' + i }, net_details: { IS_ONLINE: 'yes' } })),
      ports: { clone: [
        { portID: 'p1', HTTP_PORT: 8001, LOGIN: 'first', PASSWORD: 'test', portName: 'client-A', IS_EXPIRED: true },
        { portID: 'p2', HTTP_PORT: 8002, LOGIN: 'second', PASSWORD: 'test', portName: 'client-B' }
      ] } }],
    fetchThroughProxy: async proxy => { proxyCalls.push(proxy.port); return { status: 200, body: 'ok', totalMs: 1 }; } });
  const result = await monitor.runOnce();
  const rows = db.prepare('SELECT nick,port_id,route_reason,error FROM modem_httpcheck ORDER BY nick').all();
  assert.equal(proxyCalls.length, 1);
  assert.equal(proxyCalls[0], 8002);
  assert.equal(rows[0].nick, 'M1');
  assert.equal(rows[0].port_id, 'p2');
  assert.equal(rows[0].error, '');
  assert.equal(rows[1].nick, 'M2');
  assert.equal(rows[1].error, 'ambiguous_clone_imei');
  console.log(JSON.stringify({ finding: 'DEEP-33 residual',
    isolation: 'actual HTTP monitor, SQLite in memory, injected successful proxy transport; no network',
    result, checkedHttpPort: proxyCalls[0], rows,
    meaning: 'expired M1 port falls back to valid M2 port; success belongs to M1 and actual M2 is skipped' }, null, 2));
}
main().catch(e => { console.error(e); process.exitCode = 1; }).finally(() => { httpCheck._clearRecentRotCache(); db.close(); });
