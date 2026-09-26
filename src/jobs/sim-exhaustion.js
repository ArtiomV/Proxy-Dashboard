'use strict';
//
// src/jobs/sim-exhaustion.js — 2026-09-26: детектор «у симки кончился трафик»
// по СИМПТОМАМ (а не по счётчику — квота оператора нам неизвестна).
//
// Сигнатура (подтверждена на живых Moldcell-симках 26.09): SIM зарегистрирована
// (SimStatus OK), сессия поднята (ppp_connected / DATA:connected), но внешний
// IP не выдаётся (пусто или IP_RESET) и пинг 100% loss — модем стоит в сети,
// а данных нет. У Moldcell именно так выглядит исчерпанный пакет: модем
// «онлайн» для пингов умерших не считается, generic «модем оффлайн» уходит в
// ту же карточку, а причина была не видна.
//
// Симптом должен держаться НЕПРЕРЫВНО ≥ sim_exhaustion_min_minutes (дефолт 15)
// — короткие IP_RESET при ротации и полминутные флапы не алертим. При возврате
// IP стейт снимается; повтор эпизода — новый алерт (кулдаун 12 ч в правиле).
//
// Алерт: sim_package_exhausted (important) с расходом симки за текущий период
// пакета — оператору сразу видно, похоже на квоту или нет.

const GB = 1e9;

function _parseLoss(raw) {
  if (typeof raw !== 'string') return null;
  const m = raw.match(/(\d+)%\s*loss/i);
  return m ? parseInt(m[1], 10) : null;
}

function create(deps) {
  const { db, logger, alerts, getSetting, fetchAllServersDataCached } = deps;
  const state = new Map();   // server|imei → { since, nick }

  function _enabled() { return getSetting('sim_exhaustion_enabled', true) !== false; }
  function _minMs() {
    return Math.max(1, Number(getSetting('sim_exhaustion_min_minutes', 15)) || 15) * 60000;
  }

  // Признаки «сессия есть, данных нет» по живому фиду.
  function _symptomatic(m) {
    const nd = m.net_details || {};
    const md = m.modem_details || {};
    const sim = String(nd.SimStatus || '').toLowerCase();
    if (!sim.includes('ok')) return false;                          // нет SIM — не наш кейс
    const conn = String(nd.ConnectionStatus || '').toLowerCase();
    if (!conn.includes('ppp_connected') && !conn.includes('data:connected')) return false;
    if (nd.IS_ONLINE === 'yes') return false;
    const ip = String(nd.EXT_IP || '').trim();
    if (ip && ip !== 'IP_RESET') return false;                      // IP есть — сессия жива
    const loss = _parseLoss(nd.ping_stats);
    if (loss !== null && loss < 100) return false;                  // пинг ходит — не квота
    void md;
    return true;
  }

  // Расход симки с начала месяца (пакетный период уточнять не будем —
  // контекстная строка, не биллинг).
  function _usedGb(serverName, nick) {
    try {
      const monthStart = new Date().toISOString().slice(0, 7) + '-01 00:00';
      const r = db.prepare(`SELECT SUM(bytes_in + bytes_out) AS b FROM traffic_hourly
        WHERE server_name = ? AND nick = ? AND hour_start >= ?`).get(serverName, nick, monthStart);
      return ((r && r.b) || 0) / GB;
    } catch (_) { return null; }
  }

  async function runOnce() {
    if (!_enabled()) return { skipped: 'disabled' };
    let alerted = 0, active = 0;
    const results = await fetchAllServersDataCached();
    const now = Date.now();
    const seenKeys = new Set();
    for (const data of results || []) {
      const srv = data.serverName || '';
      if (data._cached) continue;   // устаревший фид симптомы не доказывает
      const statusArr = Array.isArray(data.status) ? data.status : [];
      for (const m of statusArr) {
        const md = m.modem_details || {};
        if (!md.IMEI) continue;
        const key = srv + '|' + md.IMEI;
        const nick = md.NICK || md.IMEI;
        if (!_symptomatic(m)) continue;
        seenKeys.add(key);
        let st = state.get(key);
        if (!st) { st = { since: now, nick, alerted: false }; state.set(key, st); }
        if (now - st.since < _minMs()) continue;
        active++;
        if (st.alerted) continue;
        const mins = Math.round((now - st.since) / 60000);
        const usedGb = _usedGb(srv, nick);
        const op = String((m.net_details || {}).CELLOP || '').trim();
        try {
          const sent = alerts.trigger('sim_package_exhausted', {
            server: srv, nick, imei: md.IMEI, operator: op,
            mins, used_gb: usedGb != null ? Math.round(usedGb * 10) / 10 : null,
          });
          if (sent) { st.alerted = true; alerted++; }
        } catch (e) { logger.warn('[SimExhaustion] alert failed: ' + e.message); }
      }
    }
    // Симптом исчез — стейт снимаем (следующий эпизод алертит заново).
    for (const [key, st] of state) {
      if (!seenKeys.has(key)) state.delete(key);
    }
    return { symptomatic: active, alerted, tracked: state.size };
  }

  return { runOnce, _state: state };
}

module.exports = { create };
