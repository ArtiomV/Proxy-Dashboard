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
// — короткие IP_RESET при ротации и полминутные флапы не алертим.
//
// Подтверждённый эпизод — СОСТОЯНИЕ (таблица sim_exhaustion_state, миграция
// 104), а не разовый алерт. Пока строка активна:
//   * alerts.js подавляет алерты нестабильности модема (EXHAUST_SUPPRESSED_
//     RULES): без IP модем флапает, и каждый флап не должен спамить;
//   * speed-monitor пропускает спидтесты по модему — оператор не блокирует
//     сеть, а режет скорость до ~0: замер бессмысленен и жрёт трафик симки.
//
// Восстановление ловится по косвенным признакам (пополнение пакета у
// оператора мы не видим): EXT_IP выдан (не IP_RESET) + IS_ONLINE=yes +
// пинг НЕ 100% loss — непрерывно ≥ sim_exhaustion_recover_min (дефолт 10 мин).
// Тогда строка удаляется, уходит sim_package_recovered и все ограничения
// снимаются. Модем ищется по IMEI по ВСЕМ серверам (мог переехать).
//
// Алерт: sim_package_exhausted (important) с расходом симки за текущий период
// пакета — оператору сразу видно, похоже на квоту или нет.

const GB = 1e9;

function _parseLoss(raw) {
  if (typeof raw !== 'string') return null;
  const m = raw.match(/(\d+)%\s*loss/i);
  return m ? parseInt(m[1], 10) : null;
}

// Модем полноценно в работе: IP выдан, онлайн, пинг ходит. Используется как
// критерий восстановления после исчерпания пакета.
function _healthy(m) {
  const nd = (m && m.net_details) || {};
  const ip = String(nd.EXT_IP || '').trim();
  if (!ip || ip === 'IP_RESET') return false;
  if (nd.IS_ONLINE !== 'yes') return false;
  const loss = _parseLoss(nd.ping_stats);
  if (loss !== null && loss >= 100) return false;
  return true;
}

// Подавлен ли модем состоянием «пакет исчерпан»? Используется alerts.js
// (гейт нестабильности), notify-collect (колокольчик) и speed-monitor
// (пропуск замеров). Таблицы нет на старой схеме → false (не глушим).
// Матч: по IMEI (глобально уникален, переживает переезд на другой бокс),
// иначе по server+nick, иначе по голому nick.
function isExhausted(db, target) {
  if (!db || !target) return false;
  const { server, nick, imei } = target;
  try {
    if (imei) {
      if (db.prepare('SELECT 1 FROM sim_exhaustion_state WHERE imei = ? LIMIT 1').get(imei)) return true;
    }
    if (server && nick) {
      if (db.prepare('SELECT 1 FROM sim_exhaustion_state WHERE server_name = ? AND nick = ? LIMIT 1').get(server, nick)) return true;
    } else if (nick) {
      if (db.prepare('SELECT 1 FROM sim_exhaustion_state WHERE nick = ? LIMIT 1').get(nick)) return true;
    }
    return false;
  } catch (_) { return false; }
}

