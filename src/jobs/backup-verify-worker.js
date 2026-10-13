'use strict';
// src/jobs/backup-verify-worker.js — проверка снимка БД в отдельном потоке.
// quick_check копии ~0,5 ГБ на главном потоке останавливал весь дашборд на
// ~12 с каждую ночь в 02:00 UTC (профиль 13.10). Результат — { ok, error }.
const { parentPort, workerData } = require('worker_threads');
const Database = require('better-sqlite3');

let bdb;
let result;
try {
  bdb = new Database(workerData.dest, { readonly: true });
  const qc = bdb.pragma('quick_check');
  const qcFirst = Array.isArray(qc) && qc[0] && Object.values(qc[0])[0];
  if (qcFirst !== 'ok') {
    result = { ok: false, error: 'backup verification: quick_check: ' + (qcFirst || 'no result') };
  } else {
    const row = bdb.prepare("SELECT count(*) c FROM sqlite_master WHERE name='clients'").get();
    result = (row && row.c) ? { ok: true } : { ok: false, error: 'backup verification: clients table missing' };
  }
} catch (e) {
  result = { ok: false, error: e.message };
} finally {
  try { if (bdb) bdb.close(); } catch (_) { /* best-effort */ }
}
parentPort.postMessage(result);
