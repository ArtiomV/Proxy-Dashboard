'use strict';
//
// src/maintenance.js — B3 (ТЗ мониторинга v2, этап 4, 23.08): окна
// обслуживания. Пока объект (сервер/модем) в активном окне:
//   - alerts.trigger() молчит по его алертам (проверка в alerts.js);
//   - эпизоды server_downtime пишутся с maintenance=1 (modem-tracking);
//   - SLA-отчёт (C1, src/sla.js) исключает maintenance-эпизоды.
//
// Чистые функции поверх db (better-sqlite3) — без init, состояние только
// в read-through кэше активных окон (перечитываем раз в 60 сек; CRUD
// инвалидирует через invalidateMaintenanceCache()).

const CACHE_MS = 60 * 1000;
const _cache = { ts: 0, rows: [] };

// Окна, которые ещё могут быть активны или наступят (с запасом сутки назад —
// завершившиеся недавно окна нужны списку в UI).
function _fetchRows(db) {
  return db.prepare(`
    SELECT id, target_type, target_id, from_ts, to_ts, comment, created_by, created_at
      FROM maintenance_windows
     WHERE to_ts >= ?
     ORDER BY from_ts ASC
  `).all(Date.now() - 86400000);
}

function _cached(db) {
  const now = Date.now();
  if (now - _cache.ts < CACHE_MS) return _cache.rows;
  try { _cache.rows = _fetchRows(db); }
  catch (_) { _cache.rows = []; }   // таблицы ещё нет (миграция не прошла) → окон нет
  _cache.ts = now;
  return _cache.rows;
}

function invalidateMaintenanceCache() { _cache.ts = 0; }

// Активное окно для объекта алерта. Совпадение: окно сервера по
// target.server, окно модема — по target.nick. Границы включительно.
// Возвращает строку окна или null.
function isInMaintenance(db, target, nowMs) {
  const now = nowMs || Date.now();
  const server = target && target.server;
  const nick = target && target.nick;
  if (!server && !nick) return null;
  for (const w of _cached(db)) {
    if (now < w.from_ts || now > w.to_ts) continue;
    if (w.target_type === 'server' && server && w.target_id === server) return w;
    if (w.target_type === 'modem' && nick && w.target_id === nick) return w;
  }
  return null;
}

// Список окон (свежих: to_ts за последние сутки и новее). {active:true} —
// только те, у которых to_ts ещё не прошёл (активные + будущие).
function listWindows(db, { active } = {}) {
  let rows;
  try { rows = _fetchRows(db); }
  catch (_) { rows = []; }
  if (active) {
    const now = Date.now();
    rows = rows.filter(w => w.to_ts >= now);
  }
  return rows;
}

function createWindow(db, { target_type, target_id, from_ts, to_ts, comment, created_by }) {
  if (target_type !== 'server' && target_type !== 'modem') {
    throw new Error('target_type: только server или modem');
  }
  const tid = String(target_id || '').trim();
  if (!tid || tid.length > 100) throw new Error('target_id: пустой или длиннее 100 символов');
  if (!Number.isFinite(from_ts) || !Number.isFinite(to_ts) || to_ts <= from_ts) {
    throw new Error('некорректный интервал (from_ts/to_ts)');
  }
  const info = db.prepare(`
    INSERT INTO maintenance_windows (target_type, target_id, from_ts, to_ts, comment, created_by)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(target_type, tid, Math.round(from_ts), Math.round(to_ts),
    String(comment || '').slice(0, 300), String(created_by || '').slice(0, 60));
  invalidateMaintenanceCache();
  return { id: info.lastInsertRowid };
}

function deleteWindow(db, id) {
  const info = db.prepare('DELETE FROM maintenance_windows WHERE id = ?').run(id);
  invalidateMaintenanceCache();
  return info.changes > 0;
}

module.exports = { isInMaintenance, listWindows, createWindow, deleteWindow, invalidateMaintenanceCache };
