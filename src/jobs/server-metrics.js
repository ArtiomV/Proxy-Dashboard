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

// Одна удалённая команда: два снимка агрегированной строки /proc/stat с
// паузой (дельта → cpu%), loadavg, free -m, df -m /, uptime, термозоны +
// lm-sensors (если установлен). Секции разделены строкой '---'.
const SSH_CMD = "grep '^cpu ' /proc/stat; sleep 1; grep '^cpu ' /proc/stat; " +
  'echo ---; cat /proc/loadavg; echo ---; LC_ALL=C free -m; echo ---; df -m /; echo ---; ' +
  'cat /proc/uptime; echo ---; cat /sys/class/thermal/thermal_zone*/temp 2>/dev/null; ' +
  "sensors 2>/dev/null | grep -i 'package\\|core 0' | head -2";

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
  if (mm) out.mem_used_pct = _pct(+mm[1] - +mm[2], +mm[1]);
  const sm = free.match(/^Swap:\s+(\d+)\s+(\d+)\s+(\d+)/m);
  if (sm) out.swap_used_pct = +sm[1] > 0 ? _pct(+sm[2], +sm[1]) : 0;

  // df -m /: строка с маунт-поинтом «/», в ней поле «NN%»
  for (const line of (sections[3] || '').split('\n')) {
    const cells = line.trim().split(/\s+/);
    if (cells.length >= 5 && cells[cells.length - 1] === '/') {
      const pm = line.match(/(\d+)%/);
      if (pm) out.disk_used_pct = +pm[1];
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
  const { db, logger, apiServers, proxyConf } = deps;
  // execFile инжектируется (тесты подсовывают заглушку), sshpass — из $PATH.
  const execFile = deps.execFile || require('child_process').execFile;

  const insertStmt = db.prepare(`INSERT INTO server_metrics
    (server_name, collected_at, source, cpu_pct, load1, load5, load15,
     mem_used_pct, swap_used_pct, disk_used_pct, temp_c, uptime_sec,
     conns, rps, mongo_ok, usb_errors, box_time_drift_sec, error)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const pruneStmt = db.prepare('DELETE FROM server_metrics WHERE collected_at < ?');

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
      conns: null, rps: null, mongo_ok: null, usb_errors: '',
      box_time_drift_sec: null, error: '',
    };
    if (ssh) Object.assign(row, ssh);
    if (http) Object.assign(row, http);
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
      let ok = 0, partial = 0, failed = 0;
      for (const server of apiServers) {
        try {
          const row = await collectServer(server);
          insertStmt.run(
            row.server_name, row.collected_at, row.source,
            row.cpu_pct, row.load1, row.load5, row.load15,
            row.mem_used_pct, row.swap_used_pct, row.disk_used_pct,
            row.temp_c, row.uptime_sec,
            row.conns, row.rps, row.mongo_ok, row.usb_errors,
            row.box_time_drift_sec, row.error);
          if (row.error) failed++;
          else if (row.source === 'http') partial++;   // SSH недоступен — только панель
          else ok++;
        } catch (e) {
          failed++;
          logger.warn(`[ServerMetrics] ${server.name}: ${e.message}`);
        }
      }
      // Ретенция 7 дней: ISO-строки сравниваются лексикографически.
      const cutoff = new Date(Date.now() - RETENTION_DAYS * 86400e3).toISOString();
      const pruned = pruneStmt.run(cutoff).changes;
      logger.info(`[ServerMetrics] Complete: ${ok} full, ${partial} http-only, ${failed} failed (pruned ${pruned})`);
      return { ok, partial, failed, pruned };
    } finally {
      running = false;
    }
  }

  return { runServerMetrics };
}

module.exports = { create, parseSshMetrics, parseSystemStatus, SSH_CMD, SSH_PORTS };
