'use strict';
// Current-defect probes. No network, production database or message delivery.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const espree = require('espree');
const Database = require('better-sqlite3');
const db = new Database(':memory:');
const source = fs.readFileSync(require.resolve('../../public/js/admin.js'), 'utf8');
const tree = espree.parse(source, { ecmaVersion: 'latest', range: true });
function fn(name) {
  const node = tree.body.find(n => n.type === 'FunctionDeclaration' && n.id.name === name);
  assert.ok(node, name);
  return source.slice(...node.range);
}
async function main() {
  db.exec(fs.readFileSync(require.resolve('../../migrations/032_notifications.sql'), 'utf8'));
  const router = require('../../src/routes/notifications')({ db,
    logger: { error(message) { throw new Error(message); } },
    authMiddleware(req, res, next) { next(); }, adminMiddleware(req, res, next) { next(); } });
  function call(path, query = {}, login = 'admin-a', method = 'get') {
    const layer = router.stack.find(x => x.route && x.route.path === path && x.route.methods[method]);
    assert.ok(layer, path);
    let result;
    layer.route.stack.at(-1).handle({ query, params: {}, user: { login } }, {
      json(value) { result = value; }, status(code) { throw new Error('Unexpected HTTP ' + code); }
    });
    return result;
  }
  const insert = db.prepare(`INSERT INTO notifications(dedup_key,rule_id,priority,title,message,created_at)
    VALUES(?, 'test', ?, 'test', 'test', datetime('now', ?))`);
  insert.run('old-critical', 'critical', '-1 hour');
  const read = db.prepare("INSERT INTO notification_read_state(notif_id,user_login,read_at) VALUES(?,'admin-a',datetime('now'))");
  for (let i = 0; i < 200; i++) read.run(insert.run('new-' + i, 'info', '-1 minute').lastInsertRowid);
  const badge = call('/api/admin/notifications/badge');
  assert.equal(badge.unread_critical, 1);
  assert.equal(call('/api/admin/notifications', { filter: 'critical', limit: 200 }).count, 0);
  assert.equal(call('/api/admin/notifications', { filter: 'unread', limit: 200 }).count, 0);
  // Control: per-user read markers correctly remain isolated.
  assert.equal(call('/api/admin/notifications/badge', {}, 'admin-b').unread, 201);

  const opened = [];
  const navigation = vm.createContext({ currentData: { _modemMap: {
    first: { nick: 'same-nick', server: 'S1' }, second: { nick: 'same-nick', server: 'S4' }
  } }, switchMainTab() {}, openDetailAtTab(...args) { opened.push(args); } });
  vm.runInContext(fn('_notifNavigate'), navigation);
  navigation._notifNavigate({ entity_kind: 'modem', entity_id: 'same-nick', payload: { server: 'S4', imei: 'imei-s4' } });
  assert.equal(opened[0][1], 'S1');

  const pending = [];
  const panel = vm.createContext({ API: '', window: { _notifFilter: 'all' },
    api(url) { return new Promise(resolve => pending.push({ url, resolve })); },
    renderNotifPanel() {}, refreshNotifBadge() {}, document: { getElementById() { return null; } } });
  vm.runInContext(fn('refreshNotifPanel'), panel);
  panel.refreshNotifPanel();
  panel.window._notifFilter = 'critical';
  panel.refreshNotifPanel();
  pending[1].resolve({ notifications: [{ id: 1, priority: 'critical' }] });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(panel.window._notifs[0].priority, 'critical');
  pending[0].resolve({ notifications: [{ id: 2, priority: 'info' }] });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(panel.window._notifFilter, 'critical');
  assert.equal(panel.window._notifs[0].priority, 'info');
  console.log(JSON.stringify({ findings: ['DEEP-70', 'DEEP-71', 'DEEP-72'],
    isolation: 'actual route callbacks with SQLite in memory; actual frontend functions in VM with controlled promises',
    unreadCriticalBadge: badge.unread_critical, criticalListCount: 0, unreadListCount: 0,
    otherAdminUnread: 201, notificationServer: 'S4', openedServer: opened[0][1],
    activeFilter: panel.window._notifFilter, staleResponsePriority: panel.window._notifs[0].priority }, null, 2));
}
main().catch(e => { console.error(e); process.exitCode = 1; }).finally(() => db.close());
