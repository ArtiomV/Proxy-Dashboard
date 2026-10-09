'use strict';
// Acceptance checks: PASS means correct behavior, unlike reproduce-round*.cjs.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const crypto = require('node:crypto');
const espree = require('espree');
const Database = require('better-sqlite3');
const source = fs.readFileSync(require.resolve('../../public/js/admin.js'), 'utf8');
const tree = espree.parse(source, { ecmaVersion: 'latest', range: true });
function fn(name) {
  const n = tree.body.find(n => n.type === 'FunctionDeclaration' && n.id.name === name);
  assert.ok(n, name); return source.slice(...n.range);
}
const checks = [];
async function check(name, f) {
  try { await f(); checks.push({ name, passed: true }); }
  catch (e) { checks.push({ name, passed: false, error: e.message }); }
}
async function main() {
  const db = new Database(':memory:');
  try {
    db.exec(fs.readFileSync(require.resolve('../../migrations/032_notifications.sql'), 'utf8'));
    const router = require('../../src/routes/notifications')({ db, logger: { error() {} },
      authMiddleware(req, res, next) { next(); }, adminMiddleware(req, res, next) { next(); } });
    function list(query) {
      const route = router.stack.find(x => x.route && x.route.path === '/api/admin/notifications').route;
      let out;
      route.stack.at(-1).handle({ query, user: { login: 'a' } }, {
        json(v) { out = v; }, status(code) { throw new Error('Unexpected HTTP ' + code); }
      });
      return out;
    }
    const put = db.prepare(`INSERT INTO notifications(dedup_key,rule_id,priority,title,message,created_at)
      VALUES(?,'test',?,'test','test',datetime('now',?))`);
    put.run('old', 'critical', '-1 hour');
    for (let i = 0; i < 200; i++) {
      const id = put.run('new-' + i, 'info', '-1 minute').lastInsertRowid;
      db.prepare("INSERT INTO notification_read_state(notif_id,user_login,read_at) VALUES(?,'a',datetime('now'))").run(id);
    }
    await check('DEEP-70: critical filtered before LIMIT', () => assert.equal(list({ filter: 'critical', limit: 200 }).count, 1));
    await check('DEEP-70: unread filtered before LIMIT', () => assert.equal(list({ filter: 'unread', limit: 200 }).count, 1));
    await check('DEEP-70: equal-timestamp cursor pages have no gaps or duplicates', () => {
      const ids = []; let cursor = {};
      for (let i = 0; i < 20; i++) {
        const page = list({ filter: 'all', limit: 17, ...cursor });
        ids.push(...page.notifications.map(n => n.id));
        if (!page.next_cursor) break;
        cursor = page.next_cursor;
      }
      assert.equal(ids.length, 201); assert.equal(new Set(ids).size, 201);
    });
  } finally { db.close(); }

  function navigate(map, payload) {
    const opened = [];
    const ctx = vm.createContext({ currentData: { _modemMap: map }, switchMainTab() {},
      openDetailAtTab(...args) { opened.push(args); } });
    vm.runInContext(fn('_notifNavigate'), ctx);
    ctx._notifNavigate({ entity_kind: 'modem', entity_id: 'same', payload });
    return opened;
  }
  await check('DEEP-71: same name on two servers opens requested server', () => {
    const out = navigate({ a: { server: 'S1', imei: 'a', nick: 'same' }, b: { server: 'S4', imei: 'b', nick: 'same' } }, { server: 'S4', imei: 'b' });
    assert.equal(out[0][1], 'S4');
  });
  await check('DEEP-71: missing target must not open same name on another server', () => {
    const out = navigate({ a: { server: 'S1', imei: 'a', nick: 'same' } }, { server: 'S4', imei: 'missing' });
    assert.equal(out.length, 0);
  });
  await check('DEEP-71: mismatched known IMEI must not fall back to another modem on same server', () => {
    const out = navigate({ b: { server: 'S4', imei: 'different', nick: 'same' } }, { server: 'S4', imei: 'missing' });
    assert.equal(out.length, 0);
  });
  await check('DEEP-72: stale success and stale error cannot replace current filter', async () => {
    const requests = [], list = { innerHTML: 'unchanged' };
    const ctx = vm.createContext({ API: '', _notifReqGen: 0, window: { _notifFilter: 'all' },
      api() { return new Promise((resolve, reject) => requests.push({ resolve, reject })); },
      renderNotifPanel() {}, refreshNotifBadge() {}, esc: s => s, document: { getElementById() { return list; } } });
    vm.runInContext(fn('refreshNotifPanel'), ctx);
    ctx.refreshNotifPanel(); ctx.refreshNotifPanel();
    ctx.window._notifFilter = 'critical'; ctx.refreshNotifPanel();
    requests[2].resolve({ notifications: [{ id: 1, priority: 'critical' }] });
    await new Promise(resolve => setImmediate(resolve));
    requests[0].resolve({ notifications: [{ id: 2, priority: 'info' }] });
    requests[1].reject(new Error('old failure'));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(ctx.window._notifs[0].priority, 'critical'); assert.equal(list.innerHTML, 'unchanged');
  });
  const files = ['src/routes/notifications.js', 'public/js/admin.js'];
  const report = { generatedAt: new Date().toISOString(), meaning: 'Acceptance checks: passed means expected correct behavior',
    scope: 'isolated actual handlers/SQLite and frontend functions/VM; no full DOM, network or auth middleware test',
    sourceHashes: Object.fromEntries(files.map(p => [p, crypto.createHash('sha256').update(fs.readFileSync(require.resolve('../../' + p))).digest('hex')])),
    total: checks.length, passed: checks.filter(c => c.passed).length, checks };
  fs.writeFileSync(__dirname + '/notification-verification.json', JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
  if (checks.some(c => !c.passed)) process.exitCode = 1;
}
main().catch(e => { console.error(e); process.exitCode = 1; });
