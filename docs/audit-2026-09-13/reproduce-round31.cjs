'use strict';
// Defect reproduction: a passing assertion means the defect is present.
// Execute extracted production functions with an in-memory SQLite database.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const espree = require('espree');
const Database = require('better-sqlite3');
const root = path.resolve(__dirname, '../..');
function extract(file, predicate) {
  const source = fs.readFileSync(path.join(root, file), 'utf8');
  const ast = espree.parse(source, { ecmaVersion: 'latest', sourceType: 'script', range: true });
  let found;
  function walk(node) {
    if (!node || typeof node !== 'object' || found) return;
    if (predicate(node)) { found = node; return; }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(walk);
      else if (value && typeof value === 'object') walk(value);
    }
  }
  walk(ast);
  assert.ok(found, `Source not found: ${file}`);
  return source.slice(...found.range);
}
const assignment = property => node => node.type === 'AssignmentExpression' &&
  node.left.type === 'MemberExpression' && node.left.object.name === 'S' &&
  node.left.property.name === property;
const record = extract('server.js', node => node.type === 'FunctionDeclaration' && node.id.name === 'recordIpChange');
const db = new Database(':memory:');
try {
  db.exec('CREATE TABLE ip_history(id INTEGER PRIMARY KEY, key TEXT, ip TEXT, started_at TEXT, ended_at TEXT)');
  db.exec(fs.readFileSync(path.join(root, 'migrations/109_ip_pairs.sql'), 'utf8'));
  const S = {}, ipHistory = {}, warnings = [];
  const context = vm.createContext({ db, S, ipHistory, MAX_IP_HISTORY: 100,
    logger: { warn: message => warnings.push(message) } });
  for (const name of ['ihInsert', 'ihUpdateEnd', 'ipPairUpsert', 'ihAllOrder']) {
    vm.runInContext(extract('src/db/tracking.js', assignment(name)), context);
  }
  for (const name of ['ipUnique', 'ipAssignments']) {
    vm.runInContext(extract('src/db/analytics.js', assignment(name)), context);
  }
  Object.assign(context, { _ihInsert: S.ihInsert, _ihUpdateEnd: S.ihUpdateEnd,
    trackingDb: { ipPairUpsertStmt: () => S.ipPairUpsert } });
  vm.runInContext(record, context);
  db.exec("CREATE TRIGGER fail_pairs BEFORE INSERT ON ip_pairs BEGIN SELECT RAISE(ABORT, 'injected write failure'); END");
  context.recordIpChange('S4_123', null, '192.0.2.1', '2026-10-11T09:00:00.000Z');
  const unique = S.ipUnique("'2026-10-11'", '').get().c;
  const assignments = S.ipAssignments("'2026-10-11'", '').get().c;
  assert.equal(unique, 0);
  assert.equal(assignments, 1);
  assert.equal(ipHistory.S4_123.length, 1);
  assert.equal(warnings.length, 1);
  db.exec('DROP TRIGGER fail_pairs');
  // A later, different IP succeeds but cannot repair the lost historical pair.
  context.recordIpChange('S4_123', '192.0.2.1', '192.0.2.2', '2026-10-11T10:00:00.000Z');
  assert.equal(S.ipUnique("'2026-10-11'", '').get().c, 1);
  assert.equal(S.ipAssignments("'2026-10-11'", '').get().c, 2);
  assert.equal(db.prepare('SELECT COUNT(DISTINCT ip) AS c FROM ip_history').get().c, 2);
  console.log(JSON.stringify({ defect: 'DEEP-93', confirmed: true,
    failedWrite: { unique, assignments }, afterNextChange: { unique: 1, assignments: 2 },
    isolation: 'Extracted production writer and queries; SQLite :memory:; no network' }, null, 2));

  db.exec('DELETE FROM ip_history; DELETE FROM ip_pairs');
  delete ipHistory.S4_123;
  context.recordIpChange('S4_123', null, '192.0.2.1', '2026-10-01T09:00:00.000Z');
  // Reproduce startup cache hydration: actual loader query with the seven-day
  // cutoff used by server.js. The persisted ip_tracking still has the old IP.
  delete ipHistory.S4_123;
  const loaded = S.ihAllOrder.all('2026-10-04T09:00:00.000Z');
  assert.equal(loaded.length, 0);
  context.recordIpChange('S4_123', '192.0.2.1', '192.0.2.2', '2026-10-11T09:00:00.000Z');
  const open = db.prepare("SELECT ip FROM ip_history WHERE ended_at = '' OR ended_at IS NULL ORDER BY id").all();
  assert.deepEqual(open.map(row => row.ip), ['192.0.2.1', '192.0.2.2']);
  console.log(JSON.stringify({ defect: 'DEEP-94', confirmed: true,
    startupRows: loaded.length, openAssignmentsAfterChange: open.length,
    isolation: 'Production writer and startup SQL; restart cache reset simulated' }, null, 2));
} finally { db.close(); }
