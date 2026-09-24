'use strict';
//
// src/traffic/daily.js — recordDailyTraffic: ЕДИНЫЙ писатель в daily_traffic
// (WP3, канон docs/adr-traffic-sources.md).
//
// До WP3 четыре места писали напрямую `_dtUpsert` + вручную трогали кэш
// (billing, syncYesterdayTraffic, saveDailyTraffic, backfill-роут) — и клиент
// для строки вычислялся через ТЕКУЩИЙ маппинг портов, переписывая историю
// при переносе модема. Теперь: SQL (MAX-семантика байт + client_name,
// миграция 052) и in-memory кэш обновляются в одной точке здесь.
//
// Контракт:
//   recordDailyTraffic(portKey, date, bytesIn, bytesOut, clientName)
//   • portKey  — ключ вида 'S2_portXYZ' (= daily_traffic.port_name);
//   • date     — MSK-дата 'YYYY-MM-DD' (канон для всех серверов);
//   • байты    — неотрицательные числа; при гонке значение не уменьшается
//                (MAX на SQL и на кэше);
//   • clientName — атрибуция в момент записи; пустой НЕ затирает известного.
//
// 2026-09-24 · DEEP-65/66:
//   replaceDailyTraffic — ЯВНАЯ коррекция (backfill force): REPLACE вместо
//   MAX, иначе «force заменяет» обещало уменьшение, а значение оставалось
//   прежним (1000 vs пересчитанные 100). Коррекция денег не пересчитывает.
//   reloadCacheKeys — инвариант кэша после rollback внешней транзакции:
//   writer менял кэш внутри чужой tx; при откате память расходилась с БД.
//   Затронутые ключи перечитываются из durable-состояния.

let _upsert = null;
let _cache = null;
let _db = null;

function init({ dailyUpsertStmt, dailyTraffic, db }) {
  _upsert = dailyUpsertStmt;
  _cache = dailyTraffic || {};
  _db = db || null;
}

function _norm(bytesIn, bytesOut) {
  return [
    Number.isFinite(bytesIn) && bytesIn > 0 ? Math.round(bytesIn) : 0,
    Number.isFinite(bytesOut) && bytesOut > 0 ? Math.round(bytesOut) : 0,
  ];
}

function recordDailyTraffic(portKey, date, bytesIn, bytesOut, clientName) {
  if (!portKey || !date) return;
  const [bIn, bOut] = _norm(bytesIn, bytesOut);
  const client = String(clientName || '');
  _upsert.run(portKey, date, bIn, bOut, client);
  if (!_cache[portKey]) _cache[portKey] = {};
  const cur = _cache[portKey][date];
  _cache[portKey][date] = {
    in: Math.max(cur && typeof cur === 'object' ? (cur.in || 0) : 0, bIn),
    out: Math.max(cur && typeof cur === 'object' ? (cur.out || 0) : 0, bOut),
    portName: client || (cur && cur.portName) || '',
  };
}

// DEEP-65: явная коррекция — REPLACE (force-backfill). Возвращает фактическую
// запись; ответ API обязан отражать applied, а не только входные данные.
function replaceDailyTraffic(portKey, date, bytesIn, bytesOut, clientName) {
  if (!portKey || !date) return;
  if (!_db) throw new Error('replaceDailyTraffic: db not wired in init');
  const [bIn, bOut] = _norm(bytesIn, bytesOut);
  const client = String(clientName || '');
  _db.prepare(`INSERT INTO daily_traffic (port_name, date, bytes_in, bytes_out, client_name) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(port_name, date) DO UPDATE SET
    bytes_in = excluded.bytes_in,
    bytes_out = excluded.bytes_out,
    client_name = CASE WHEN excluded.client_name != '' THEN excluded.client_name ELSE client_name END`
  ).run(portKey, date, bIn, bOut, client);
  if (!_cache[portKey]) _cache[portKey] = {};
  const cur = _cache[portKey][date];
  _cache[portKey][date] = {
    in: bIn,
    out: bOut,
    portName: client || (cur && cur.portName) || '',
  };
}

// DEEP-66: после rollback внешней транзакции, писавшей через
// recordDailyTraffic/replaceDailyTraffic, перечитать затронутые ключи из БД —
// память обязана совпасть с durable-состоянием (никакого частичного результата).
function reloadCacheKeys(portKeys) {
  if (!_db) return;
  const sel = _db.prepare('SELECT date, bytes_in, bytes_out, client_name FROM daily_traffic WHERE port_name = ?');
  for (const key of portKeys || []) {
    delete _cache[key];
    for (const r of sel.all(key)) {
      if (!_cache[key]) _cache[key] = {};
      _cache[key][r.date] = { in: r.bytes_in || 0, out: r.bytes_out || 0, portName: r.client_name || '' };
    }
  }
}

module.exports = { init, recordDailyTraffic, replaceDailyTraffic, reloadCacheKeys };
