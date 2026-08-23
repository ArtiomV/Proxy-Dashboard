'use strict';
// src/jobs/modem-rate.js — A3 (ТЗ мониторинга v2, 23.08): текущий трафик
// модема (Мбит/с сейчас), без новых запросов к боксам.
//
// Бокс отдаёт только форматированные суточные счётчики («2.5 GB») в
// /apix/bandwidth_report_all — точность строки 0.1 ГБ, поэтому дельта между
// соседними опросами (1–3 мин) грубая. Вместо этого держим кольцевой буфер
// снапшотов счётчиков на порт и считаем rate по СКОЛЬЗЯЩЕМУ ОКНУ
// (~10 мин): rate = (cum(now) − cum(now−window)) / Δt. Разрешение при
// окне 10 мин ≈ 1.4 Мбит/с — для «кто грузит сейчас» достаточно.
//
// Что делает джоба (вызывается из modem-tracking на каждом цикле):
//   1. мапит portId → imei/nick через data.ports + data.status (как
//      hourly-агрегация);
//   2. суммирует day_in/day_out по всем портам модема → кумулята модема;
//   3. rate модема = дельта кумуляты за окно; последние значения — в
//      latest() для UI (колонка «Сейчас», карточка, топ-5 на дашборде);
//   4. каждые 5 мин пишет снапшот в modem_rate (спарклайны, SLA).
//
// Полуночный reset счётчиков (бокс обнуляет day_* в 00:00 локали бокса)
// детектируется как cum < prev → снапшот-точка сбрасывается, окно
// пересобирается заново (отрицательных rate не бывает).

const { parseBwToBytes } = require('../utils/traffic');

const WINDOW_MS = 10 * 60 * 1000;     // скользящее окно rate
const SAMPLE_KEEP_MS = 15 * 60 * 1000; // сколько снапшотов держать (чуть больше окна)
const SNAPSHOT_MS = 5 * 60 * 1000;    // период записи в modem_rate

function create(deps) {
  const { db, logger } = deps;
  const _insert = db.prepare(
    'INSERT INTO modem_rate (ts, server, nick, rate_in_mbps, rate_out_mbps) VALUES (?,?,?,?,?)'
  );

  // key `${server}_${imei}` → { nick, samples: [{t, in, out}], last: {...}, lastSnapshotMs }
  const state = new Map();
  let lastSnapshotMs = 0;

  function _rate(st, nowMs) {
    const cur = st.samples[st.samples.length - 1];
    if (!cur) return null;
    // Ищем самый старый снапшот в окне (но не сам cur — нужна дельта).
    let base = null;
    for (let i = st.samples.length - 2; i >= 0; i--) {
      if (nowMs - st.samples[i].t > WINDOW_MS) break;
      base = st.samples[i];
    }
    if (!base || cur.t - base.t < 60000) return null;   // <1 мин базы — мусорная точность
    const dtSec = (cur.t - base.t) / 1000;
    return {
      in_mbps: Math.max(0, (cur.in - base.in) * 8 / 1e6 / dtSec),
      out_mbps: Math.max(0, (cur.out - base.out) * 8 / 1e6 / dtSec),
    };
  }

  // data — полный результат fetchServerData: { bw, status, ports }.
  function ingest(serverName, data, nowMs) {
    if (!data || typeof data.bw !== 'object' || !data.bw) return;
    const statusArr = Array.isArray(data.status) ? data.status : [];
    const portsMap = data.ports || {};

    // portId → { imei, nick } (та же механика, что в traffic/hourly.js)
    const portInfo = {};
    for (const m of statusArr) {
      const md = m.modem_details || {};
      const imei = md.IMEI || '';
      if (!imei) continue;
      const nick = md.NICK || imei;
      for (const p of (portsMap[imei] || [])) {
        if (p && p.portID) portInfo[p.portID] = { imei, nick };
      }
    }

    // Кумулята на модем = сумма суточных счётчиков его портов.
    const perModem = new Map();   // imei → { nick, in, out }
    for (const [portId, b] of Object.entries(data.bw)) {
      const info = portInfo[portId];
      if (!info) continue;
      const inB = parseBwToBytes(b.bandwidth_bytes_day_in) || 0;
      const outB = parseBwToBytes(b.bandwidth_bytes_day_out) || 0;
      const agg = perModem.get(info.imei) || { nick: info.nick, in: 0, out: 0 };
      agg.in += inB; agg.out += outB;
      perModem.set(info.imei, agg);
    }

    const tsIso = new Date(nowMs).toISOString();
    for (const [imei, agg] of perModem) {
      const key = serverName + '_' + imei;
      let st = state.get(key);
      if (!st) { st = { server: serverName, nick: agg.nick, samples: [], last: null }; state.set(key, st); }
      st.nick = agg.nick;
      const prev = st.samples[st.samples.length - 1];
      // Полуночный reset / пересоздание порта: счётчик упал — начинаем окно заново.
      if (prev && (agg.in < prev.in || agg.out < prev.out)) st.samples = [];
      st.samples.push({ t: nowMs, in: agg.in, out: agg.out });
      while (st.samples.length && nowMs - st.samples[0].t > SAMPLE_KEEP_MS) st.samples.shift();

      const r = _rate(st, nowMs);
      st.last = r ? {
        rate_in_mbps: Math.round(r.in_mbps * 100) / 100,
        rate_out_mbps: Math.round(r.out_mbps * 100) / 100,
        ts: tsIso,
      } : (st.last && nowMs - Date.parse(st.last.ts) < SAMPLE_KEEP_MS ? st.last : null);
    }

    // Снапшот в БД раз в 5 минут (все модемы разом).
    if (nowMs - lastSnapshotMs >= SNAPSHOT_MS) {
      lastSnapshotMs = nowMs;
      let written = 0;
      for (const st of state.values()) {
        if (!st.last) continue;
        try {
          _insert.run(tsIso, st.server, st.nick, st.last.rate_in_mbps, st.last.rate_out_mbps);
          written++;
        } catch (e) { logger.warn('[ModemRate] insert failed: ' + e.message); break; }
      }
      if (written) logger.info(`[ModemRate] snapshot: ${written} modems`);
    }
  }

  // Снимок для UI: { 'S1_MD2_39': { rate_in_mbps, rate_out_mbps, ts } }
  function latest() {
    const out = {};
    for (const st of state.values()) {
      if (st.last) out[st.server + '_' + st.nick] = st.last;
    }
    return out;
  }

  // Топ-N грузящих сейчас (для дашборда).
  function top(n) {
    return Object.entries(latest())
      .map(([k, v]) => ({ key: k, ...v, total: v.rate_in_mbps + v.rate_out_mbps }))
      .sort((a, b) => b.total - a.total)
      .slice(0, n || 5);
  }

  return { ingest, latest, top, _state: state };
}

module.exports = { create };
