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
//   3. пишет строку в modem_ping (история ТОЛЬКО пригодных замеров для
//      интерфейса и алертов) и обновляет modem_ping_state (текущее состояние
//      наблюдения: valid/missing/invalid) — его читают computeProxyIssues,
//      public-status и auto-reboot (FIX-05/06, 2026-09-18);
//   4. алерты: online (IS_ONLINE=yes), но loss ≥ ping_loss_dead_pct два
//      опроса подряд → modem_ping_dead; latency > ping_latency_warn_ms или
//      loss ≥ ping_loss_warn_pct три опроса → modem_ping_slow; выход из
//      dead → modem_ping_recovered;
//   5. alive(server, imei) — для uptime: true/false, null = «нет свежих
//      данных, не влияем» (фича-флаг ping_enabled выкл → тоже null).
//
// Стриковые счётчики — в памяти (как offlineAlertSent): рестарт = перезапуск
// стриков, алерты не дублируются благодаря cooldown'ам правил. Текущее
// состояние наблюдения дублируется в modem_ping_state и переживает рестарт.
//
// Идентичность — слот (server+nick), а не IMEI: на боксе возможны клоны IMEI
// (FIX-SPEC §16.2), у каждого слота свой ping_stats. alive(imei) консервативно
// объединяет слоты: свежий отказ любого слота → false.

const pingFresh = require('../services/ping-freshness');

