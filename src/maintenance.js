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
// 2026-09-24 · DEEP-80: окно модема адресуется КЛЮЧОМ 'server|nick' (см.
// создание окна в routes/maintenance.js) — одноимённые модемы других
// серверов больше не попадают под чужое окно. Легаси-окна по голому nick
// НЕ совпадают (миграционная политика: подавление не расширяем молча —
// такое окно пересоздаётся с указанием сервера).
// Возвращает строку окна или null.
function isInMaintenance(db, target, nowMs) {
  const now = nowMs || Date.now();
  const server = target && target.server;
  const nick = target && target.nick;
  if (!server && !nick) return null;
  for (const w of _cached(db)) {
    if (now < w.from_ts || now > w.to_ts) continue;
    if (w.target_type === 'server' && server && w.target_id === server) return w;
    if (w.target_type === 'modem' && nick) {
      const key = String(w.target_id || '');
      const cut = key.indexOf('|');
      if (cut < 0) continue;                       // legacy bare nick — не совпадает (DEEP-80)
      if (server && key.slice(0, cut) === server && key.slice(cut + 1) === nick) return w;
    }
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

// 2026-09-24 · DEEP-69: пересечение фактического интервала простоя с окнами
// обслуживания. Раньше весь эпизод классифицировался по моменту
// ВОССТАНОВЛЕНИЯ (длинный аварийный простой, закончившийся в коротком окне,
// целиком уходил в maintenance и исключался из SLA — и наоборот).
// Возвращает объединение пересечений (без двойного счёта перекрывающихся
// окон) и id применённых окон (версия расчёта).
function overlapWithWindows(db, target, fromMs, toMs) {
  const server = target && target.server;
  const nick = target && target.nick;
  if ((!server && !nick) || !(toMs > fromMs)) return { coveredSec: 0, windowIds: [] };
  let rows;
  try {
    rows = db.prepare(`
      SELECT id, target_type, target_id, from_ts, to_ts
        FROM maintenance_windows
       WHERE to_ts >= ? AND from_ts <= ?
       ORDER BY from_ts ASC
    `).all(Math.round(fromMs), Math.round(toMs));
  } catch (_) { rows = []; }
  const segs = [];
  for (const w of rows) {
    const match = (server && w.target_type === 'server' && w.target_id === server)
               || (nick && w.target_type === 'modem' && w.target_id === nick);
    if (!match) continue;
    const a = Math.max(fromMs, w.from_ts), b = Math.min(toMs, w.to_ts);
    if (a < b) segs.push([a, b, w.id]);
  }
  segs.sort((x, y) => x[0] - y[0]);
  let covered = 0, end = -Infinity;
  const usedIds = new Set();
  for (const [a, b, id] of segs) {
    const s = Math.max(a, end);
    if (b > s) { covered += b - s; end = b; usedIds.add(id); }
  }
  return { coveredSec: Math.round(covered / 1000), windowIds: [...usedIds] };
}

module.exports = { isInMaintenance, listWindows, createWindow, deleteWindow, invalidateMaintenanceCache, overlapWithWindows };
