'use strict';
//
// src/jobs/server-metrics.js — периодический снимок загрузки ProxySmart-боксов
// (таблица server_metrics, миграция 070) для блока «Загрузка серверов» на
// вкладке «Дашборд». Два источника с fallback:
//   1) SSH (osLogin/osPassword/publicIp из конфига сервера, порт 2222 → 22) —
//      cpu/load/mem/swap/disk/temp/uptime одной удалённой командой. С сервера
//      дашборда SSH сейчас закрыт файрволом боксов — джоба это переживает
//      молча (info-лог, не warn: это штатный режим, а не сбой) и добирает
//      источник 2.
//   2) HTTP-панель бокса /system_status (proxyConf.getPage — тот же обход
//      логин-стены, что у /conf/*) — conns/rps/mongo_ok/usb_errors/дрейф часов.
// Мерж: SSH-поля приоритетнее, HTTP заполняет своё. Даже когда не собралось
// ничего, пишется строка с error — отсутствие связи тоже данные.
// Ретенция 7 дней, прун в конце прогона. Парсеры — чистые экспортируемые
// функции (module.exports ниже) для юнит-тестов.

const RETENTION_DAYS = 7;
const SSH_TIMEOUT_MS = 10000;
const SSH_PORTS = [2222, 22];
const predictive = require('../monitoring/predictive');

// Одна удалённая команда: два снимка агрегированной строки /proc/stat с
// паузой (дельта → cpu%), loadavg, free -m, df -m /, uptime, термозоны +
// lm-sensors (если установлен). Секции разделены строкой '---'.
const SSH_CMD = "grep '^cpu ' /proc/stat; sleep 1; grep '^cpu ' /proc/stat; " +
  'echo ---; cat /proc/loadavg; echo ---; LC_ALL=C free -m; echo ---; df -m /; echo ---; ' +
  'cat /proc/uptime; echo ---; cat /sys/class/thermal/thermal_zone*/temp 2>/dev/null; ' +
  "sensors 2>/dev/null | grep -i 'package\\|core 0' | head -2; " +
  // Fallback для HTTP-метрик панели: когда /system_status виснет (замечено на
  // загруженных боксах), conns/mongo добираем по SSH. Число ESTABLISHED
  // TCP-сессий совпадает с панельным «connections» (проверено на S3: 84 vs 83).
  'echo ---; ss -tn state established 2>/dev/null | tail -n +2 | wc -l; ' +
  'pgrep -x mongod >/dev/null && echo 1 || echo 0; ' +
  // Модель CPU + потоки для подписи строки CPU в карточке сервера (21.08).
  "echo ---; grep -m1 'model name' /proc/cpuinfo | cut -d: -f2-; nproc";

function _pct(used, total) {
  if (!(total > 0)) return null;
  return Math.round((used / total) * 1000) / 10;
}

// Дельта двух агрегированных строк /proc/stat («cpu  user nice system idle
// iowait irq softirq steal …») → занятый %. Меньше двух строк — null.
function _parseCpuPct(text) {
  const lines = String(text).split('\n').filter(l => /^cpu\s+\d/.test(l));
  if (lines.length < 2) return null;
  const a = lines[0].trim().split(/\s+/).slice(1, 9).map(Number);
  const b = lines[1].trim().split(/\s+/).slice(1, 9).map(Number);
  if (a.some(isNaN) || b.some(isNaN)) return null;
  const sum = arr => arr.reduce((s, v) => s + v, 0);
  const dTotal = sum(b) - sum(a);
  const dIdle = (b[3] + b[4]) - (a[3] + a[4]);   // idle + iowait
  if (!(dTotal > 0)) return null;
  return _pct(dTotal - dIdle, dTotal);
}

