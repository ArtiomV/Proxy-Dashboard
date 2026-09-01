'use strict';
//
// src/jobs/speed-monitor.js — почасовой замер скорости выбранных модемов.
//
// runNightlySpeedtests (весь флот 2 раза в сутки, история —
// JSON-файл с капом 30 записей на модем) отключён 2026-08-13: SpeedMonitor
// мерит МАЛЫЙ список ников каждый час и пишет в SQLite-таблицу speed_monitor
// (миграция 058):
// ряд достаточно длинный и плотный, чтобы видеть стабильность оператора
// по часам суток (какие симки убрать, какие добавить).
//
// Список ников — настройка speedtest_modems (Настройки → «Спидтесты»,
// CSV через запятую), читается на каждый прогон: правки применяются без
// рестарта. env SPEED_MONITOR_NICKS — override для стендов/тестов, дефолт
// ниже. Ник → бокс/IMEI резолвится каждый прогон по /apix/show_status_json
// всех серверов: симка/модем могут переехать на другой бокс, привязка по
// нику это переживает. Модем оффлайн или не найден — тоже пишется строка
// (ok=0): отсутствие связи — тоже данные о стабильности.
//
// NB: каждый замер — реальный speedtest ЧЕРЕЗ симку (десятки–сотни МБ
// трафика за замер, суммарно до 5 модемов × 24 замера в сутки). Это
// осознанная цена наблюдаемости — при необходимости список ников режется
// через настройку speedtest_modems.
//
// 2026-08-13 — стабилизация замера. Разовый прогон /apix/speedtest бокса
// крайне нестабилен (в проде один и тот же модем за полчаса давал dl 0.99
// и 38.86 Мбит/с — маленькая выборка/погода в сети, не путаница единиц).
// Поэтому: если первый замер ok, но dl < RETRY_DL_THRESHOLD — ОДИН повтор
// через RETRY_DELAY_MS, в БД пишется ЛУЧШИЙ из двух (по dl); ошибка замера
// (ok=0) — тоже один ретрай. При dl >= порога повтор не делаем: каждый
// спидтест — живой трафик симки. Число попыток пишется в колонку attempts.
// Результат dl=0 И ul=0 — не «ноль оператора», а непроведённый тест бокса:
// пишется ok=0/error='empty_result' независимо от числа попыток.
//
// 2026-08-14 — настойчивые перезамеры. Симка в перезагрузке/вне сети на
// момент часового прогона раньше давала дыру в графике на весь час. Теперь
// все неудачные ники уходят в очередь pending и перезамеряются каждые
// RETRY_ROUND_MS (5 мин) до успеха, максимум RETRY_MAX_ROUNDS раундов
// (~50 мин — до следующего часового тика, который во время длинного прогона
// anyway пропускается re-entrancy guard'ом). Каждый раунд заново резолвит
// show_status_json: модем мог вернуться онлайн или переехать на другой бокс.
// Успешный перезамер пишет ok-строку в ТОТ ЖЕ часовой бакет агрегации
// (GROUP BY час МСК), так что дыра в выдаче закрывается задним числом.
// Промежуточные fail-строки на раундах НЕ пишем — не засоряем таблицу,
// изначальная fail-строка прогона уже зафиксировала факт сбоя.
//
// 2026-09-01 — авто-режим и защита от массового сбоя бокса.
// Цель мониторинга — «скорость оператора на локации», конкретные модемы
// не важны. Настройка speedtest_modems='auto': цели выбираются на каждый
// прогон — до speedmon_per_operator (дефолт 2) онлайн-модемов на пару
// (сервер, оператор), приоритет никам со свежей историей (не рвётся норма).
// Если целевой модем оффлайн/сбоит — замеряем подмену: онлайн-модем того же
// (сервер, оператор) из пула, строка пишется под ником подмены.
// Circuit breaker: 3 подряд сбоя замера на одном боксе (инцидент 01.09 —
// сломанный DNS на боксе давал empty_result у всех модемов, 11 ников по
// ~2 мин × раунды перезамеров съели часовые тики 03:00 и 04:00) → бокс
// считаем сломанным: остальные цели пропускаем мгновенно (fail-строка
// 'box_outage'), в раунды бокс идёт одним пробником, шлём алерт
// speedtest_box_outage. Прогон ограничен бюджетом speedmon_max_run_min
// (дефолт 20 мин) — перезамеры никогда не сдвигают следующий часовой тик.

