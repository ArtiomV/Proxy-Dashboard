'use strict';
// Passing assertions reproduce defects, not successful acceptance.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const espree = require('espree');
const Database = require('better-sqlite3');
const root = path.resolve(__dirname, '../..');
function findSource(file, predicate) {
  const source = fs.readFileSync(path.join(root, file), 'utf8');
  const ast = espree.parse(source, { ecmaVersion: 'latest', range: true });
  let found;
  function walk(n) {
    if (!n || typeof n !== 'object' || found) return;
    if (predicate(n)) { found = n; return; }
    for (const v of Object.values(n)) {
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === 'object') walk(v);
    }
  }
  walk(ast);
  assert.ok(found, file);
  return { source, node: found };
}
const query = findSource('src/db/analytics.js', n => n.type === 'AssignmentExpression' &&
  n.left.type === 'MemberExpression' && n.left.object.name === 'S' && n.left.property.name === 'forecastDailyTraffic');
const route = findSource('src/routes/analytics.js', n => n.type === 'CallExpression' &&
  n.callee.type === 'MemberExpression' && n.callee.object.name === 'r' &&
  n.arguments[0]?.value === '/api/analytics/traffic_forecast');
const handler = route.node.arguments.at(-1);
const db = new Database(':memory:');
try {
  db.exec('CREATE TABLE daily_traffic(port_name TEXT, client_name TEXT, date TEXT, bytes_in REAL, bytes_out REAL)');
  const insert = db.prepare('INSERT INTO daily_traffic VALUES (?, ?, ?, ?, 0)');
  insert.run('S4_p1', 'volume', '2026-10-01', 100e9);
  for (let day = 14; day <= 19; day++) insert.run('S4_p1', 'volume', `2026-10-${day}`, 10e9);
  insert.run('S4_p2', 'lease', '2026-10-19', 1e9);
  const S = {};
  // Pin only SQL clock literal; retain the production filtering/grouping.
  const statement = query.source.slice(...query.node.range);
  assert.equal(statement.split("datetime('now',").length, 2);
  vm.runInNewContext(statement.replace("datetime('now',", "datetime('2026-10-20 09:00:00',"), { db, S });
  const clients = [
    { id: 1, name: 'Volume', portName: 'volume', billingType: 'per_gb', price: 10, balance: 2000 },
    { id: 2, name: 'Lease', portName: 'lease', billingType: 'per_modem', price: 3100, balance: 1000 }
  ];
  const run = vm.runInNewContext('(' + route.source.slice(...handler.range) + ')', {
    analyticsDb: { forecastDailyTraffic: days => S.forecastDailyTraffic.all(days) },
    clients, portKeyToPortName: {},
    getMoscowToday: () => '2026-10-20', getMoscowNow: () => new Date(2026, 9, 20, 12),
    logger: { error: (...args) => { throw new Error(args.join(' ')); } }
  });
  function response(days) {
    let output;
    run({ query: { days: String(days) } }, { json: x => { output = x; }, status: n => { throw new Error('HTTP ' + n); } });
    assert.ok(output);
    return output;
  }
  const short = response(7), long = response(30);
  const get = (r, id) => r.forecasts.find(c => c.client_id === id);
  const actualMonthGb = db.prepare("SELECT SUM(bytes_in + bytes_out) / 1e9 AS n FROM daily_traffic WHERE client_name = 'volume' AND date >= '2026-10-01'").get().n;
  assert.equal(actualMonthGb, 160);
  assert.equal(get(short, 1).month_gb_so_far, 60);
  assert.equal(get(long, 1).month_gb_so_far, 160);
  console.log(JSON.stringify({ defect: 'DEEP-95', confirmed: true, actualMonthGb,
    reportedMonthGb: { days7: get(short, 1).month_gb_so_far, days30: get(long, 1).month_gb_so_far } }, null, 2));
  // Ten billable modems: daily billing uses price * modemCount / daysInMonth.
  // The route has no count input at all. This compares formulas, not a billing-job execution.
  const billedModems = 10;
  const expectedRunway = Math.floor(1000 / (3100 * billedModems / 31));
  assert.equal(expectedRunway, 1);
  assert.equal(get(short, 2).runway_days, 10);
  assert.equal(get(short, 2).low_balance_alert, false);
  console.log(JSON.stringify({ defect: 'DEEP-96', confirmed: true, billedModems,
    expectedRunway, reportedRunway: get(short, 2).runway_days,
    lowBalanceAlert: get(short, 2).low_balance_alert,
    isolation: 'Actual route and clock-pinned SQL; SQLite :memory:; billing formula comparison only' }, null, 2));
} finally { db.close(); }
