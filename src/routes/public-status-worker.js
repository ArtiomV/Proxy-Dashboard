'use strict';
// src/routes/public-status-worker.js — один агрегатный проход по modem_ping в
// отдельном потоке (со своим read-only подключением): суточные итоги по каждому
// модему за период. Раньше история собиралась циклом из ~140 запросов
// (по запросу на модем) в основном потоке — до ~30 с работы на каждый рестарт.
const { parentPort, workerData } = require('worker_threads');
const Database = require('better-sqlite3');

let db;
try {
  db = new Database(workerData.dbPath, { readonly: true, fileMustExist: true });
  const rows = db.prepare(`
    SELECT server, nick, substr(ts, 1, 10) AS day, SUM(ok) AS ok, COUNT(ok) AS n, COUNT(*) AS checks
      FROM modem_ping
     WHERE ts >= ? AND ts < ?
     GROUP BY server, nick, day
  `).all(workerData.from, workerData.to);
  parentPort.postMessage({ rows });
} catch (e) {
  parentPort.postMessage({ error: e.message });
} finally {
  try { if (db) db.close(); } catch (_) { /* best-effort */ }
}
