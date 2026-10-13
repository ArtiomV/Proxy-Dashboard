'use strict';
// src/telegram/ai-context-worker.js — сбор контекста ИИ-анализа в отдельном
// потоке со своим read-only подключением к БД. Запросы контекста (пинги,
// HTTP-чеки, ротации за сутки и тренд за 7 дней — миллионы строк) на главном
// потоке останавливали дашборд на ~4 с при каждой утренней сводке.
const { parentPort, workerData } = require('worker_threads');
const Database = require('better-sqlite3');

const warns = [];
let db;
try {
  db = new Database(workerData.dbPath, { readonly: true, fileMustExist: true });
  require('../state').setKnownModems(workerData.knownModems || {});
  const ai = require('./ai_insights');
  const settings = workerData.settings || {};
  ai.init({
    db,
    logger: { info() {}, warn: (m) => warns.push(String(m)), error: (m) => warns.push(String(m)) },
    getSetting: (k, d) => (Object.prototype.hasOwnProperty.call(settings, k) ? settings[k] : d),
  });
  parentPort.postMessage({ ctx: ai.buildDayContext(workerData.date), warns });
} catch (e) {
  parentPort.postMessage({ error: e.message, warns });
} finally {
  try { if (db) db.close(); } catch (_) { /* best-effort */ }
}