// Парсер stdout SSH-команды → объект метрик (null = поле не распарсилось).
// Чистая функция — покрыта юнит-тестами.
function parseSshMetrics(text) {
  const out = {
    cpu_pct: null, load1: null, load5: null, load15: null,
    mem_used_pct: null, swap_used_pct: null, disk_used_pct: null,
    temp_c: null, uptime_sec: null,
    mem_used_mb: null, mem_total_mb: null, disk_used_mb: null, disk_total_mb: null,
    conns: null, mongo_ok: null,   // SSH-fallback для зависшей /system_status
    cpu_model: null, cpu_cores: null,
  };
  const sections = String(text || '').split(/^---\s*$/m).map(s => s.trim());
  if (sections[0]) out.cpu_pct = _parseCpuPct(sections[0]);

  // loadavg: «0.12 0.34 0.56 2/345 6789»
  const lm = (sections[1] || '').match(/^([\d.]+)\s+([\d.]+)\s+([\d.]+)/);
  if (lm) {
    out.load1 = parseFloat(lm[1]);
    out.load5 = parseFloat(lm[2]);
    out.load15 = parseFloat(lm[3]);
  }

  // free -m: «Mem: total used free shared buff/cache available» / «Swap: …»
  const free = sections[2] || '';
  const mm = free.match(/^Mem:\s+(\d+)\s+\d+\s+\d+\s+\d+\s+\d+\s+(\d+)/m);
  if (mm) {
    out.mem_used_pct = _pct(+mm[1] - +mm[2], +mm[1]);
    out.mem_total_mb = +mm[1];
    out.mem_used_mb = +mm[1] - +mm[2];   // total − available (как htop «used»)
  }
  const sm = free.match(/^Swap:\s+(\d+)\s+(\d+)\s+(\d+)/m);
  if (sm) out.swap_used_pct = +sm[1] > 0 ? _pct(+sm[2], +sm[1]) : 0;

  // df -m /: строка с маунт-поинтом «/», в ней поле «NN%»
  for (const line of (sections[3] || '').split('\n')) {
    const cells = line.trim().split(/\s+/);
    if (cells.length >= 5 && cells[cells.length - 1] === '/') {
      const pm = line.match(/(\d+)%/);
      if (pm) out.disk_used_pct = +pm[1];
      if (/^\d+$/.test(cells[1])) out.disk_total_mb = +cells[1];
      if (/^\d+$/.test(cells[2])) out.disk_used_mb = +cells[2];
      break;
    }
  }

  // uptime: «123456.78 98765.43»
  const um = (sections[4] || '').match(/^([\d.]+)/);
  if (um) out.uptime_sec = Math.round(parseFloat(um[1]));

  // Температура: приоритет sensors («Package id 0:  +55.0°C …»), иначе
  // максимум термозон (миллиградусы). Отсекаем нефизичные значения.
  const th = sections[5] || '';
  const sensM = th.match(/\+([\d.]+)\s*°C/);
  if (sensM) {
    const v = parseFloat(sensM[1]);
    if (v > 0 && v < 150) out.temp_c = Math.round(v * 10) / 10;
  }
  if (out.temp_c == null) {
    let maxMilli = 0;
    for (const line of th.split('\n')) {
      const v = parseInt(line.trim(), 10);
      if (Number.isFinite(v) && v > maxMilli) maxMilli = v;
    }
    const v = maxMilli / 1000;
    if (v > 0 && v < 150) out.temp_c = Math.round(v * 10) / 10;
  }

  // Секция 6 — SSH-fallback HTTP-метрик: первая строка = число ESTABLISHED
  // TCP (≈ панельные «connections»), вторая = жив ли mongod (1/0). HTTP-
  // значения приоритетнее (мердж в collectServer пропускает null HTTP-поля).
  const fbLines = (sections[6] || '').split('\n').map(l => l.trim()).filter(Boolean);
  if (/^\d+$/.test(fbLines[0] || '')) out.conns = parseInt(fbLines[0], 10);
  if (/^[01]$/.test(fbLines[1] || '')) out.mongo_ok = parseInt(fbLines[1], 10);

  // Секция 7 — модель CPU (« Intel(R) Core(TM) i3-10100 CPU @ 3.60GHz») + nproc.
  const hw = (sections[7] || '').split('\n').map(l => l.trim()).filter(Boolean);
  if (hw[0]) out.cpu_model = hw[0].slice(0, 120);
  if (/^\d+$/.test(hw[1] || '')) out.cpu_cores = parseInt(hw[1], 10);
  return out;
}

// Известные смещения TZ-аббревиатур боксов (часы от UTC). Неизвестная зона —
// трактуем время как локальное время сервера дашборда.
const _TZ_OFFSET_H = { EEST: 3, EET: 2, MSK: 3, UTC: 0, GMT: 0, CEST: 2, CET: 1 };

