'use strict';
//
// src/jobs/sim-exhaustion.js — 2026-09-26: детектор «у симки кончился трафик»
// по СИМПТОМАМ (а не по счётчику — квота оператора нам неизвестна).
//
// Сигнатура 1 (подтверждена на живых Moldcell-симках 26.09): SIM
// зарегистрирована (SimStatus OK), сессия поднята (ppp_connected /
// DATA:connected), но внешний IP не выдаётся (пусто или IP_RESET) и пинг
// 100% loss — модем стоит в сети, а данных нет.
//
// Сигнатура 2 (троттлинг, 26.09): модем ЖИВ (IP/пинг в норме — сигнатура 1
// его не видит), но почасовой монитор скорости меряет ~0. Кандидат «отдыхает»
// sim_exhaustion_throttle_confirm_min (дефолт 5 мин) после плохого замера,
// затем подтверждается контрольной спидтест-пробой: dl снова
// < sim_exhaustion_throttle_dl_mbps (дефолт 1) → то же состояние, алерт
// sim_package_exhausted с kind='throttled'.
//
// Сигнатура 3 (замороженный трафик, 26.09): модем жив, но дельта суточных
// bw-счётчиков < sim_exhaustion_frozen_mb (дефолт 5 МБ) держится
// sim_exhaustion_frozen_min (дефолт 20 мин). Почасовой монитор меряет лишь
// пару ников на оператора в час, поэтому массовый троттлинг ловится именно
// здесь — отбор бесплатный, спидтест только финальный арбитр.
//
// Симптом сигнатуры 1 должен держаться НЕПРЕРЫВНО ≥ sim_exhaustion_min_minutes
// (дефолт 15) — короткие IP_RESET при ротации и полминутные флапы не алертим.
//
//
// Подтверждённый эпизод — СОСТОЯНИЕ (таблица sim_exhaustion_state, миграция
// 104), а не разовый алерт. Пока строка активна:
//   * alerts.js подавляет алерты нестабильности модема (EXHAUST_SUPPRESSED_
//     RULES): без IP модем флапает, и каждый флап не должен спамить;
//   * speed-monitor пропускает спидтесты по модему — оператор не блокирует
//     сеть, а режет скорость до ~0: замер бессмысленен и жрёт трафик симки.
//
// Восстановление: все тарифы — «безлимит с троттлингом» (N ГБ на максимальной
// скорости, дальше минимальная), поэтому возврат IP/пинга НЕ означает
// реактивацию пакета — трафик идёт и на урезанной скорости. Когда модем
// начинает выглядеть здоровым (EXT_IP не IP_RESET + IS_ONLINE=yes + пинг
// не 100% loss), делаем СПИДТЕСТ-пробу (не чаще sim_exhaustion_recover_probe_
// min, дефолт 30 мин; до 3 проб за прогон). dl ≥ sim_exhaustion_recover_dl_mbps
// (дефолт 5) → строка удаляется, уходит sim_package_recovered, все ограничения
// сняты. Пока скорость урезана — состояние и подавление держатся.
// Модем ищется по IMEI по ВСЕМ серверам (мог переехать).
//
// Алерт: sim_package_exhausted (important) с расходом симки за текущий период
// пакета — оператору сразу видно, похоже на квоту или нет.

