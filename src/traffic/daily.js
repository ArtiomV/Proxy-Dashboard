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

let _upsert = null;
let _cache = null;

function init({ dailyUpsertStmt, dailyTraffic }) {
  _upsert = dailyUpsertStmt;
  _cache = dailyTraffic || {};
}

function recordDailyTraffic(portKey, date, bytesIn, bytesOut, clientName) {
  if (!portKey || !date) return;
  const bIn = Number.isFinite(bytesIn) && bytesIn > 0 ? Math.round(bytesIn) : 0;
  const bOut = Number.isFinite(bytesOut) && bytesOut > 0 ? Math.round(bytesOut) : 0;
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

module.exports = { init, recordDailyTraffic };