// Парсер HTML /system_status → { conns, rps, mongo_ok, usb_errors,
// box_time_drift_sec }. nowMs — момент сбора на сервере дашборда (для дрейфа
// часов; инжектируется — функция чистая для тестов).
function parseSystemStatus(html, nowMs) {
  const out = { conns: null, rps: null, mongo_ok: null, usb_errors: '', box_time_drift_sec: null };
  const h = String(html || '');

  // <h3>System Time</h3>\n<p>2026-08-20 10:49:50 EEST</p>
  const tm = h.match(/<h3>\s*System Time\s*<\/h3>\s*<p>([^<]+)<\/p>/i);
  if (tm) {
    const dm = tm[1].trim().match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})(?:\s+([A-Za-z]+))?/);
    if (dm) {
      const [, y, mo, d, hh, mi, ss, tz] = dm;
      let boxMs;
      if (tz && Object.prototype.hasOwnProperty.call(_TZ_OFFSET_H, tz.toUpperCase())) {
        boxMs = Date.UTC(+y, +mo - 1, +d, +hh, +mi, +ss) - _TZ_OFFSET_H[tz.toUpperCase()] * 3600e3;
      } else {
        boxMs = new Date(+y, +mo - 1, +d, +hh, +mi, +ss).getTime();
      }
      if (Number.isFinite(boxMs) && Number.isFinite(nowMs)) {
        out.box_time_drift_sec = Math.round((boxMs - nowMs) / 1000);
      }
    }
  }

  // Live stats: <span style="font-size: 120%; "> 93 </span> connections
  //             <span style="font-size: 120%; "> 1.2   </span> requests/second
  const cm = h.match(/font-size:\s*120%[^>]*>([\d\s.,]+)<\/span>\s*connections/i);
  if (cm) {
    const v = parseFloat(cm[1].replace(/\s/g, '').replace(',', '.'));
    if (Number.isFinite(v)) out.conns = Math.round(v);
  }
  const rm = h.match(/font-size:\s*120%[^>]*>([\d\s.,]+)<\/span>\s*requests\/second/i);
  if (rm) {
    const v = parseFloat(rm[1].replace(/\s/g, '').replace(',', '.'));
    if (Number.isFinite(v)) out.rps = v;
  }

  // <h3>MongoDB status</h3> затем <font color=green>OK</font>
  const mongoSec = h.match(/<h3>\s*MongoDB status\s*<\/h3>([\s\S]{0,600})/i);
  if (mongoSec) {
    out.mongo_ok = /<font[^>]*color\s*=\s*"?green"?[^>]*>\s*OK\s*<\/font>/i.test(mongoSec[1]) ? 1 : 0;
  }

  // «Critical USB errors:» + <pre> внутри details — непустой pre = ошибки.
  // Храним «N: первая строка» (N — число непустых строк), пусто = нет ошибок.
  const um = h.match(/Critical USB errors\s*:<\/i>([\s\S]*?)<pre[^>]*>([\s\S]*?)<\/pre>/i);
  if (um) {
    const text = um[2]
      .replace(/<[^>]+>/g, '')
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
      .replace(/&#0?39;/g, "'").replace(/&amp;/g, '&');
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
    if (lines.length) out.usb_errors = `${lines.length}: ${lines[0].slice(0, 120)}`;
  }
  return out;
}

