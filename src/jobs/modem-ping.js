'use strict';
// src/jobs/modem-ping.js — A1 (ТЗ мониторинга v2, 23.08): пинг модемов.
//
// Бокс ProxySmart САМ пингует через каждый модем и отдаёт результат в
// /apix/show_status_json → net_details.ping_stats («183ms, 0% loss»). Мы
// разбираем это поле в существующем цикле tracking'а — собственных пингов
// и дополнительной нагрузки на боксы нет (проверка 23.08: поле есть у всех
// 106 модемов 4 боксов, обновляется не реже 1/мин).
//
// Что делает джоба на каждом цикле (вызывается из modem-tracking):
//   1. парсит ping_stats → { latency_ms, loss_pct };
//   2. следит за свежестью по времени получения живого ответа; одинаковые
//      результаты являются допустимыми новыми наблюдениями;
//   3. пишет строку в modem_ping (история пинга для интерфейса и алертов);
//   4. алерты: online (IS_ONLINE=yes), но loss ≥ ping_loss_dead_pct два
//      опроса подряд → modem_ping_dead; latency > ping_latency_warn_ms или
//      loss ≥ ping_loss_warn_pct три опроса → modem_ping_slow; выход из
//      dead → modem_ping_recovered;
//   5. alive(server, imei) — для uptime: true/false, null = «нет свежих
//      данных, не влияем» (фича-флаг ping_enabled выкл → тоже null).
//
// Стриковые счётчики — в памяти (как offlineAlertSent): рестарт = перезапуск
// стриков, алерты не дублируются благодаря cooldown'ам правил.

function create(deps) {
  const { db, logger, alerts, getSetting } = deps;
  const _now = deps.now || (() => Date.now());
  const _insert = db.prepare(
    'INSERT INTO modem_ping (ts, server, nick, latency_ms, loss_pct, ok) VALUES (?,?,?,?,?,?)'
  );

  // key: `${server}_${imei}` → { nick, lastRaw, deadStreak,
  //   slowStreak, down, slow, last: {latency_ms, loss_pct, ok, fresh, ts} }
  const state = new Map();

  // «183ms, 0% loss» → { latency_ms: 183, loss_pct: 0 } | null
  function parsePingStats(raw) {
    if (typeof raw !== 'string') return null;
    const m = raw.match(/(\d+)\s*ms[^0-9]+(\d+)\s*%\s*loss/i);
    if (!m) return null;
    return { latency_ms: Number(m[1]), loss_pct: Number(m[2]) };
  }

  function _enabled() { return getSetting('ping_enabled', true); }

  // Влияние на аптайм: false = «online, но интернета нет» (свежие данные),
  // true = пинг ок, null = данных нет/протухли/выключено — не влияем.
  function alive(serverName, imei) {
    if (!_enabled()) return null;
    const st = state.get(serverName + '_' + imei);
    if (!st || !st.last || !_isFresh(st.last)) return null;
    return st.last.ok;
  }

  function _ttlMs() {
    return Math.max(1, Number(getSetting('ping_fresh_ttl_min', 10)) || 10) * 60000;
  }

  function _isFresh(last) {
    if (!last || last.quality !== 'valid') return false;
    const observed = Date.parse(last.ts);
    return Number.isFinite(observed) && _now() - observed <= _ttlMs();
  }

  // Снимок для UI: { 'S1_MD2_39': { latency_ms, loss_pct, ok, fresh, ts } }
  function latest() {
    const out = {};
    for (const st of state.values()) {
      if (st.last) out[st.server + '_' + st.nick] = { ...st.last, fresh: _isFresh(st.last) };
    }
    return out;
  }

  function ingest(serverName, statusArr, nowMs) {
    if (!_enabled()) return;
    if (!Array.isArray(statusArr)) return;
    const deadPct = Number(getSetting('ping_loss_dead_pct', 100));
    const warnPct = Number(getSetting('ping_loss_warn_pct', 30));
    const warnMs  = Number(getSetting('ping_latency_warn_ms', 800));
    const tsIso = new Date(nowMs).toISOString();

    for (const m of statusArr) {
      const md = m && m.modem_details;
      if (!md || !md.IMEI) continue;
      const imei = md.IMEI;
      const nick = md.NICK || imei;
      const nd = m.net_details || {};
      const raw = nd.ping_stats;
      const online = nd.IS_ONLINE === 'yes';

      const key = serverName + '_' + imei;
      let st = state.get(key);
      if (!st) {
        st = { server: serverName, nick, lastRaw: '',
               deadStreak: 0, slowStreak: 0, down: false, slow: false, last: null };
        state.set(key, st);
      }
      st.nick = nick;

      const parsed = parsePingStats(raw);
      if (!parsed) {
        st.last = { latency_ms: null, loss_pct: null, ok: null, fresh: false,
          quality: raw ? 'invalid' : 'missing', ts: tsIso };
        st.deadStreak = 0;
        st.slowStreak = 0;
        continue;
      }

      const ok = parsed.loss_pct < deadPct;
      st.lastRaw = raw;
      st.last = { latency_ms: parsed.latency_ms, loss_pct: parsed.loss_pct, ok,
        fresh: true, quality: 'valid', ts: tsIso };
      try { _insert.run(tsIso, serverName, nick, parsed.latency_ms, parsed.loss_pct, ok ? 1 : 0); }
      catch (e) { logger.warn('[ModemPing] insert failed: ' + e.message); }

      // Модем оффлайн — территория modem_offline-алертов, здесь молчим.
      // Свежесть здесь не проверяем: принятый parsed-результат — по
      // определению свежее наблюдение (TTL действует на чтении: alive/latest).
      if (!online) { st.deadStreak = 0; st.slowStreak = 0; continue; }

      if (!ok) {
        st.deadStreak++;
        st.slowStreak = 0;
        if (st.deadStreak >= 2 && !st.down) {
          st.down = true;
          alerts.trigger('modem_ping_dead', {
            server: serverName, nick, imei,
            operator: nd.CELLOP || '',
            loss: parsed.loss_pct, latency: parsed.latency_ms,
          });
        }
        continue;
      }
      // Пинг ок
      if (st.down) {
        st.down = false;
        alerts.trigger('modem_ping_recovered', { server: serverName, nick, imei, operator: nd.CELLOP || '', latency: parsed.latency_ms });
      }
      st.deadStreak = 0;
      const slow = parsed.latency_ms > warnMs || parsed.loss_pct >= warnPct;
      if (slow) {
        st.slowStreak++;
        if (st.slowStreak >= 3 && !st.slow) {
          st.slow = true;
          alerts.trigger('modem_ping_slow', {
            server: serverName, nick, imei,
            loss: parsed.loss_pct, latency: parsed.latency_ms,
          });
        }
      } else { st.slowStreak = 0; st.slow = false; }
    }
  }

  return { ingest, alive, latest, parsePingStats, _state: state };
}

module.exports = { create };
