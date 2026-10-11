'use strict';
// Passing assertions confirm defects. No application/server startup.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const espree = require('espree');
const Database = require('better-sqlite3');
function extract(file, predicate) {
  const source = fs.readFileSync(path.join(__dirname, '../..', file), 'utf8');
  const ast = espree.parse(source, { ecmaVersion: 'latest', range: true });
  let match;
  function walk(node) {
    if (!node || typeof node !== 'object' || match) return;
    if (predicate(node)) { match = node; return; }
    for (const val of Object.values(node)) {
      if (Array.isArray(val)) val.forEach(walk);
      else if (val && typeof val === 'object') walk(val);
    }
  }
  walk(ast);
  assert.ok(match, file);
  return { source, match };
}
const route = extract('src/routes/analytics.js', n => n.type === 'CallExpression' &&
  n.callee.type === 'MemberExpression' && n.callee.object.name === 'r' &&
  n.arguments[0]?.value === '/api/analytics/monthly_traffic');
const query = extract('src/db/analytics.js', n => n.type === 'AssignmentExpression' &&
  n.left.type === 'MemberExpression' && n.left.object.name === 'S' && n.left.property.name === 'monthlyTraffic');
const handler = route.match.arguments.at(-1);
const db = new Database(':memory:');
const previousTZ = process.env.TZ;
const RealDate = Date;
class FixedDate extends RealDate {
  constructor(...args) { super(...(args.length ? args : ['2026-10-20T12:00:00.000Z'])); }
  static now() { return RealDate.parse('2026-10-20T12:00:00.000Z'); }
}
try {
  db.exec(`CREATE TABLE daily_traffic(port_name TEXT, date TEXT, bytes_in REAL, bytes_out REAL);
    INSERT INTO daily_traffic VALUES ('S4_p1','2026-09-30',100000000000,0);
    INSERT INTO daily_traffic VALUES ('S4_p1','2026-10-01',50000000000,0);
    INSERT INTO daily_traffic VALUES ('S4_p1','2026-10-20',10000000000,0);`);
  const S = {};
  vm.runInNewContext(query.source.slice(...query.match.range), { db, S });
  const routeFunction = vm.runInNewContext('(' + route.source.slice(...handler.range) + ')', {
    Date: FixedDate, analyticsDb: { monthlyTraffic: start => S.monthlyTraffic.all(start) },
    // Same current-day row loaded from SQLite at startup, as in server.js.
    dailyTraffic: { S4_p1: { '2026-10-20': { in: 10e9, out: 0 } } },
    logger: { error: (...args) => { throw new Error(args.join(' ')); } }
  });
  function run(tz) {
    process.env.TZ = tz;
    let output;
    routeFunction({ query: { months: '1' } }, {
      json: value => { output = value; }, status: n => { throw new Error('HTTP ' + n); }
    });
    assert.equal(output.length, 1);
    return output[0];
  }
  const utc = run('UTC');
  assert.equal(utc.month, '2026-10');
  assert.equal(utc.total_gb, 70); // actual October total = 50 + 10 = 60
  console.log(JSON.stringify({ defect: 'DEEP-99', confirmed: true,
    actualMonthGb: 60, reportedMonthGb: utc.total_gb, duplicatedTodayGb: 10 }, null, 2));
  const minsk = run('Europe/Minsk');
  assert.equal(minsk.label, 'Окт');
  assert.equal(minsk.month, '2026-09');
  assert.equal(minsk.total_gb, 100);
  assert.equal(minsk.is_current, true);
  console.log(JSON.stringify({ defect: 'DEEP-100', confirmed: true, tz: 'Europe/Minsk',
    response: minsk, expectedMonth: '2026-10',
    isolation: 'Extracted production handler and SQL, pinned Date, in-memory SQLite' }, null, 2));
} finally {
  db.close();
  if (previousTZ === undefined) delete process.env.TZ;
  else process.env.TZ = previousTZ;
}