const DEFAULT_NICKS = 'MD2_40,MD2_44,MD_01,MD_04,MD_10';
const RETRY_DELAY_MS = 25000;    // пауза перед повторным замером (~20–30с)
const PING_SANE_MAX_MS = 60000;  // больше минуты «пинга» — это не пинг, а мусор
// Дефолты настройки (Настройки → «Спидтесты»): speedmon_retry_dl_threshold,
// speedmon_retry_round_min, speedmon_retry_rounds, retention_speed_monitor.
const DEFAULT_RETRY_DL_THRESHOLD = 5;    // Мбит/с — ниже: замер подозрительный, один повтор
const DEFAULT_RETRY_ROUND_MIN = 5;       // перезамер неудачных каждые N минут
const DEFAULT_RETRY_ROUNDS = 10;         // ~50 мин — до следующего часового тика
const DEFAULT_RETENTION_DAYS = 60;
const DEFAULT_PER_OPERATOR = 2;   // авто-режим: столько модемов на (сервер, оператор)
const DEFAULT_MAX_RUN_MIN = 20;   // потолок прогона: перезамеры не сдвигают часовой тик
const CB_FAIL_THRESHOLD = 3;      // подряд сбоев замера на боксе → спидтест бокса сломан

// Парсер ответа /apix/speedtest — копия логики parseSpeedtestResult из
// src/jobs/proxy-checks.js (та внутренняя, не экспортируется). Бокс отдаёт
// либо поля download/upload/ping (в разном регистре), либо сырой текст.
// 2026-08-13: ping НЕ берём из служебных полей (latency/timeout — оттуда
// в БД утекал таймаут fetchApi, 180000 мс → ping=1800000.0) и отсекаем
// нефизичные значения: не распарсился — пишем 0, а не мусор.
function parseSpeedtestResult(result) {
  let dl = 0, ul = 0, ping = 0;
  if (result && typeof result === 'object') {
    dl = parseFloat(result.download || result.Download || result.dl || 0);
    ul = parseFloat(result.upload || result.Upload || result.ul || 0);
    ping = parseFloat(result.ping || result.Ping || 0);
    if (result.raw && typeof result.raw === 'string') {
      const dlMatch = result.raw.match(/download[:\s]*([\d.]+)/i);
      const ulMatch = result.raw.match(/upload[:\s]*([\d.]+)/i);
      const pingMatch = result.raw.match(/ping[:\s]*([\d.]+)/i);
      if (dlMatch) dl = parseFloat(dlMatch[1]);
      if (ulMatch) ul = parseFloat(ulMatch[1]);
      if (pingMatch) ping = parseFloat(pingMatch[1]);
    }
  }
  if (!isFinite(ping) || ping < 0 || ping > PING_SANE_MAX_MS) ping = 0;
  return { dl, ul, ping };
}

// Бакет нормы: тот же локальный час и тот же тип дня. Так утренние/вечерние
// просадки мобильной сети не сравниваются с ночью, а выходные — с буднями.
function speedBaselineBucket(value, timezone = 'Europe/Moscow') {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  let parts;
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone || 'Europe/Moscow', weekday: 'short', hour: '2-digit', hourCycle: 'h23',
    }).formatToParts(date);
  } catch (_) {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Europe/Moscow', weekday: 'short', hour: '2-digit', hourCycle: 'h23',
    }).formatToParts(date);
  }
  const pick = type => (parts.find(part => part.type === type) || {}).value;
  const weekday = pick('weekday');
  return { hour: Number(pick('hour')), dayType: weekday === 'Sat' || weekday === 'Sun' ? 'weekend' : 'weekday' };
}

function parseSqliteUtc(value) {
  const text = String(value || '');
  return new Date(/[zZ]|[+-]\d\d:\d\d$/.test(text) ? text : text.replace(' ', 'T') + 'Z');
}