function create(deps) {
  const { db, logger, apiServers, proxyConf, events, alerts } = deps;   // events — SSE (23.08): metrics_update после прогона
  const getSetting = deps.getSetting || ((_key, fallback) => fallback);
  // execFile инжектируется (тесты подсовывают заглушку), sshpass — из $PATH.
  const execFile = deps.execFile || require('child_process').execFile;

  const insertStmt = db.prepare(`INSERT INTO server_metrics
    (server_name, collected_at, source, cpu_pct, load1, load5, load15,
     mem_used_pct, swap_used_pct, disk_used_pct, temp_c, uptime_sec,
     mem_used_mb, mem_total_mb, disk_used_mb, disk_total_mb,
     conns, rps, mongo_ok, usb_errors, box_time_drift_sec, error,
     cpu_model, cpu_cores)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const pruneStmt = db.prepare('DELETE FROM server_metrics WHERE collected_at < ?');
  const historyStmt = db.prepare(`SELECT id, collected_at, cpu_pct, mem_used_pct, temp_c, conns,
      disk_used_mb, disk_total_mb
    FROM server_metrics WHERE server_name = ? AND collected_at >= ? ORDER BY collected_at`);

  function _runPredictive(serverName) {
    if (!alerts || getSetting('predictive_enabled', true) === false) return { anomalies: 0, disk: 0 };
    const since = new Date(Date.now() - RETENTION_DAYS * 86400e3).toISOString();
    const rows = historyStmt.all(serverName, since);
    if (!rows.length) return { anomalies: 0, disk: 0 };
    const result = predictive.analyze(rows, rows[rows.length - 1], {
      minSamples: Number(getSetting('predictive_min_samples', 24)) || 24,
    });
    let anomalies = 0, disk = 0;
    for (const item of result.anomalies) {
      if (alerts.trigger('server_metric_anomaly', {
        server: serverName,
        metric: item.metric,
        label: item.label,
        current: item.current,
        baseline: item.median,
        threshold: item.threshold,
        deviation_pct: item.deviation_pct,
        samples: item.samples,
      })) anomalies++;
    }
    const forecast = result.disk_forecast;
    const warnDays = Math.max(1, Number(getSetting('disk_forecast_warn_days', 30)) || 30);
    if (forecast && forecast.days_left != null && forecast.days_left <= warnDays) {
      if (alerts.trigger('server_disk_forecast', {
        server: serverName,
        days_left: forecast.days_left,
        full_date: forecast.full_date,
        growth_gb_day: Math.round(forecast.growth_mb_day / 1024 * 10) / 10,
        free_gb: Math.round(forecast.free_mb / 1024 * 10) / 10,
        confidence: forecast.confidence,
      })) disk++;
    }
    return { anomalies, disk };
  }

  // SSH: сначала пробуем ключ из ~/.ssh/id_ed25519 (публичная часть выдана
  // владельцу — добавляется в authorized_keys боксов), если мимо — sshpass
  // с паролем из конфига сервера. BatchMode=yes — без интерактива.
  function _sshArgs(server, port, useKey) {
    return ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=no',
      '-o', 'UserKnownHostsFile=/dev/null', '-o', 'ConnectTimeout=8',
      '-o', 'IdentitiesOnly=yes',
      '-p', String(port), `${server.osLogin}@${server.publicIp}`, SSH_CMD];
  }

  function _sshOnce(server, port, useKey) {
    return new Promise((resolve, reject) => {
      const args = _sshArgs(server, port, useKey);
      const bin = useKey ? 'ssh' : 'sshpass';
      const argv = useKey ? args : ['-p', server.osPassword, 'ssh', ...args];
      execFile(bin, argv, { timeout: SSH_TIMEOUT_MS, maxBuffer: 256 * 1024 },
        (err, stdout) => (err ? reject(err) : resolve(stdout)));
    });
  }

  // SSH-сбор: ключ → sshpass, порты — server.sshPort (если задан, напр.
  // read-only mon@ на нестандартном порту) → 2222 → 22, таймаут 10с. Нет
  // кредов или все попытки мимо — null (файрвол боксов — штатная ситуация,
  // info-лог).
  function _sshPorts(server) {
    const custom = Number(server.sshPort);
    const list = [];
    if (custom > 0 && custom < 65536) list.push(custom);
    for (const p of SSH_PORTS) if (!list.includes(p)) list.push(p);
    return list;
  }
  async function collectSsh(server) {
    if (!server.osLogin || !server.publicIp) return null;
    let lastErr = null;
    for (const port of _sshPorts(server)) {
      try { return parseSshMetrics(await _sshOnce(server, port, true)); }
      catch (e) { lastErr = e; }
    }
    if (!server.osPassword) {
      logger.info(`[ServerMetrics] ${server.name}: SSH недоступен (${String((lastErr && lastErr.message) || lastErr).slice(0, 120)}) — fallback на HTTP-панель`);
      return null;
    }
    for (const port of _sshPorts(server)) {
      try { return parseSshMetrics(await _sshOnce(server, port, false)); }
      catch (e) { lastErr = e; }
    }
    logger.info(`[ServerMetrics] ${server.name}: SSH недоступен (${String((lastErr && lastErr.message) || lastErr).slice(0, 120)}) — fallback на HTTP-панель`);
    return null;
  }

  // HTTP-сбор: /system_status панели бокса (обход логин-стены внутри getPage).
  async function collectHttp(server, nowMs) {
    try {
      const res = await proxyConf.getPage(server, '/system_status');
      if (!res.ok) {
        logger.info(`[ServerMetrics] ${server.name}: /system_status → ${res.reason || res.status}`);
        return null;
      }
      return parseSystemStatus(res.html, nowMs);
    } catch (e) {
      logger.info(`[ServerMetrics] ${server.name}: /system_status failed: ${e.message}`);
      return null;
    }
  }

  async function collectServer(server) {
    const nowMs = Date.now();
    const [ssh, http] = await Promise.all([collectSsh(server), collectHttp(server, nowMs)]);
    // Мерж: SSH-поля приоритетнее, HTTP заполняет своё (conns/rps/mongo/…).
    const row = {
      server_name: server.name,
      collected_at: new Date(nowMs).toISOString(),
      source: ssh && http ? 'mixed' : ssh ? 'ssh' : http ? 'http' : '',
      cpu_pct: null, load1: null, load5: null, load15: null,
      mem_used_pct: null, swap_used_pct: null, disk_used_pct: null,
      temp_c: null, uptime_sec: null,
      mem_used_mb: null, mem_total_mb: null, disk_used_mb: null, disk_total_mb: null,
      conns: null, rps: null, mongo_ok: null, usb_errors: '',
      box_time_drift_sec: null, error: '',
      cpu_model: null, cpu_cores: null,
    };
    if (ssh) Object.assign(row, ssh);
    // HTTP поверх SSH, но только непустые поля: когда /system_status отвечает,
    // её conns/mongo/usb — авторитетнее SSH-fallback'а; null у HTTP (поле не
    // распарсилось) не должен затирать SSH-значение.
    if (http) for (const k of Object.keys(http)) {
      if (http[k] !== null && http[k] !== '') row[k] = http[k];
    }
    if (!ssh && !http) row.error = 'unreachable: ssh+http failed';
    return row;
  }

  // Re-entrancy: прогон один за раз (SSH-таймауты до 20с на бокс).
  let running = false;

  async function runServerMetrics() {
    if (running) {
      logger.info('[ServerMetrics] Already running, skipping...');
      return { skipped: 'already_running' };
    }
    running = true;
    try {
      let ok = 0, partial = 0, failed = 0, anomalyAlerts = 0, diskForecastAlerts = 0;
      const _rows = [];   // SSE (23.08): компактный снимок прогона для metrics_update
      for (const server of apiServers) {
        try {
          const row = await collectServer(server);
          insertStmt.run(
            row.server_name, row.collected_at, row.source,
            row.cpu_pct, row.load1, row.load5, row.load15,
            row.mem_used_pct, row.swap_used_pct, row.disk_used_pct,
            row.temp_c, row.uptime_sec,
            row.mem_used_mb, row.mem_total_mb, row.disk_used_mb, row.disk_total_mb,
            row.conns, row.rps, row.mongo_ok, row.usb_errors,
            row.box_time_drift_sec, row.error,
            row.cpu_model, row.cpu_cores);
          if (row.error) failed++;
          else if (row.source === 'http') partial++;   // SSH недоступен — только панель
          else ok++;
          if (!row.error) {
            const predictiveAlerts = _runPredictive(row.server_name);
            anomalyAlerts += predictiveAlerts.anomalies;
            diskForecastAlerts += predictiveAlerts.disk;
          }
          _rows.push({ s: row.server_name, cpu: row.cpu_pct, mem: row.mem_used_pct, conns: row.conns, err: !!row.error });
        } catch (e) {
          failed++;
          logger.warn(`[ServerMetrics] ${server.name}: ${e.message}`);
        }
      }
      // Ретенция 7 дней: ISO-строки сравниваются лексикографически.
      const cutoff = new Date(Date.now() - RETENTION_DAYS * 86400e3).toISOString();
      const pruned = pruneStmt.run(cutoff).changes;
      logger.info(`[ServerMetrics] Complete: ${ok} full, ${partial} http-only, ${failed} failed (pruned ${pruned})`);
      // SSE (23.08): свежие метрики боксов → realtime-обновление карточек админки.
      if (events) { try { events.publish('metrics_update', { servers: _rows }); } catch (_) { /* best-effort */ } }
      return { ok, partial, failed, pruned, anomalyAlerts, diskForecastAlerts };
    } finally {
      running = false;
    }
  }

  return { runServerMetrics };
}

module.exports = { create, parseSshMetrics, parseSystemStatus, SSH_CMD, SSH_PORTS };
