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

const DEFAULT_NICKS = 'MD2_40,MD2_44,MD_01,MD_04,MD_10';
const RETENTION_DAYS = 60;
const RETRY_DL_THRESHOLD = 5;    // Мбит/с — ниже: замер подозрительный, один повтор
const RETRY_DELAY_MS = 25000;    // пауза перед повторным замером (~20–30с)
const PING_SANE_MAX_MS = 60000;  // больше минуты «пинга» — это не пинг, а мусор

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

function create(deps) {
  const { db, logger, logActivity, apiServers, fetchApi, normalizeOperator, getSetting } = deps;
  // Пауза инжектируется — тесты подсовывают мгновенный sleep.
  const sleep = typeof deps.sleep === 'function'
    ? deps.sleep
    : (ms) => new Promise(r => setTimeout(r, ms));

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

  // Re-entrancy: прогон один за раз (speedtest до 180с на модем × 5 модемов
  // последовательно — теоретически длиннее часа, второй запуск не нужен).
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
      const found = new Map();   // nick → { server, imei, isOnline, operator }
      for (const server of apiServers) {
        const isRO = (server.country || '') === 'RO';
        try {
          const status = await fetchApi(server, '/apix/show_status_json');
          for (const m of (Array.isArray(status) ? status : [])) {
            const md = m.modem_details || {};
            const nick = md.NICK;
            if (!nick || !TARGET_NICKS.includes(nick)) continue;
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

      // 2) Замеры — последовательно, чтобы не душить бокс параллельными
      // speedtest'ами (он и так гоняет трафик через живые симки).
      let tested = 0, failed = 0;
      for (const nick of TARGET_NICKS) {
        const f = found.get(nick);
        if (!f || !f.isOnline) {
          const reason = !f ? 'not_found' : 'offline';
          insertStmt.run(f ? f.server.name : '', nick, f ? f.imei : '', 0, 0, 0, 0, reason, f ? f.operator : '', 0);
          logger.info(`[SpeedMonitor] ${nick}: ${reason}, пропуск замера`);
          failed++;
          continue;
        }
        // Разовый замер бокса нестабилен — мерим с одним повтором:
        // ok=0 → ретрай; ok=1, но dl < 5 Мбит/с → ретрай, пишем лучший по dl.
        let attempts = 0;
        const measureOnce = async () => {
          attempts++;
          const result = await fetchApi(f.server, `/apix/speedtest?arg=${encodeURIComponent(nick)}`, 180000);
          if (result && result.error) throw new Error(String(result.error));
          return parseSpeedtestResult(result);
        };
        try {
          let best;
          try {
            best = await measureOnce();
          } catch (e1) {
            logger.warn(`[SpeedMonitor] ${nick}: замер не удался (${e1.message}), повтор через ${RETRY_DELAY_MS / 1000}с`);
            await sleep(RETRY_DELAY_MS);
            best = await measureOnce();   // упадёт — уйдёт во внешний catch
          }
          if (best.dl < RETRY_DL_THRESHOLD && attempts === 1) {
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
          if (!(best.dl > 0 || best.ul > 0)) throw new Error('empty_result');
          insertStmt.run(f.server.name, nick, f.imei, best.dl, best.ul, best.ping, 1, '', f.operator, attempts);
          logger.info(`[SpeedMonitor] ${nick} (${f.server.name}): DL=${best.dl} UL=${best.ul} Ping=${best.ping} attempts=${attempts}`);
          tested++;
        } catch (e) {
          insertStmt.run(f.server.name, nick, f.imei, 0, 0, 0, 0, String(e.message || e).slice(0, 200), f.operator, attempts);
          logger.warn(`[SpeedMonitor] ${nick} (${f.server.name}): ${e.message} (attempts=${attempts})`);
          failed++;
        }
      }

      // 3) Ретенция: 60 дней почасовых рядов достаточно для анализа,
      // таблица не раздувается (~120 строк/сутки при 5 никах).
      const pruned = pruneStmt.run(`-${RETENTION_DAYS} days`).changes;

      logger.info(`[SpeedMonitor] Complete: ${tested} ok, ${failed} failed (pruned ${pruned})`);
      logActivity('speedtest', 'info', 'speed_monitor', null,
        `SpeedMonitor: ${tested} ok, ${failed} failed`,
        { tested, failed, pruned, targets: TARGET_NICKS.length });
      return { tested, failed, pruned };
    } finally {
      running = false;
    }
  }

  return { runSpeedMonitor, getTargetNicks };
}

module.exports = { create, parseSpeedtestResult, DEFAULT_NICKS };