function create(deps) {
  const { db, logger, logActivity, apiServers, fetchApi, normalizeOperator, getSetting, alerts } = deps;
  // Пауза инжектируется — тесты подсовывают мгновенный sleep.
  const sleep = typeof deps.sleep === 'function'
    ? deps.sleep
    : (ms) => new Promise(r => setTimeout(r, ms));
  // Параметры перезамеров: deps-override для тестов, иначе настройка
  // (читается на КАЖДЫЙ прогон — правки применяются без рестарта).
  function retryRounds() {
    if (Number.isInteger(deps.retryRounds)) return deps.retryRounds;
    const v = getSetting ? parseInt(getSetting('speedmon_retry_rounds', DEFAULT_RETRY_ROUNDS)) : DEFAULT_RETRY_ROUNDS;
    return Number.isInteger(v) && v >= 0 ? v : DEFAULT_RETRY_ROUNDS;
  }
  function retryRoundMs() {
    if (Number.isFinite(deps.retryRoundMs)) return deps.retryRoundMs;
    const v = getSetting ? parseInt(getSetting('speedmon_retry_round_min', DEFAULT_RETRY_ROUND_MIN)) : DEFAULT_RETRY_ROUND_MIN;
    return (Number.isInteger(v) && v >= 1 ? v : DEFAULT_RETRY_ROUND_MIN) * 60000;
  }
  function retryDlThreshold() {
    const v = getSetting ? parseFloat(getSetting('speedmon_retry_dl_threshold', DEFAULT_RETRY_DL_THRESHOLD)) : DEFAULT_RETRY_DL_THRESHOLD;
    return Number.isFinite(v) && v > 0 ? v : DEFAULT_RETRY_DL_THRESHOLD;
  }
  function retentionDays() {
    const v = getSetting ? parseInt(getSetting('retention_speed_monitor', DEFAULT_RETENTION_DAYS)) : DEFAULT_RETENTION_DAYS;
    return Number.isInteger(v) && v >= 7 ? v : DEFAULT_RETENTION_DAYS;
  }
  function perOperator() {
    if (Number.isInteger(deps.perOperator)) return deps.perOperator;
    const v = getSetting ? parseInt(getSetting('speedmon_per_operator', DEFAULT_PER_OPERATOR)) : DEFAULT_PER_OPERATOR;
    return Number.isInteger(v) && v >= 1 && v <= 5 ? v : DEFAULT_PER_OPERATOR;
  }
  function maxRunMs() {
    if (Number.isFinite(deps.maxRunMs)) return deps.maxRunMs;
    const v = getSetting ? parseInt(getSetting('speedmon_max_run_min', DEFAULT_MAX_RUN_MIN)) : DEFAULT_MAX_RUN_MIN;
    return (Number.isInteger(v) && v >= 5 ? v : DEFAULT_MAX_RUN_MIN) * 60000;
  }
  // Режим 'auto' — явное значение настройки; пустая настройка по-прежнему
  // означает дефолтный список (обратная совместимость).
  function isAutoMode() {
    if (ENV_NICKS.length) return false;
    const csv = getSetting ? getSetting('speedtest_modems', DEFAULT_NICKS) : DEFAULT_NICKS;
    return String(csv || '').trim().toLowerCase() === 'auto';
  }

  // env-override фиксируется на create() (тесты удаляют env сразу после
  // создания джобы); настройка speedtest_modems читается на каждый прогон.
  const ENV_NICKS = String(process.env.SPEED_MONITOR_NICKS || '')
    .split(',').map(s => s.trim()).filter(Boolean);

  function getTargetNicks() {
    if (ENV_NICKS.length) return ENV_NICKS;
    const csv = getSetting ? getSetting('speedtest_modems', DEFAULT_NICKS) : DEFAULT_NICKS;
    const list = String(csv || '').split(',').map(s => s.trim()).filter(Boolean);
    return list.length ? list : DEFAULT_NICKS.split(',');
  }

  const insertStmt = db.prepare(`INSERT INTO speed_monitor
    (server, nick, imei, download, upload, ping, ok, error, operator, attempts)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const pruneStmt = db.prepare(
    "DELETE FROM speed_monitor WHERE ts < datetime('now', ?)");
  let baselineGet=null,baselineUpsert=null;
  try {
    baselineGet=db.prepare('SELECT * FROM modem_speed_baseline_state WHERE server=? AND nick=?');
    baselineUpsert=db.prepare(`INSERT INTO modem_speed_baseline_state
      (server,nick,operator,baseline_dl,current_dl,sample_count,consecutive_bad,degraded,degraded_since,
       baseline_hour,day_type,baseline_window_days,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'))
      ON CONFLICT(server,nick) DO UPDATE SET operator=excluded.operator,baseline_dl=excluded.baseline_dl,
      current_dl=excluded.current_dl,sample_count=excluded.sample_count,consecutive_bad=excluded.consecutive_bad,
      degraded=excluded.degraded,degraded_since=excluded.degraded_since,baseline_hour=excluded.baseline_hour,
      day_type=excluded.day_type,baseline_window_days=excluded.baseline_window_days,updated_at=datetime('now')`);
  } catch (_) { /* older/minimal test schemas: baseline evaluation is optional */ }

  const baselineWindowDays=56;
  const now = typeof deps.now === 'function' ? deps.now : () => new Date();
  function evaluateBaseline(f,nick,download){
    if(!baselineGet||!baselineUpsert||!alerts||!(download>0))return null;
    const measuredAt=now(),timezone=(f.server&&f.server.tz)||'Europe/Moscow';
    const bucket=speedBaselineBucket(measuredAt,timezone);
    const history=db.prepare("SELECT download,ts FROM speed_monitor WHERE server=? AND nick=? AND ok=1 AND download>0 AND ts>=datetime('now','-56 days') ORDER BY ts").all(f.server.name,nick);
    const rows=history.filter(row=>{const candidate=speedBaselineBucket(parseSqliteUtc(row.ts),timezone);return candidate&&bucket&&candidate.hour===bucket.hour&&candidate.dayType===bucket.dayType;});
    const minSamples=Math.max(6,Math.min(72,Number(getSetting('speed_baseline_min_samples',12))||12));
    const values=rows.map(r=>Number(r.download)).filter(Number.isFinite);
    const baseline=values.length?values.reduce((sum,value)=>sum+value,0)/values.length:null;
    const prev=baselineGet.get(f.server.name,nick)||{};
    if(baseline==null||rows.length<minSamples){
      baselineUpsert.run(f.server.name,nick,f.operator||'',baseline,download,rows.length,0,Number(prev.degraded||0),prev.degraded_since||null,bucket&&bucket.hour,bucket&&bucket.dayType,baselineWindowDays);
      return {ready:false,samples:rows.length,baseline,bucket};
    }
    const ratio=Math.max(.2,Math.min(.9,Number(getSetting('speed_baseline_drop_ratio',.5))||.5));
    const bad=download<=baseline*ratio;
    const consecutive=bad?Number(prev.consecutive_bad||0)+1:0;
    let degraded=Number(prev.degraded||0),since=prev.degraded_since||null;
    if(bad&&consecutive>=2&&!degraded){
      degraded=1;since=new Date().toISOString();
      alerts.trigger('modem_speed_baseline_degraded',{server:f.server.name,nick,imei:f.imei,operator:f.operator,
        current:Math.round(download*10)/10,baseline:Math.round(baseline*10)/10,drop_pct:Math.round((1-download/baseline)*100),samples:rows.length,
        baseline_hour:bucket.hour,day_type:bucket.dayType,baseline_scope:(bucket.dayType==='weekend'?'выходные':'будни')+' · '+String(bucket.hour).padStart(2,'0')+':00'});
    }else if(degraded&&download>=baseline*.75){
      degraded=0;since=null;
      alerts.trigger('modem_speed_baseline_recovered',{server:f.server.name,nick,imei:f.imei,operator:f.operator,
        current:Math.round(download*10)/10,baseline:Math.round(baseline*10)/10,
        baseline_scope:(bucket.dayType==='weekend'?'выходные':'будни')+' · '+String(bucket.hour).padStart(2,'0')+':00'});
    }
    baselineUpsert.run(f.server.name,nick,f.operator||'',baseline,download,rows.length,consecutive,degraded,since,bucket.hour,bucket.dayType,baselineWindowDays);
    return {ready:true,samples:rows.length,baseline,current:download,bad,degraded:!!degraded,consecutive,bucket};
  }

  // Полный снимок флота: nick → { server, imei, isOnline, operator } по ВСЕМ
  // модемам всех серверов. Раньше резолвились только целевые ники — для
  // авто-режима и подмены модема того же оператора нужен полный список.
  async function fetchFleet() {
    const fleet = new Map();
    for (const server of apiServers) {
      const isRO = (server.country || '') === 'RO';
      try {
        const status = await fetchApi(server, '/apix/show_status_json');
        for (const m of (Array.isArray(status) ? status : [])) {
          const md = m.modem_details || {};
          const nick = md.NICK;
          if (!nick) continue;
          const rawOp = (m.net_details && m.net_details.CELLOP) || md.OPERATOR || '';
          fleet.set(nick, {
            server,
            imei: md.IMEI || '',
            isOnline: !!(m.net_details && m.net_details.IS_ONLINE === 'yes'),
            // Оператор на момент замера — для графика «где какой оператор».
            operator: normalizeOperator ? normalizeOperator(rawOp, isRO) : rawOp,
          });
        }
      } catch (e) {
        logger.warn(`[SpeedMonitor] ${server.name}: status fetch failed: ${e.message}`);
      }
    }
    return fleet;
  }

  // Цели прогона. Явный список (настройка/env) — как раньше, ник может быть
  // не найден (f=null → not_found). Режим 'auto': до N онлайн-модемов на
  // каждую пару (сервер, оператор) — цель мониторинга «скорость оператора на
  // локации», конкретные модемы не важны. Приоритет — никам со свежей
  // историей в speed_monitor (не рвётся 56-дневная норма evaluateBaseline).
  function planTargets(fleet) {
    if (!isAutoMode()) return getTargetNicks().map(nick => ({ nick, f: fleet.get(nick) || null }));
    const recent = new Set();
    try {
      for (const r of db.prepare("SELECT server, nick FROM speed_monitor WHERE ts >= datetime('now','-7 days') GROUP BY server, nick").all()) {
        recent.add(r.server + '|' + r.nick);
      }
    } catch (_) { /* минимальная тестовая схема без таблицы — просто без приоритета */ }
    const groups = new Map();   // 'server|operator' → [{ nick, f }]
    for (const [nick, f] of fleet) {
      if (!f.isOnline || !f.operator) continue;
      const key = f.server.name + '|' + f.operator;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push({ nick, f });
    }
    const targets = [];
    const chosen = new Set();
    for (const [key, arr] of [...groups.entries()].sort()) {
      const srvName = key.slice(0, key.indexOf('|'));
      arr.sort((a, b) => {
        const ar = recent.has(srvName + '|' + a.nick) ? 0 : 1;
        const br = recent.has(srvName + '|' + b.nick) ? 0 : 1;
        return ar - br || a.nick.localeCompare(b.nick);
      });
      for (const t of arr.slice(0, perOperator())) {
        if (!chosen.has(t.nick)) { chosen.add(t.nick); targets.push(t); }
      }
    }
    return targets;
  }

  // Пул подмены: онлайн-модемы того же (сервер, оператор), не выбранные
  // целями. Если целевой модем оффлайн/сбоит — мерим подмену: нас интересует
  // оператор на локации, а не конкретная симка.
  function buildSubPool(fleet, targets) {
    const chosen = new Set(targets.map(t => t.nick));
    const pool = new Map();   // 'server|operator' → [{ nick, f }]
    for (const [nick, f] of fleet) {
      if (!f.isOnline || !f.operator || chosen.has(nick)) continue;
      const key = f.server.name + '|' + f.operator;
      if (!pool.has(key)) pool.set(key, []);
      pool.get(key).push({ nick, f });
    }
    return pool;
  }

  // Один вызов спидтеста бокса — общий для основного замера и подмены.
  async function measureOnceRaw(server, nick) {
    const result = await fetchApi(server, `/apix/speedtest?arg=${encodeURIComponent(nick)}`, 180000);
    if (result && result.error) throw new Error(String(result.error));
    return parseSpeedtestResult(result);
  }

  // Одиночный замер подмены: один вызов, без ретрая по низкому dl (экономим
  // трафик чужой симки) — годится любой ненулевой результат.
  async function measureSubstitute(fSub, nick) {
    const best = await measureOnceRaw(fSub.server, nick);
    if (!(best.dl > 0 || best.ul > 0)) throw new Error('empty_result');
    return best;
  }

  // Один замер ника с учётом нестабильности бокса: ok=0 → ретрай через
  // RETRY_DELAY_MS; ok=1, но dl < retryDlThreshold() → один повтор, берём
  // лучший по dl. Возвращает { best, attempts } либо бросает ошибку
  // (число совершённых попыток при этом — в err.attempts).
  async function measureNick(f, nick) {
    const dlThreshold = retryDlThreshold();
    let attempts = 0;
    const measureOnce = async () => {
      attempts++;
      return measureOnceRaw(f.server, nick);
    };
    let best;
    try {
      best = await measureOnce();
    } catch (e1) {
      logger.warn(`[SpeedMonitor] ${nick}: замер не удался (${e1.message}), повтор через ${RETRY_DELAY_MS / 1000}с`);
      await sleep(RETRY_DELAY_MS);
      best = await measureOnce();   // упадёт — уйдёт наружу
    }
    if (best.dl < dlThreshold && attempts === 1) {
      await sleep(RETRY_DELAY_MS);
      try {
        const second = await measureOnce();
        if (second.dl > best.dl) best = second;
      } catch (e2) {
        logger.warn(`[SpeedMonitor] ${nick}: повторный замер не удался: ${e2.message}`);
      }
    }
    // 2026-08-13: dl=0 И ul=0 — бокс не провёл тест (в проде кластеры
    // таких строк у нескольких модемов сразу — сбой спидтеста на боксе).
    // Это неуспешный замер, а не «оператор дал ноль»: ok=1 только при
    // ненулевом dl или ul, иначе нули роняют средние и график.
    if (!(best.dl > 0 || best.ul > 0)) {
      const err = new Error('empty_result');
      err.attempts = attempts;
      throw err;
    }
    return { best, attempts };
  }

  // Обёртка measureNick: при броске проставляет err.attempts, чтобы
  // вызывающий мог записать реальное число попыток в fail-строку.
  async function tryMeasureNick(f, nick) {
    try {
      return await measureNick(f, nick);
    } catch (e) {
      if (!Number.isInteger(e.attempts)) e.attempts = 2; // 1-я попытка + её ретрай
      throw e;
    }
  }

  // Re-entrancy: прогон один за раз (speedtest до 180с на модем × N модемов
  // последовательно + до ~50 мин раундов перезамеров — второй запуск не
  // нужен; часовой тик во время длинного прогона пропускается осознанно:
  // текущий прогон и есть «замер этого часа», добирающий отставших).
  let running = false;

  async function runSpeedMonitor() {
    if (running) {
      logger.info('[SpeedMonitor] Already running, skipping...');
      return { skipped: 'already_running' };
    }
    running = true;
    try {
      const deadline = Date.now() + maxRunMs();
      // 1) Полный снимок флота → цели прогона (+ пул подмены по операторам).
      const fleet = await fetchFleet();
      const targets = planTargets(fleet);
      const subPool = buildSubPool(fleet, targets);
      const TARGET_NICKS = targets.map(t => t.nick);
      if (isAutoMode()) {
        logger.info(`[SpeedMonitor] авто-режим: ${TARGET_NICKS.length} целей (до ${perOperator()} на оператора локации): ${TARGET_NICKS.join(', ')}`);
      }

      // Circuit breaker (01.09): CB_FAIL_THRESHOLD подряд сбоев замера на одном
      // боксе — сломан сам спидтест бокса (DNS/маршрутизация), а не модемы.
      // Остальные цели бокса пропускаем мгновенно (fail-строка 'box_outage'),
      // в раунды перезамеров бокс идёт одним пробником — иначе 11 ников по
      // ~2 мин × раунды блокировали часовые тики и давали дыры в данных.
      const broken = new Set();        // server.name с массовым сбоем
      const failStreak = new Map();    // server.name → подряд сбоев замера
      const noteOk = sn => failStreak.set(sn, 0);
      const noteFail = sn => {
        const n = (failStreak.get(sn) || 0) + 1;
        failStreak.set(sn, n);
        if (n >= CB_FAIL_THRESHOLD && !broken.has(sn)) {
          broken.add(sn);
          logger.error(`[SpeedMonitor] ${sn}: ${CB_FAIL_THRESHOLD} подряд сбоев замера — спидтест на боксе сломан, остальные цели пропущены до восстановления пробника`);
          try { if (alerts) alerts.trigger('speedtest_box_outage', { server: sn, fails: n }); } catch (_) { /* best-effort */ }
        }
      };

      // Подмена: до 2 онлайн-модемов того же (сервер, оператор) из пула.
      // Успех пишется под ником подмены — данные об операторе локации есть,
      // даже когда целевая симка уехала/легла. true = кто-то замерился.
      async function trySubstitutes(t, pool) {
        const key = t.f.server.name + '|' + t.f.operator;
        for (const s of (pool.get(key) || []).slice(0, 2)) {
          try {
            const best = await measureSubstitute(s.f, s.nick);
            evaluateBaseline(s.f, s.nick, best.dl);
            insertStmt.run(s.f.server.name, s.nick, s.f.imei, best.dl, best.ul, best.ping, 1, '', s.f.operator, 1);
            logger.info(`[SpeedMonitor] ${t.nick} → подмена ${s.nick} (${s.f.server.name}, ${s.f.operator}): DL=${best.dl} UL=${best.ul} Ping=${best.ping}`);
            noteOk(s.f.server.name);
            return true;
          } catch (e) {
            logger.warn(`[SpeedMonitor] подмена ${s.nick} за ${t.nick} не удалась: ${e.message}`);
            noteFail(s.f.server.name);
          }
        }
        return false;
      }

      // 2) Замеры — последовательно, чтобы не душить бокс параллельными
      // speedtest'ами (он и так гоняет трафик через живые симки).
      let tested = 0, failed = 0;
      // Неудачные ники уходят в pending: их перезамеряем каждые 5 минут до
      // успеха (но не дольше бюджета прогона — до следующего часового тика).
      const pending = new Map();   // nick → { f|null, serverName, lastError, attempts }
      for (const t of targets) {
        const { nick } = t;
        const f = t.f;
        if (!f || !f.isOnline) {
          // Оффлайн: сперва подмена тем же оператором (not_found — без
          // контекста сервера, подменять нечего).
          if (f && f.operator && !broken.has(f.server.name) && await trySubstitutes(t, subPool)) { tested++; continue; }
          const reason = !f ? 'not_found' : (broken.has(f.server.name) ? 'box_outage' : 'offline');
          insertStmt.run(f ? f.server.name : '', nick, f ? f.imei : '', 0, 0, 0, 0, reason, f ? f.operator : '', 0);
          logger.info(`[SpeedMonitor] ${nick}: ${reason}, пропуск замера (в очередь перезамеров)`);
          failed++;
          pending.set(nick, { f: f || null, serverName: f ? f.server.name : '', lastError: reason, attempts: 0 });
          continue;
        }
        if (broken.has(f.server.name)) {
          insertStmt.run(f.server.name, nick, f.imei, 0, 0, 0, 0, 'box_outage', f.operator, 0);
          logger.warn(`[SpeedMonitor] ${nick} (${f.server.name}): box_outage — замер пропущен, бокс в блокировке`);
          failed++;
          pending.set(nick, { f, serverName: f.server.name, lastError: 'box_outage', attempts: 0 });
          continue;
        }
        try {
          const { best, attempts } = await tryMeasureNick(f, nick);
          evaluateBaseline(f, nick, best.dl);
          insertStmt.run(f.server.name, nick, f.imei, best.dl, best.ul, best.ping, 1, '', f.operator, attempts);
          logger.info(`[SpeedMonitor] ${nick} (${f.server.name}): DL=${best.dl} UL=${best.ul} Ping=${best.ping} attempts=${attempts}`);
          noteOk(f.server.name);
          tested++;
        } catch (e) {
          noteFail(f.server.name);
          // Подмена тем же оператором — пока бокс не признан сломанным.
          if (f.operator && !broken.has(f.server.name) && await trySubstitutes(t, subPool)) { tested++; continue; }
          // Этот ник реально мерили — в строке его честная ошибка, даже если
          // именно она добила streak и перевела бокс в box_outage.
          const errText = String(e.message || e).slice(0, 200);
          insertStmt.run(f.server.name, nick, f.imei, 0, 0, 0, 0, errText, f.operator, e.attempts || 0);
          logger.warn(`[SpeedMonitor] ${nick} (${f.server.name}): ${e.message} (attempts=${e.attempts || 0}) — в очередь перезамеров`);
          failed++;
          pending.set(nick, { f, serverName: f.server.name, lastError: errText, attempts: 0 });
        }
      }

      // 2б) Настойчивые перезамеры: каждые retryRoundMs заново резолвим
      // статусы (модем мог перезагрузиться и вернуться онлайн) и мерим тех,
      // кто ожил. Успех пишется ok-строкой в тот же часовой бакет агрегации;
      // промежуточные fail-строки не пишем — изначальная fail-строка прогона
      // уже зафиксировала сбой, лишние строки только мусорят таблицу.
      // Сломанный бокс мерим одним пробником за раунд; пробник ожил — бокс
      // разблокируется и остальные его ники добираются в этом же раунде.
      let recovered = 0;
      const maxRounds = retryRounds();
      const roundMs = retryRoundMs();
      for (let round = 1; round <= maxRounds && pending.size > 0; round++) {
        if (Date.now() + roundMs > deadline) {
          logger.info('[SpeedMonitor] бюджет времени прогона исчерпан — перезамеры стоп, следующий часовой тик не сдвигаем');
          break;
        }
        logger.info(`[SpeedMonitor] перезамер, раунд ${round}/${maxRounds}: ждём ${Math.round(roundMs / 1000)}с, в очереди ${[...pending.keys()].join(', ')}`);
        await sleep(roundMs);
        const reFleet = await fetchFleet();
        const rePool = buildSubPool(reFleet, targets);
        const probed = new Set();   // сломанный бокс: один пробник на раунд
        for (const [nick, p] of [...pending]) {
          const f = reFleet.get(nick) || p.f;
          if (f) { p.f = f; p.serverName = f.server.name; }
          if (!f || !f.isOnline) {
            p.lastError = !f ? 'not_found' : 'offline';
            continue;
          }
          if (broken.has(f.server.name)) {
            if (probed.has(f.server.name)) continue;
            probed.add(f.server.name);
          }
          try {
            const { best, attempts } = await tryMeasureNick(f, nick);
            evaluateBaseline(f, nick, best.dl);
            insertStmt.run(f.server.name, nick, f.imei, best.dl, best.ul, best.ping, 1, '', f.operator, attempts);
            logger.info(`[SpeedMonitor] ${nick} (${f.server.name}): восстановлен на раунде ${round} — DL=${best.dl} UL=${best.ul} Ping=${best.ping}`);
            pending.delete(nick);
            recovered++;
            noteOk(f.server.name);
            broken.delete(f.server.name);   // пробник ожил → бокс снова в строю
          } catch (e) {
            p.lastError = String(e.message || e).slice(0, 200);
            p.attempts += 1;
            noteFail(f.server.name);
            logger.warn(`[SpeedMonitor] ${nick}: раунд ${round} не удался (${e.message})`);
            // Подмена в раунде — один модем, одна попытка.
            if (!broken.has(f.server.name) && f.operator) {
              if (await trySubstitutes({ nick, f }, rePool)) {
                pending.delete(nick);
                recovered++;
              }
            }
          }
        }
      }
      if (pending.size > 0) {
        logger.warn(`[SpeedMonitor] перезамеры исчерпаны, остались без данных: ${[...pending.entries()].map(([n, p]) => `${n}(${p.lastError})`).join(', ')}`);
      }

      // 3) Ретенция: retention_speed_monitor дней почасовых рядов (дефолт 60)
      // достаточно для анализа, таблица не раздувается (~120 строк/сутки при 5 никах).
      const pruned = pruneStmt.run(`-${retentionDays()} days`).changes;

      const stillFailed = failed - recovered;
      logger.info(`[SpeedMonitor] Complete: ${tested} ok, ${failed} failed, ${recovered} recovered (pruned ${pruned})`);
      logActivity('speedtest', 'info', 'speed_monitor', null,
        `SpeedMonitor: ${tested} ok, ${failed} failed, ${recovered} recovered`,
        { tested, failed, recovered, stillFailed, pruned, targets: TARGET_NICKS.length });
      return { tested, failed, recovered, pruned };
    } finally {
      running = false;
    }
  }

  return { runSpeedMonitor, getTargetNicks, evaluateBaseline, planTargets, isAutoMode };
}

module.exports = { create, parseSpeedtestResult, speedBaselineBucket, DEFAULT_NICKS };