function create(deps) {
  const { db, logger, alerts, getSetting, fetchAllServersDataCached } = deps;
  const state = new Map();       // server|imei → { since, nick, alerted } — симптом наблюдаем (in-memory)
  const recovering = new Map();  // server|imei → healthySince (мс) — кандидат на восстановление

  function _enabled() { return getSetting('sim_exhaustion_enabled', true) !== false; }
  function _minMs() {
    return Math.max(1, Number(getSetting('sim_exhaustion_min_minutes', 15)) || 15) * 60000;
  }
  function _recoverMs() {
    return Math.max(1, Number(getSetting('sim_exhaustion_recover_min', 10)) || 10) * 60000;
  }

  // Prepared statements — lazy, с переносимостью на минимальные тестовые
  // схемы: таблицы нет → работаем как раньше, чисто in-memory.
  let _st = null, _stFailed = false;
  function _stmts() {
    if (_st || _stFailed) return _st;
    try {
      _st = {
        upsert: db.prepare(`INSERT INTO sim_exhaustion_state (server_name, imei, nick, operator, since_ts, alerted_at)
          VALUES (?, ?, ?, ?, ?, NULL)
          ON CONFLICT(server_name, imei) DO UPDATE SET nick = excluded.nick, operator = excluded.operator`),
        alertedAt: db.prepare('SELECT alerted_at FROM sim_exhaustion_state WHERE server_name = ? AND imei = ?'),
        markAlerted: db.prepare('UPDATE sim_exhaustion_state SET alerted_at = ? WHERE server_name = ? AND imei = ?'),
        del: db.prepare('DELETE FROM sim_exhaustion_state WHERE server_name = ? AND imei = ?'),
        all: db.prepare('SELECT server_name, imei, nick, operator, since_ts, alerted_at FROM sim_exhaustion_state'),
      };
    } catch (_) { _stFailed = true; _st = null; }
    return _st;
  }
  function _activeRows() {
    const st = _stmts();
    if (!st) return [];
    try { return st.all.all(); } catch (_) { return []; }
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

  // Подтверждённые эпизоды: проверяем восстановление по живому фиду.
  // Модем ищем по IMEI по всем серверам (мог переехать на другой бокс).
  // Нет модема в фиде / нет здоровых признаков — НЕ восстановление: состояние
  // держим (модем с исчерпанным пакетом может вообще уходить в оффлайн).
  function _checkRecoveries(byImei, now) {
    let recovered = 0;
    for (const row of _activeRows()) {
      const key = row.server_name + '|' + row.imei;
      const hit = byImei.get(row.imei);
      if (!hit || !_healthy(hit.m)) { recovering.delete(key); continue; }
      const since = recovering.get(key) || 0;
      if (!since) { recovering.set(key, now); continue; }
      if (now - since < _recoverMs()) continue;
      // Подтверждённое восстановление: снимаем состояние и все ограничения.
      const st = _stmts();
      if (st) { try { st.del.run(row.server_name, row.imei); } catch (_) {} }
      recovering.delete(key);
      state.delete(key);
      const nick = (hit.m.modem_details || {}).NICK || row.nick;
      const minsDown = Math.max(0, Math.round((now - Number(row.since_ts || now)) / 60000));
      try {
        alerts.trigger('sim_package_recovered', {
          server: hit.srv, nick, imei: row.imei, operator: row.operator, mins_down: minsDown,
        });
      } catch (e) { logger.warn('[SimExhaustion] recovery alert failed: ' + e.message); }
      recovered++;
      logger.info(`[SimExhaustion] ${nick} (${row.server_name}): пакет восстановлен после ~${minsDown} мин — ограничения сняты`);
    }
    return recovered;
  }

  async function runOnce() {
    if (!_enabled()) return { skipped: 'disabled' };
    let alerted = 0, active = 0;
    const results = await fetchAllServersDataCached();
    const now = Date.now();

    // Индекс живого фида по IMEI (по всем серверам) — для проверки
    // восстановления подтверждённых эпизодов.
    const byImei = new Map();   // imei → { srv, m }
    for (const data of results || []) {
      if (data._cached) continue;   // устаревший фид ничего не доказывает
      const statusArr = Array.isArray(data.status) ? data.status : [];
      for (const m of statusArr) {
        const imei = (m.modem_details || {}).IMEI;
        if (imei && !byImei.has(imei)) byImei.set(imei, { srv: data.serverName || '', m });
      }
    }
    const recovered = _checkRecoveries(byImei, now);

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
        // Подтверждённый эпизод — персистим: подавление в alerts/speed-monitor
        // читает таблицу и обязано переживать рестарт дашборда.
        const op = String((m.net_details || {}).CELLOP || '').trim();
        const stmts = _stmts();
        if (stmts) {
          try { stmts.upsert.run(srv, md.IMEI, nick, op, st.since); } catch (_) {}
        }
        const alertedAt = stmts ? (stmts.alertedAt.get(srv, md.IMEI) || {}).alerted_at : null;
        if (st.alerted || alertedAt) continue;
        const mins = Math.round((now - st.since) / 60000);
        const usedGb = _usedGb(srv, nick);
        try {
          const sent = alerts.trigger('sim_package_exhausted', {
            server: srv, nick, imei: md.IMEI, operator: op,
            mins, used_gb: usedGb != null ? Math.round(usedGb * 10) / 10 : null,
          });
          if (sent) {
            st.alerted = true;
            if (stmts) { try { stmts.markAlerted.run(now, srv, md.IMEI); } catch (_) {} }
            alerted++;
          }
        } catch (e) { logger.warn('[SimExhaustion] alert failed: ' + e.message); }
      }
    }
    // Симптом исчез без подтверждения — in-memory стейт снимаем. Подтверждённые
    // эпизоды живут в sim_exhaustion_state и этой чисткой не трогаются.
    for (const [key, st] of state) {
      if (!seenKeys.has(key)) state.delete(key);
    }
    return { symptomatic: active, alerted, recovered, tracked: state.size };
  }

  return { runOnce, _state: state, _recovering: recovering };
}

module.exports = { create, isExhausted };
