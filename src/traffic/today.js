'use strict';
//
// src/traffic/today.js — корректное «сегодня» (MSK) поверх живых счётчиков
// ProxySmart.
//
// Зачем: бокс сбрасывает bandwidth_bytes_day_* в 00:00 UTC (03:00 MSK),
// а московские сутки начинаются в 00:00 MSK. С 00:00 до 03:00 MSK сырой
// day-счётчик ещё содержит ВЕСЬ вчерашний день, и любой вывод «сегодня»
// напрямую из него показывает вчерашний объём (инцидент 28.08.26:
// «Румыния 300 ГБ в час ночи» в «Потреблении по дням» и на карточках).
//
// Формула: today(port) = traffic_hourly за MSK-дату + live-дельта сверх
// снапшота day_at_last_hour_start_* (её почасово ведёт src/traffic/hourly.js).
// Дельта клампится в [0, 20 ГБ] и берётся только если снапшот обновлён
// после MSK-полуночи — иначе в неё попадёт вчерашний хвост.

// Как MAX_HOURLY_BYTES в src/traffic/hourly.js — sanity-cap на порт.
const MAX_LIVE_DELTA = 20 * 1e9;

function clampLiveDelta(v) {
  return (v > 0 && v < MAX_LIVE_DELTA) ? v : 0;
}

// MSK-полночь для даты 'YYYY-MM-DD' → ms (UTC-эпоха).
function mskMidnightMs(todayMsk) {
  return Date.parse(todayMsk + 'T00:00:00+03:00');
}

// Суммы traffic_hourly за MSK-календарную дату, по порту.
// hour_start хранится в UTC → +3 hours перед срезом даты.
function hourlyTodayByPort(db, todayMsk) {
  const map = new Map();
  try {
    const rows = db.prepare(`
      SELECT port_id, SUM(bytes_in) AS bin, SUM(bytes_out) AS bout
      FROM traffic_hourly
      WHERE substr(datetime(hour_start, '+3 hours'), 1, 10) = ?
      GROUP BY port_id
    `).all(todayMsk);
    for (const r of rows) map.set(r.port_id, { in: r.bin || 0, out: r.bout || 0 });
  } catch (_) { /* degrade: живём на live-дельтах */ }
  return map;
}

// Базовые линии счётчиков на начало последнего часа. Берём только снапшоты,
// обновлённые после MSK-полуночи: более старый baseline значит, что дельта
// захватит вчерашний трафик (сервер был офлайн за полночь) — её пропускаем,
// разнесением по часам займётся gap-fill агрегатора.
function snapshotBaselines(db, todayMsk) {
  const map = new Map();
  const midnight = mskMidnightMs(todayMsk);
  try {
    const rows = db.prepare(`
      SELECT port_id, day_at_last_hour_start_in AS din,
             day_at_last_hour_start_out AS dout, last_updated_at
      FROM hourly_snapshots
    `).all();
    for (const r of rows) {
      const lastMs = r.last_updated_at ? Date.parse(String(r.last_updated_at).replace(' ', 'T') + 'Z') : 0;
      if (!lastMs || lastMs < midnight) continue;
      map.set(r.port_id, { in: r.din || 0, out: r.dout || 0 });
    }
  } catch (_) { /* degrade: только hourly */ }
  return map;
}

// «Сегодня» для порта: почасовой учёт + докрутка текущего часа из live-счётчика.
// fullPortId — ключ вида 'S1_portXXX' (как в traffic_hourly/hourly_snapshots).
function todayBytes(hourlyMap, snapMap, fullPortId, dayIn, dayOut) {
  const h = hourlyMap.get(fullPortId);
  const s = snapMap.get(fullPortId);
  const liveIn  = s ? clampLiveDelta(dayIn  - s.in)  : 0;
  const liveOut = s ? clampLiveDelta(dayOut - s.out) : 0;
  return { in: (h ? h.in : 0) + liveIn, out: (h ? h.out : 0) + liveOut };
}

// На свежей установке (ни hourly, ни снапшотов) todayBytes всегда даст 0 —
// там разрешаем старое поведение: сырые day-счётчики как есть.
function hasOwnAccounting(hourlyMap, snapMap) {
  return hourlyMap.size > 0 || snapMap.size > 0;
}

module.exports = {
  MAX_LIVE_DELTA, clampLiveDelta, mskMidnightMs,
  hourlyTodayByPort, snapshotBaselines, todayBytes, hasOwnAccounting,
};