function create(deps) {
  const { db, logger, alerts, getSetting } = deps;
  const _now = deps.now || (() => Date.now());
  const _insert = db.prepare(
    'INSERT INTO modem_ping (ts, server, nick, latency_ms, loss_pct, ok, measured_at) VALUES (?,?,?,?,?,?,?)'
  );
  const _upsertState = db.prepare(
    `INSERT INTO modem_ping_state (server, nick, imei, quality, latency_ms, loss_pct, ok, observed_at, measured_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(server, nick) DO UPDATE SET
       imei = excluded.imei, quality = excluded.quality,
       latency_ms = excluded.latency_ms, loss_pct = excluded.loss_pct, ok = excluded.ok,
       observed_at = excluded.observed_at, measured_at = excluded.measured_at,
       updated_at = excluded.updated_at`
  );

  // key: `${server}_${nick}` → { server, nick, deadStreak, slowStreak,
  //   down, slow, last: {latency_ms, loss_pct, ok, fresh, quality, ts} }
  const state = new Map();
  // `${server}_${imei}` → Set(nick) — обратный индекс для alive(imei).
  const _imeiNicks = new Map();

  // «183ms, 0% loss» → { latency_ms: 183, loss_pct: 0 } | null
  function parsePingStats(raw) {
    if (typeof raw !== 'string') return null;
    const m = raw.match(/(\d+)\s*ms[^0-9]+(\d+)\s*%\s*loss/i);
    if (!m) return null;
    return { latency_ms: Number(m[1]), loss_pct: Number(m[2]) };
  }

  function _enabled() { return getSetting('ping_enabled', true); }

  function _ttlMs() { return pingFresh.ttlMs(getSetting); }

  function _saveState(serverName, nick, imei, quality, latencyMs, lossPct, ok, tsIso) {
    // measured_at: API время замера не отдаёт — NULL, не выдумываем (FIX-05).
    try { _upsertState.run(serverName, nick, imei, quality, latencyMs, lossPct, ok, tsIso, null, tsIso); }
    catch (e) { logger.warn('[ModemPing] state upsert failed: ' + e.message); }
  }

  // Влияние на аптайм: false = «online, но интернета нет» (свежие данные),
  // true = пинг ок, null = данных нет/протухли/выключено — не влияем.
  function alive(serverName, imei) {
    if (!_enabled()) return null;
    const nicks = _imeiNicks.get(serverName + '_' + imei);
    if (!nicks || !nicks.size) return null;
    const nowMs = _now(), ttl = _ttlMs();
    let sawOk = false;
    for (const nick of nicks) {
      const st = state.get(serverName + '_' + nick);
      if (!st || !st.last) continue;
      if (!pingFresh.isFreshValid({ quality: st.last.quality, ts: st.last.ts }, nowMs, ttl)) continue;
      if (st.last.ok === false) return false;  // свежий отказ любого слота с этим IMEI
      if (st.last.ok === true) sawOk = true;
    }
    return sawOk ? true : null;
  }

  // Снимок для UI: { 'S1_MD2_39': { latency_ms, loss_pct, ok, fresh, quality, ts } }.
  // Возраст и fresh пересчитываются на каждом чтении (FIX-05): даже если ingest
  // больше не вызывается, по истечении TTL запись становится stale.
  function latest() {
    const out = {};
    const nowMs = _now(), ttl = _ttlMs();
    for (const st of state.values()) {
      if (!st.last) continue;
      const q = pingFresh.qualityAt({ quality: st.last.quality, ts: st.last.ts }, nowMs, ttl);
      out[st.server + '_' + st.nick] = { ...st.last, fresh: q === 'valid', quality: q };
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

      const key = serverName + '_' + nick;
      let st = state.get(key);
      if (!st) {
        st = { server: serverName, nick,
               deadStreak: 0, slowStreak: 0, down: false, slow: false, last: null };
        state.set(key, st);
      }
      st.nick = nick;
      const imeiKey = serverName + '_' + imei;
      if (!_imeiNicks.has(imeiKey)) _imeiNicks.set(imeiKey, new Set());
      _imeiNicks.get(imeiKey).add(nick);

      const parsed = parsePingStats(raw);
      if (!parsed) {
        // FIX-06/DEEP-12: пустой/битый ping_stats немедленно инвалидирует
        // текущий результат — и в памяти, и в modem_ping_state. Без записи
        // в БД computeProxyIssues/public-status продолжали читать СТАРЫЙ
        // failed из истории и держали кандидата на reboot.
        const quality = (typeof raw === 'string' && raw.trim()) ? 'invalid' : 'missing';
        st.last = { latency_ms: null, loss_pct: null, ok: null, fresh: false,
          quality, ts: tsIso };
        st.deadStreak = 0;
        st.slowStreak = 0;
        _saveState(serverName, nick, imei, quality, null, null, null, tsIso);
        continue;
      }

      const ok = parsed.loss_pct < deadPct;
      st.last = { latency_ms: parsed.latency_ms, loss_pct: parsed.loss_pct, ok,
        fresh: true, quality: 'valid', ts: tsIso };
      // История — только пригодные замеры (FIX-05: недостоверные наблюдения
      // не размывают проценты успешности). measured_at — NULL (см. выше).
      try { _insert.run(tsIso, serverName, nick, parsed.latency_ms, parsed.loss_pct, ok ? 1 : 0, null); }
      catch (e) { logger.warn('[ModemPing] insert failed: ' + e.message); }
      _saveState(serverName, nick, imei, 'valid', parsed.latency_ms, parsed.loss_pct, ok ? 1 : 0, tsIso);

      // Модем оффлайн — территория modem_offline-алертов, здесь молчим.
      // Свежесть здесь не проверяем: принятый parsed-результат — по
      // определению свежее наблюдение (TTL действует на чтении: alive/latest).
      if (!online) { st.deadStreak = 0; st.slowStreak = 0; continue; }

      if (!ok) {
        st.deadStreak++;
        st.slowStreak = 0;
        // DEEP-77 (2026-09-24): регистрация эпизода отделена от наблюдения.
        // trigger отклонён (boot grace/maintenance/правило выключено) —
        // downAlerted НЕ выставляем: актуальный сбой повторит попытку на
        // следующем цикле после снятия гейта (раньше единственная попытка
        // сгорала, а последующий ok давал recovery без opening).
        if (st.deadStreak >= 2 && !st.downAlerted) {
          const accepted = alerts.trigger('modem_ping_dead', {
            server: serverName, nick, imei,
            operator: nd.CELLOP || '',
            loss: parsed.loss_pct, latency: parsed.latency_ms,
          });
          if (accepted) st.downAlerted = true;
        }
        continue;
      }
      // Пинг ок
      if (st.downAlerted) {
        st.downAlerted = false;
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
    // DEEP-75 (2026-09-24): согласование сохранённых инцидентов — модемы с
    // подтверждённым онлайн+пингом закрывают свои эпизоды без перехода
    // (восстановление во время рестарта перехода не даёт).
    if (alerts.reconcileIncidents) {
      try {
        const healthy = [];
        for (const m of statusArr) {
          const md = m && m.modem_details;
          const nd = m && m.net_details || {};
          if (!md || !md.IMEI || nd.IS_ONLINE !== 'yes') continue;
          const parsed = parsePingStats(nd.ping_stats);
          if (parsed && parsed.loss_pct < Number(getSetting('ping_loss_dead_pct', 100))) {
            healthy.push({ server: serverName, imei: md.IMEI, nick: md.NICK || md.IMEI, online: true });
          }
        }
        if (healthy.length) alerts.reconcileIncidents(healthy);
      } catch (_) { /* best-effort */ }
    }
  }

  return { ingest, alive, latest, parsePingStats, _state: state };
}

module.exports = { create };
