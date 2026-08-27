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

const DEFAULT_NICKS = 'MD2_40,MD2_44,MD_01,MD_04,MD_10';
const RETRY_DELAY_MS = 25000;    // пауза перед повторным замером (~20–30с)
const PING_SANE_MAX_MS = 60000;  // больше минуты «пинга» — это не пинг, а мусор
// Дефолты настройки (Настройки → «Спидтесты»): speedmon_retry_dl_threshold,
// speedmon_retry_round_min, speedmon_retry_rounds, retention_speed_monitor.
const DEFAULT_RETRY_DL_THRESHOLD = 5;    // Мбит/с — ниже: замер подозрительный, один повтор
const DEFAULT_RETRY_ROUND_MIN = 5;       // перезамер неудачных каждые N минут
const DEFAULT_RETRY_ROUNDS = 10;         // ~50 мин — до следующего часового тика
const DEFAULT_RETENTION_DAYS = 60;

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

  // Резолв ников → бокс/IMEI/онлайн/оператор по всем серверам. Вызывается и
  // в начале прогона, и на каждом раунде перезамеров: модем мог вернуться
  // онлайн или переехать на другой бокс.
  async function resolveNicks(targetNicks) {
    const found = new Map();   // nick → { server, imei, isOnline, operator }
    for (const server of apiServers) {
      const isRO = (server.country || '') === 'RO';
      try {
        const status = await fetchApi(server, '/apix/show_status_json');
        for (const m of (Array.isArray(status) ? status : [])) {
          const md = m.modem_details || {};
          const nick = md.NICK;
          if (!nick || !targetNicks.includes(nick)) continue;
          const rawOp = (m.net_details && m.net_details.CELLOP) || md.OPERATOR || '';
          found.set(nick, {
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
    return found;
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
      const result = await fetchApi(f.server, `/apix/speedtest?arg=${encodeURIComponent(nick)}`, 180000);
      if (result && result.error) throw new Error(String(result.error));
      return parseSpeedtestResult(result);
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
      const TARGET_NICKS = getTargetNicks();
      // 1) Резолв ников → бокс/IMEI/онлайн/оператор по всем серверам.
      const found = await resolveNicks(TARGET_NICKS);

      // 2) Замеры — последовательно, чтобы не душить бокс параллельными
      // speedtest'ами (он и так гоняет трафик через живые симки).
      let tested = 0, failed = 0;
      // Неудачные ники уходят в pending: их перезамеряем каждые 5 минут до
      // успеха (но не дольше ~50 минут — до следующего часового тика).
      const pending = new Map();   // nick → { f|null, lastError, attempts }
      for (const nick of TARGET_NICKS) {
        const f = found.get(nick);
        if (!f || !f.isOnline) {
          const reason = !f ? 'not_found' : 'offline';
          insertStmt.run(f ? f.server.name : '', nick, f ? f.imei : '', 0, 0, 0, 0, reason, f ? f.operator : '', 0);
          logger.info(`[SpeedMonitor] ${nick}: ${reason}, пропуск замера (в очередь перезамеров)`);
          failed++;
          pending.set(nick, { f: f || null, lastError: reason, attempts: 0 });
          continue;
        }
        try {
          const { best, attempts } = await tryMeasureNick(f, nick);
          evaluateBaseline(f,nick,best.dl);
          insertStmt.run(f.server.name, nick, f.imei, best.dl, best.ul, best.ping, 1, '', f.operator, attempts);
          logger.info(`[SpeedMonitor] ${nick} (${f.server.name}): DL=${best.dl} UL=${best.ul} Ping=${best.ping} attempts=${attempts}`);
          tested++;
        } catch (e) {
          insertStmt.run(f.server.name, nick, f.imei, 0, 0, 0, 0, String(e.message || e).slice(0, 200), f.operator, e.attempts || 0);
          logger.warn(`[SpeedMonitor] ${nick} (${f.server.name}): ${e.message} (attempts=${e.attempts || 0}) — в очередь перезамеров`);
          failed++;
          pending.set(nick, { f, lastError: String(e.message || e).slice(0, 200), attempts: 0 });
        }
      }

      // 2б) Настойчивые перезамеры: каждые retryRoundMs заново резолвим
      // статусы (модем мог перезагрузиться и вернуться онлайн) и мерим тех,
      // кто ожил. Успех пишется ok-строкой в тот же часовой бакет агрегации;
      // промежуточные fail-строки не пишем — изначальная fail-строка прогона
      // уже зафиксировала сбой, лишние строки только мусорят таблицу.
      let recovered = 0;
      const maxRounds = retryRounds();
      const roundMs = retryRoundMs();
      for (let round = 1; round <= maxRounds && pending.size > 0; round++) {
        logger.info(`[SpeedMonitor] перезамер, раунд ${round}/${maxRounds}: ждём ${Math.round(roundMs / 1000)}с, в очереди ${[...pending.keys()].join(', ')}`);
        await sleep(roundMs);
        const reFound = await resolveNicks([...pending.keys()]);
        for (const [nick, p] of [...pending]) {
          const f = reFound.get(nick);
          if (!f || !f.isOnline) {
            p.f = f || p.f;
            p.lastError = !f ? 'not_found' : 'offline';
            continue;
          }
          try {
            const { best, attempts } = await tryMeasureNick(f, nick);
            evaluateBaseline(f,nick,best.dl);
            insertStmt.run(f.server.name, nick, f.imei, best.dl, best.ul, best.ping, 1, '', f.operator, attempts);
            logger.info(`[SpeedMonitor] ${nick} (${f.server.name}): восстановлен на раунде ${round} — DL=${best.dl} UL=${best.ul} Ping=${best.ping}`);
            pending.delete(nick);
            recovered++;
          } catch (e) {
            p.f = f;
            p.lastError = String(e.message || e).slice(0, 200);
            p.attempts += 1;
            logger.warn(`[SpeedMonitor] ${nick}: раунд ${round} не удался (${e.message})`);
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

  return { runSpeedMonitor, getTargetNicks, evaluateBaseline };
}

module.exports = { create, parseSpeedtestResult, speedBaselineBucket, DEFAULT_NICKS };