const GB = 1e9;
const { normalizeOperator, parseBwToBytes } = require('../utils/traffic');

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
  const apiServers = deps.apiServers || [];
  const fetchApi = deps.fetchApi || null;   // нужен для спидтест-пробы восстановления
  const state = new Map();       // server|imei → { since, nick, alerted } — симптом наблюдаем (in-memory)
  const probes = new Map();      // server|imei → lastProbeAt (мс) — когда последний раз мерили скорость
  const throttleCandidates = new Map();  // server|imei → { firstAt, server, nick } — плохой замер ждёт 5-мин подтверждения
  const bwTrack = new Map();     // server|imei → { total, at, frozenSince } — дельты bw-счётчиков (сигнатура 3)
  const frozenClearedAt = new Map();     // server|imei → ts — проба показала норму, бэкофф от повторных кандидатов

  // Оператор из живого фида — нормализованный (Moldcell/Orange RO/…), как в
  // modem_meta и сводках. Храним нормализованным, чтобы операторский уровень
  // (≥80% симок в состоянии) не разваливался на варианты написания CELLOP.
  function _normOp(raw, srvName) {
    const srv = apiServers.find(s => s.name === srvName);
    const isRO = !!srv && (srv.country || '') === 'RO';
    try { return normalizeOperator(raw, isRO) || String(raw || '').trim(); }
    catch (_) { return String(raw || '').trim(); }
  }

  function _enabled() { return getSetting('sim_exhaustion_enabled', true) !== false; }
  function _minMs() {
    return Math.max(1, Number(getSetting('sim_exhaustion_min_minutes', 15)) || 15) * 60000;
  }
  // Восстановление подтверждается СПИДТЕСТОМ: все тарифы — «безлимит с
  // троттлингом» (N ГБ на максимальной скорости, дальше минимальная), поэтому
  // возврат IP/пинга НЕ означает восстановление — трафик идёт и на урезанной
  // скорости. Пробуем не чаще sim_exhaustion_recover_probe_min (дефолт 30 мин)
  // и только когда модем выглядит здоровым (IP + online + пинг).
  function _probeMs() {
    return Math.max(1, Number(getSetting('sim_exhaustion_recover_probe_min', 30)) || 30) * 60000;
  }
  function _recoverDlMbps() {
    const v = Number(getSetting('sim_exhaustion_recover_dl_mbps', 5));
    return Number.isFinite(v) && v > 0 ? v : 5;
  }
  function _maxProbesPerRun() {
    return Math.max(1, Number(getSetting('sim_exhaustion_max_probes_per_run', 3)) || 3);
  }
  // Троттлинг-сигнатура: последний почасовой замер dl < порога → кандидат;
  // подтверждение пробой после confirm-минут «отдыха» модема.
  function _throttleDlMbps() {
    const v = Number(getSetting('sim_exhaustion_throttle_dl_mbps', 1));
    return Number.isFinite(v) && v > 0 ? v : 1;
  }
  function _throttleConfirmMs() {
    return Math.max(1, Number(getSetting('sim_exhaustion_throttle_confirm_min', 5)) || 5) * 60000;
  }
  // Операторский уровень: доля симок оператора на площадке в состоянии
  // «пакет исчерпан», при которой шлём один групповой алерт.
  function _opRatio() {
    const v = Number(getSetting('sim_exhaustion_operator_ratio', 0.8));
    return Number.isFinite(v) && v > 0 && v <= 1 ? v : 0.8;
  }
  // Сигнатура 3 — «замороженный трафик»: модем жив, но дельта суточных
  // bw-счётчиков < sim_exhaustion_frozen_mb (дефолт 5 МБ) держится
  // sim_exhaustion_frozen_min (дефолт 20 мин). На этом флоте даже полупустая
  // симка гоняет сотни МБ/час — заморозка = троттлинг (MD_72: 0.5 МБ/час).
  function _frozenMinMs() {
    return Math.max(1, Number(getSetting('sim_exhaustion_frozen_min', 20)) || 20) * 60000;
  }
  function _frozenBytes() {
    const v = Number(getSetting('sim_exhaustion_frozen_mb', 5));
    return (Number.isFinite(v) && v > 0 ? v : 5) * 1e6;
  }
  // После пробы «скорость в норме» модем не кандидатствует 6 часов — иначе
  // свободные (без клиентов) модемы вечно занимали бы бюджет проб.
  function _frozenClearedMs() {
    return Math.max(1, Number(getSetting('sim_exhaustion_frozen_backoff_hours', 6)) || 6) * 3600000;
  }
  // Сигнатуры 2/3 (троттлинг) — только для операторов, у которых пакет
  // реально исчерпывается в непригодную скорость. Инцидент 26.09: Moldtelecom/
  // Orange MD на S1 (MD2_50-66) — хронически медленные модемы (их НОРМА
  // 1–2 Мбит/с по 200+ замерам за 14 дней, трафик 6–8 ГБ/сут идёт) попали в
  // состояние по абсолютному порогу 1 Мбит. Дефолт — Moldcell; список
  // расширяется настройкой (CSV, регистр не важен). Пустая строка = все.
  function _throttleOps() {
    const raw = getSetting('sim_exhaustion_throttle_operators', 'Moldcell');
    const list = String(raw == null ? 'Moldcell' : raw).split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    return new Set(list);   // пустой Set = «все операторы» (explicit opt-in)
  }
  function _throttleOpAllowed(op) {
    const set = _throttleOps();
    if (set.size === 0) return true;
    return set.has(String(op || '').toLowerCase());
  }
  // Медиана dl модема за 14 дней из speed_monitor — «его нормальная скорость».
  // Нужна для относительного порога восстановления: медленный-by-design модем
  // (туннельный APN, 1–2 Мбит в норме) не должен застрять в состоянии из-за
  // абсолютных 5 Мбит. Кэш на прогон.
  let _baselineCache = null;
  function _baselineDl(srv, nick) {
    if (!_baselineCache) _baselineCache = new Map();
    const k = srv + '|' + nick;
    if (_baselineCache.has(k)) return _baselineCache.get(k);
    let out = null;
    try {
      const rows = db.prepare(`SELECT download FROM speed_monitor
        WHERE server = ? AND nick = ? AND ok = 1 AND download > 0
          AND ts >= datetime('now', '-14 days') ORDER BY download`).all(srv, nick);
      if (rows.length >= 5) out = Number(rows[Math.floor(rows.length / 2)].download) || null;
    } catch (_) { /* минимальная схема */ }
    _baselineCache.set(k, out);
    return out;
  }
  // Порог восстановления: max(1, min(абсолютный, норма × 0.5)). Moldcell
  // (норма ~60) → 5 Мбит; туннельный модем (норма 1.3) → 1 Мбит.
  function _recoverThreshold(srv, nick) {
    const base = _baselineDl(srv, nick);
    const abs = _recoverDlMbps();
    if (!base) return abs;
    return Math.max(1, Math.min(abs, base * 0.5));
  }

  // Одна спидтест-проба через бокс (как speed-monitor, но одиночная и без
  // ретраев: на задушенной симке замер сам по себе медленный). null — замер
  // не удался (бокс/сеть), объект {dl, ul, ping} — результат.
  async function _probeSpeed(srvName, nick) {
    const server = apiServers.find(s => s.name === srvName);
    if (!server || typeof fetchApi !== 'function') return null;
    try {
      const result = await fetchApi(server, `/apix/speedtest?arg=${encodeURIComponent(nick)}`, 180000);
      if (result && result.error) throw new Error(String(result.error));
      return require('./speed-monitor').parseSpeedtestResult(result);
    } catch (e) {
      logger.warn(`[SimExhaustion] спидтест-проба ${nick} (${srvName}) не удалась: ${e.message}`);
      return null;
    }
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

  // Подтверждённые эпизоды: проверяем восстановление. Модем ищем по IMEI по
  // всем серверам (мог переехать на другой бокс). Нет модема в фиде / нет
  // базовых признаков жизни — НЕ восстановление: состояние держим.
  // Базовые признаки (IP + online + пинг) — только ГЕЙТ для спидтест-пробы:
  // при троттлинге трафик идёт и на минимальной скорости, поэтому «пакет
  // реально реактивирован» = замер dl ≥ sim_exhaustion_recover_dl_mbps.
  async function _checkRecoveries(byImei, now, budget) {
    let recovered = 0;
    for (const row of _activeRows()) {
      const key = row.server_name + '|' + row.imei;
      const hit = byImei.get(row.imei);
      if (!hit || !_healthy(hit.m)) continue;
      if (budget.used >= budget.max) continue;                  // бюджет прогона: спидтесты последовательны и долгие
      const lastProbe = probes.get(key) || 0;
      if (now - lastProbe < _probeMs()) continue;               // недавно мерили — скорость всё ещё урезана
      probes.set(key, now);
      budget.used++;
      const nick = (hit.m.modem_details || {}).NICK || row.nick;
      const res = await _probeSpeed(hit.srv, nick);
      if (!res || !(res.dl > 0 || res.ul > 0)) continue;        // замер не удался — следующая пробы по кулдауну
      // Относительный порог: медленный-by-design модем (норма 1–2 Мбит,
      // инцидент 26.09 с Moldtelecom/Orange MD на S1) не застревает навсегда.
      const thr = _recoverThreshold(hit.srv, nick);
      if (res.dl < thr) {
        logger.info(`[SimExhaustion] ${nick} (${hit.srv}): скорость всё ещё урезана (↓${res.dl} Mbps < ${thr}) — состояние держим`);
        continue;
      }
      // Подтверждённое восстановление: снимаем состояние и все ограничения.
      const st = _stmts();
      if (st) { try { st.del.run(row.server_name, row.imei); } catch (_) {} }
      probes.delete(key);
      state.delete(key);
      const minsDown = Math.max(0, Math.round((now - Number(row.since_ts || now)) / 60000));
      try {
        alerts.trigger('sim_package_recovered', {
          server: hit.srv, nick, imei: row.imei, operator: row.operator, mins_down: minsDown,
          dl: Math.round(res.dl * 10) / 10, ul: Math.round(res.ul * 10) / 10,
        });
      } catch (e) { logger.warn('[SimExhaustion] recovery alert failed: ' + e.message); }
      recovered++;
      logger.info(`[SimExhaustion] ${nick} (${row.server_name}): пакет восстановлен (↓${res.dl} Mbps) после ~${minsDown} мин — ограничения сняты`);
    }
    return recovered;
  }

  // Общий финал сигнатур 2/3: контрольная проба и, при подтверждении ~0,
  // включение состояния + алерт kind='throttled'. Возвращает:
  //   'flagged' — троттлинг подтверждён, состояние включено;
  //   'cleared' — проба показала норму (ложная тревога);
  //   'retry'   — проба не удалась или бюджет/кулдаун не дали мерить.
  async function _probeAndFlag({ srv, nick, imei, op, now, budget, evidence }) {
    const key = srv + '|' + imei;
    if (budget.used >= budget.max) return 'retry';
    const lastProbe = probes.get(key) || 0;
    if (now - lastProbe < _probeMs()) return 'retry';
    probes.set(key, now);
    budget.used++;
    const res = await _probeSpeed(srv, nick);
    if (!res || !(res.dl > 0 || res.ul > 0)) return 'retry';   // замер не удался
    if (res.dl >= _throttleDlMbps()) return 'cleared';
    const stmts = _stmts();
    if (stmts) { try { stmts.upsert.run(srv, imei, nick, op, now); } catch (_) {} }
    logger.info(`[SimExhaustion] ${nick} (${srv}): подтверждён троттлинг (↓${res.dl} Mbps${evidence ? ', ' + evidence : ''}) — состояние включено`);
    const alertedAt = stmts ? (stmts.alertedAt.get(srv, imei) || {}).alerted_at : null;
    if (alertedAt) return 'flagged';
    const usedGb = _usedGb(srv, nick);
    try {
      const sent = alerts.trigger('sim_package_exhausted', {
        server: srv, nick, imei, operator: op, kind: 'throttled', evidence,
        dl: Math.round(res.dl * 100) / 100,
        used_gb: usedGb != null ? Math.round(usedGb * 10) / 10 : null,
      });
      if (sent && stmts) { try { stmts.markAlerted.run(now, srv, imei); } catch (_) {} }
    } catch (e) { logger.warn('[SimExhaustion] throttled alert failed: ' + e.message); }
    return 'flagged';
  }

  // Сигнатура 2 — троттлинг. Модем жив (IP/пинг в норме — сигнатура 1 его не
  // видит), но почасовой монитор меряет ~0. Кандидат «отдыхает»
  // sim_exhaustion_throttle_confirm_min (дефолт 5 мин), затем подтверждаем
  // контрольной пробой. Подтвердилось → то же sim_exhaustion_state; дальше
  // восстановление идёт общим путём (спидтест-пробы каждые 30 мин).
  async function _detectThrottled(byServerNick, now, budget) {
    let flagged = 0;
    let rows;
    try {
      rows = db.prepare(`
        SELECT server, nick, download, MAX(ts) AS ts
        FROM speed_monitor
        WHERE ok = 1 AND ts >= datetime('now', '-3 hours')
        GROUP BY server, nick
      `).all().filter(r => Number(r.download) < _throttleDlMbps());
    } catch (_) { return 0; }   // нет speed_monitor на минимальной схеме
    const seenCandidates = new Set();
    for (const r of rows) {
      if (isExhausted(db, { server: r.server, nick: r.nick })) continue;   // уже в состоянии
      const hit = byServerNick.get(r.server + '|' + r.nick);
      if (!hit) continue;                        // нет в живом фиде — IMEI не подтвердить
      if (_symptomatic(hit.m)) continue;         // это сигнатура 1 — она сама разберётся
      const imei = (hit.m.modem_details || {}).IMEI;
      if (!imei) continue;
      const op = _normOp((hit.m.net_details || {}).CELLOP || '', r.server);
      if (!_throttleOpAllowed(op)) continue;     // оператор без троттлинга (Moldtelecom/Orange MD — инцидент 26.09)
      const key = r.server + '|' + imei;
      seenCandidates.add(key);
      const cand = throttleCandidates.get(key);
      if (!cand) { throttleCandidates.set(key, { firstAt: now, server: r.server, nick: r.nick }); continue; }  // модем «отдыхает»
      if (now - cand.firstAt < _throttleConfirmMs()) continue;
      const outcome = await _probeAndFlag({ srv: r.server, nick: r.nick, imei, op, now, budget, evidence: 'повтор после 5-мин паузы' });
      if (outcome === 'cleared' || outcome === 'flagged') throttleCandidates.delete(key);
      if (outcome === 'flagged') flagged++;
    }
    // Кандидаты, чей замер перестал быть плохим (прошло >3ч или скорость
    // восстановилась сама), вычищаем.
    for (const [key, cand] of throttleCandidates) {
      if (!seenCandidates.has(key)) throttleCandidates.delete(key);
      void cand;
    }
    return flagged;
  }

  // Сигнатура 3 — «замороженный трафик» (2026-09-26, флуд MD_72/73). Почасовой
  // монитор меряет лишь пару ников на оператора в час — массовый троттлинг
  // ловился бы сутками, а непойманные симки флапают offline/recovered.
  // Здесь смотрим дельты суточных bw-счётчиков самого фида: дельта
  // < sim_exhaustion_frozen_mb за sim_exhaustion_frozen_min — кандидат на ту
  // же подтверждающую пробу. Отбор бесплатный (без спидтестов), спидтест —
  // только финальный арбитр. Пробуем только здоровых на вид (оффлайн-модемы
  // бюджет проб не жгут), зафлапавший счётчик/полночь (delta<0) сбрасывает окно.
  function _bwTotal(m) {
    let sum = 0;
    for (const p of (m.ports || [])) {
      sum += parseBwToBytes(p.bandwidth_bytes_day_in) + parseBwToBytes(p.bandwidth_bytes_day_out);
    }
    return sum;
  }

  async function _detectFrozen(byImei, now, budget) {
    let flagged = 0;
    const active = new Set(_activeRows().map(r => r.imei));   // один SELECT на прогон
    const feedKeys = new Set();
    for (const [imei, hit] of byImei) {
      const key = hit.srv + '|' + imei;
      feedKeys.add(key);
      const m = hit.m;
      const total = _bwTotal(m);
      const prev = bwTrack.get(key);
      // Уже в состоянии или территория сигнатуры 1 — тут не трогаем.
      if (active.has(imei) || _symptomatic(m)) { bwTrack.set(key, { total, at: now, frozenSince: null }); continue; }
      if (!prev) { bwTrack.set(key, { total, at: now, frozenSince: null }); continue; }
      const delta = total - prev.total;
      if (delta < 0 || delta >= _frozenBytes()) {   // сброс счётчиков (полночь/ребут) или трафик идёт
        bwTrack.set(key, { total, at: now, frozenSince: null });
        continue;
      }
      const frozenSince = prev.frozenSince || prev.at;
      bwTrack.set(key, { total, at: now, frozenSince });
      if (now - frozenSince < _frozenMinMs()) continue;
      if (!_healthy(m)) continue;                    // оффлайн/без IP — пробовать бессмысленно
      const nick = (m.modem_details || {}).NICK || imei;
      const op = _normOp((m.net_details || {}).CELLOP || '', hit.srv);
      if (!_throttleOpAllowed(op)) { bwTrack.set(key, { total, at: now, frozenSince: null }); continue; }   // оператор без троттлинга
      const clearedAt = frozenClearedAt.get(key) || 0;
      if (now - clearedAt < _frozenClearedMs()) continue;   // недавняя проба показала норму — бэкофф
      const frozenMin = Math.round((now - frozenSince) / 60000);
      const outcome = await _probeAndFlag({ srv: hit.srv, nick, imei, op, now, budget, evidence: `трафик заморожен ${frozenMin} мин` });
      if (outcome === 'cleared') { frozenClearedAt.set(key, now); bwTrack.set(key, { total, at: now, frozenSince: null }); }
      if (outcome === 'flagged') flagged++;
    }
    // Модемы, пропавшие из фида, вычищаем из трекинга.
    for (const key of bwTrack.keys()) if (!feedKeys.has(key)) bwTrack.delete(key);
    return flagged;
  }

  // Операторский уровень: ≥ sim_exhaustion_operator_ratio (дефолт 80%) симок
  // оператора на площадке в состоянии «пакет исчерпан» → ОДИН групповой алерт
  // вместо россыпи per-модем. Кулдаун 24ч — в правиле.
  function _operatorOverview(byImei) {
    const totals = new Map();     // srv|op → Set(imei) — все симки оператора в фиде
    for (const [imei, hit] of byImei) {
      const op = _normOp((hit.m.net_details || {}).CELLOP || (hit.m.modem_details || {}).OPERATOR || '', hit.srv);
      if (!op) continue;
      const k = hit.srv + '|' + op;
      if (!totals.has(k)) totals.set(k, new Set());
      totals.get(k).add(imei);
    }
    const exhausted = new Map();  // srv|op → Set(imei)
    for (const row of _activeRows()) {
      const op = _normOp(row.operator, row.server_name);
      if (!op) continue;
      const k = row.server_name + '|' + op;
      if (!exhausted.has(k)) exhausted.set(k, new Set());
      exhausted.get(k).add(row.imei);
    }
    let alertedOps = 0;
    for (const [k, set] of totals) {
      const total = set.size;
      const exN = (exhausted.get(k) || new Set()).size;
      if (total < 3 || exN / total < _opRatio()) continue;
      const sep = k.indexOf('|');
      try {
        alerts.trigger('operator_package_throttled', {
          server: k.slice(0, sep), operator: k.slice(sep + 1), exhausted: exN, total,
        });
        alertedOps++;
      } catch (e) { logger.warn('[SimExhaustion] operator alert failed: ' + e.message); }
    }
    return alertedOps;
  }

  // Re-entrancy: спидтест-пробы длинные (до 180с каждая), а тик — каждые
  // 2 мин. Второй прогон поверх незавершённого не нужен.
  let _running = false;

  async function runOnce() {
    if (!_enabled()) return { skipped: 'disabled' };
    if (_running) return { skipped: 'already_running' };
    _running = true;
    try {
    let alerted = 0, active = 0;
    const results = await fetchAllServersDataCached();
    const now = Date.now();
    _baselineCache = null;   // нормы скорости перечитываем на каждый прогон

    // Индексы живого фида: по IMEI (восстановление — модем мог переехать) и
    // по server|nick (троттлинг-кандидаты из speed_monitor адресуются ником).
    const byImei = new Map();          // imei → { srv, m }
    const byServerNick = new Map();    // server|nick → { srv, m }
    for (const data of results || []) {
      if (data._cached) continue;   // устаревший фид ничего не доказывает
      const statusArr = Array.isArray(data.status) ? data.status : [];
      for (const m of statusArr) {
        const md = m.modem_details || {};
        const imei = md.IMEI;
        const entry = { srv: data.serverName || '', m };
        if (imei && !byImei.has(imei)) byImei.set(imei, entry);
        if (md.NICK) byServerNick.set(entry.srv + '|' + md.NICK, entry);
      }
    }
    const budget = { used: 0, max: _maxProbesPerRun() };   // пробы восстановления и подтверждения троттлинга делят бюджет
    const recovered = await _checkRecoveries(byImei, now, budget);

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
        const op = _normOp(String((m.net_details || {}).CELLOP || '').trim(), srv);
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
    // Сигнатуры 2 (троттлинг по замерам) и 3 (замороженный трафик), операторский уровень.
    const throttled = await _detectThrottled(byServerNick, now, budget);
    const frozen = await _detectFrozen(byImei, now, budget);
    const operatorAlerts = _operatorOverview(byImei);
    return { symptomatic: active, alerted, recovered, throttled, frozen, operatorAlerts, tracked: state.size };
    } finally { _running = false; }
  }

  return { runOnce, _state: state, _probes: probes, _throttleCandidates: throttleCandidates, _bwTrack: bwTrack, _frozenClearedAt: frozenClearedAt };
}

module.exports = { create, isExhausted };
