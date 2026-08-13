'use strict';
//
// src/jobs/speed-monitor.js — почасовой замер скорости выбранных модемов.
//
// В отличие от runNightlySpeedtests (весь флот 2 раза в сутки, история —
// JSON-файл с капом 30 записей на модем), SpeedMonitor мерит МАЛЫЙ список
// ников каждый час и пишет в SQLite-таблицу speed_monitor (миграция 058):
// ряд достаточно длинный и плотный, чтобы видеть стабильность оператора
// по часам суток (какие симки убрать, какие добавить).
//
// Список ников — env SPEED_MONITOR_NICKS (через запятую), дефолт ниже.
// Ник → бокс/IMEI резолвится каждый прогон по /apix/show_status_json всех
// серверов: симка/модем могут переехать на другой бокс, привязка по нику
// это переживает. Модем оффлайн или не найден — тоже пишется строка
// (ok=0): отсутствие связи — тоже данные о стабильности.
//
// NB: каждый замер — реальный speedtest ЧЕРЕЗ симку (десятки–сотни МБ
// трафика за замер, суммарно до 5 модемов × 24 замера в сутки). Это
// осознанная цена наблюдаемости — при необходимости список ников режется
// через SPEED_MONITOR_NICKS.

const DEFAULT_NICKS = 'MD2_40,MD2_44,MD_01,MD_04,MD_10';
const RETENTION_DAYS = 60;

// Парсер ответа /apix/speedtest — копия логики parseSpeedtestResult из
// src/jobs/proxy-checks.js (та внутренняя, не экспортируется). Бокс отдаёт
// либо поля download/upload/ping (в разном регистре), либо сырой текст.
function parseSpeedtestResult(result) {
  let dl = 0, ul = 0, ping = 0;
  if (result && typeof result === 'object') {
    dl = parseFloat(result.download || result.Download || result.dl || 0);
    ul = parseFloat(result.upload || result.Upload || result.ul || 0);
    ping = parseFloat(result.ping || result.Ping || result.latency || 0);
    if (result.raw && typeof result.raw === 'string') {
      const dlMatch = result.raw.match(/download[:\s]*([\d.]+)/i);
      const ulMatch = result.raw.match(/upload[:\s]*([\d.]+)/i);
      const pingMatch = result.raw.match(/ping[:\s]*([\d.]+)/i);
      if (dlMatch) dl = parseFloat(dlMatch[1]);
      if (ulMatch) ul = parseFloat(ulMatch[1]);
      if (pingMatch) ping = parseFloat(pingMatch[1]);
    }
  }
  return { dl, ul, ping };
}

function create(deps) {
  const { db, logger, logActivity, apiServers, fetchApi } = deps;

  const TARGET_NICKS = (process.env.SPEED_MONITOR_NICKS || DEFAULT_NICKS)
    .split(',').map(s => s.trim()).filter(Boolean);

  const insertStmt = db.prepare(`INSERT INTO speed_monitor
    (server, nick, imei, download, upload, ping, ok, error)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
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
      // 1) Резолв ников → бокс/IMEI/онлайн по всем серверам.
      const found = new Map();   // nick → { server, imei, isOnline }
      for (const server of apiServers) {
        try {
          const status = await fetchApi(server, '/apix/show_status_json');
          for (const m of (Array.isArray(status) ? status : [])) {
            const nick = m.modem_details && m.modem_details.NICK;
            if (!nick || !TARGET_NICKS.includes(nick)) continue;
            found.set(nick, {
              server,
              imei: (m.modem_details && m.modem_details.IMEI) || '',
              isOnline: !!(m.net_details && m.net_details.IS_ONLINE === 'yes'),
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
          insertStmt.run(f ? f.server.name : '', nick, f ? f.imei : '', 0, 0, 0, 0, reason);
          logger.info(`[SpeedMonitor] ${nick}: ${reason}, пропуск замера`);
          failed++;
          continue;
        }
        try {
          const result = await fetchApi(f.server, `/apix/speedtest?arg=${encodeURIComponent(nick)}`, 180000);
          if (result && result.error) throw new Error(String(result.error));
          const { dl, ul, ping } = parseSpeedtestResult(result);
          insertStmt.run(f.server.name, nick, f.imei, dl, ul, ping, 1, '');
          logger.info(`[SpeedMonitor] ${nick} (${f.server.name}): DL=${dl} UL=${ul} Ping=${ping}`);
          tested++;
        } catch (e) {
          insertStmt.run(f.server.name, nick, f.imei, 0, 0, 0, 0, String(e.message || e).slice(0, 200));
          logger.warn(`[SpeedMonitor] ${nick} (${f.server.name}): ${e.message}`);
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

  return { runSpeedMonitor, TARGET_NICKS };
}

module.exports = { create, parseSpeedtestResult, DEFAULT_NICKS };
