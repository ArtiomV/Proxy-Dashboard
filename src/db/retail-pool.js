'use strict';
// src/db/retail-pool.js — repository for the `retail_pool` table (WP4).
//
// Пул портов для автовыдачи рознице. Статусная машина:
//   free → reserved (TTL резерва 5 мин, на время провижининга в buy_proxy)
//        → leased (выдан клиенту)
//        → blocked (hold после grace; hold_until — дедлайн удаления)
// Удалённый порт = DELETE строки (факт — в audit_log).
// Вызовы бокса — ВНЕ транзакций; гонки закрыты UPDATE … WHERE status='free'
// (changes=0 → порт уже ушёл, берём следующий).

let S = {};

function init(db) {
  S.byId = db.prepare('SELECT * FROM retail_pool WHERE id = ?');
  S.byPort = db.prepare('SELECT * FROM retail_pool WHERE server = ? AND port_id = ?');
  S.byStatus = db.prepare('SELECT * FROM retail_pool WHERE status = ?');
  S.byClient = db.prepare("SELECT * FROM retail_pool WHERE client_id = ? AND status IN ('reserved','leased','blocked')");
  S.countByStatus = db.prepare('SELECT status, COUNT(*) AS cnt FROM retail_pool GROUP BY status');
  S.nextFree = db.prepare(
    "SELECT * FROM retail_pool WHERE status = 'free' AND server = ? ORDER BY id LIMIT 1"
  );
  // Атомарный захват: обновляет ТОЛЬКО free-порт. changes=0 → порт уже занят
  // конкурентом — caller берёт следующий (никаких SELECT-then-UPDATE гонок).
  S.reserve = db.prepare(
    "UPDATE retail_pool SET status='reserved', client_id=?, reserved_until=?, updated_at=datetime('now') " +
    "WHERE id = ? AND status = 'free'"
  );
  S.lease = db.prepare(
    "UPDATE retail_pool SET status='leased', reserved_until=NULL, updated_at=datetime('now') WHERE id = ?"
  );
  S.release = db.prepare(
    "UPDATE retail_pool SET status='free', client_id=NULL, reserved_until=NULL, hold_until=NULL, " +
    "last_client_id=COALESCE(client_id, last_client_id), updated_at=datetime('now') WHERE id = ?"
  );
  S.block = db.prepare(
    "UPDATE retail_pool SET status='blocked', hold_until=?, updated_at=datetime('now') WHERE id = ?"
  );
  S.rebind = db.prepare(
    "UPDATE retail_pool SET server=?, port_id=?, updated_at=datetime('now') WHERE id = ?"
  );
  S.insertFree = db.prepare(
    "INSERT OR IGNORE INTO retail_pool (server, port_id, status, updated_at) VALUES (?, ?, 'free', datetime('now'))"
  );
  S.remove = db.prepare('DELETE FROM retail_pool WHERE id = ?');
  S.expiredReservations = db.prepare(
    "SELECT * FROM retail_pool WHERE status='reserved' AND reserved_until < datetime('now')"
  );
  S.expiredHolds = db.prepare(
    "SELECT * FROM retail_pool WHERE status='blocked' AND hold_until IS NOT NULL AND hold_until < datetime('now')"
  );
}

function byId(id) { return S.byId.get(id); }
function byPort(server, portId) { return S.byPort.get(server, portId); }
function byStatus(status) { return S.byStatus.all(status); }
function byClient(clientId) { return S.byClient.all(clientId); }
function countByStatus() {
  const out = {};
  for (const r of S.countByStatus.all()) out[r.status] = r.cnt;
  return out;
}
function nextFree(server) { return S.nextFree.get(server); }
function reserve(id, clientId, reservedUntil) {
  return S.reserve.run(clientId, reservedUntil, id).changes === 1;
}
function lease(id) { return S.lease.run(id); }
function release(id) { return S.release.run(id); }
function block(id, holdUntil) { return S.block.run(holdUntil, id); }
function rebind(id, server, portId) { return S.rebind.run(server, portId, id); }
function insertFree(server, portId) { return S.insertFree.run(server, portId); }
function remove(id) { return S.remove.run(id); }
function expiredReservations() { return S.expiredReservations.all(); }
function expiredHolds() { return S.expiredHolds.all(); }

module.exports = {
  init, byId, byPort, byStatus, byClient, countByStatus, nextFree,
  reserve, lease, release, block, rebind, insertFree, remove,
  expiredReservations, expiredHolds,
};
