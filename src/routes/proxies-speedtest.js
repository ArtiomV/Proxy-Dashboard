'use strict';
const { parseSpeedToMbps, parsePingMs } = require('../api/proxy-smart');
const speedtestGate = require('../jobs/speedtest-gate');
//
// src/routes/proxies-speedtest.js — speedtest endpoints (WP6.5 carve-out from proxies.js, VERBATIM move).
//
const express = require('express');
const crypto = require('crypto');

module.exports = function createRouter(deps) {
  const {
    authMiddleware, adminMiddleware,
    fetchApi, findServer,
    pushSpeedtestEntry, speedtestHistory,
    db, clientByLogin, knownModems,
    normalizeOperator,
  } = deps;
  const r = express.Router();

  // 2026-08-13: оператор из speed_monitor — историческое сырьё (до алиасов
  // в normalizeOperator в БД попадали «MOLDCELL»/«VF-RO»). Нормализуем на
  // чтении, чтобы варианты не плодили отдельные строки/легенды; БД не трогаем.
  function _normMetaOp(raw, serverName) {
    if (!raw || !normalizeOperator) return raw || '';
    const srv = serverName ? findServer(serverName) : null;
    return normalizeOperator(raw, !!(srv && srv.country === 'RO')) || raw;
  }

// модем), а nginx рвёт соединение на 30 с и отдаёт HTML-страницу 504 —
// фронт получал «Unexpected token '<'... is not valid JSON». Быстрые модемы
// иногда успевали, медленные никогда → выглядело как случайная ошибка.
// Ответ синхронно ждать нельзя ещё и из-за Cloudflare (жёсткий лимит 100 с).
// Поэтому: POST /start отвечает мгновенно с jobId, работа идёт в фоне,
// фронт опрашивает /status. Ни один прокси-слой больше не при делах.
const _stJobs = new Map();            // jobId → { status, result, error, startedAt, finishedAt }
const _ST_JOB_TTL_MS = 10 * 60 * 1000;

function _stCleanup() {
  const now = Date.now();
  for (const [id, j] of _stJobs) {
    if (now - (j.finishedAt || j.startedAt) > _ST_JOB_TTL_MS) _stJobs.delete(id);
  }
}

// 2026-09-27: ручной замер тоже идёт через глобальный гейт спидтестов на
// бокс (src/jobs/speedtest-gate.js) — параллельный почасовой монитор или
// пробы sim-exhaustion не должны задушить ARM-хаб (панель отвечает HTML
// вместо JSON). Слот занят >60с → job завершается понятной ошибкой.
function _stGateOpts() {
  return speedtestGate.optsFromSettings(deps.getSetting);
}

async function _runSpeedtest(jobId, server, serverName, nick, imei) {
  try {
    const result = await speedtestGate.runWithGate(serverName,
      () => fetchApi(server, `/apix/speedtest?arg=${encodeURIComponent(nick)}`, 180000),
      _stGateOpts());
    // Save to history when imei provided and result is valid
    if (imei && result && !result.error) {
      const key = `${serverName}_${imei}`;
      const dl = parseSpeedToMbps(result.download ?? result.Download ?? result.dl ?? 0);
      const ul = parseSpeedToMbps(result.upload ?? result.Upload ?? result.ul ?? 0);
      const ping = parsePingMs(result.ping ?? result.Ping ?? result.latency ?? 0);
      if (dl > 0 || ul > 0) {
        pushSpeedtestEntry(key, { date: new Date().toISOString(), download: dl, upload: ul, ping, raw: result });
      }
    }
    _stJobs.set(jobId, { status: 'done', result, startedAt: _stJobs.get(jobId).startedAt, finishedAt: Date.now() });
  } catch (err) {
    const busy = err && err.code === 'GATE_BUSY';
    _stJobs.set(jobId, { status: 'error',
      error: busy ? 'Бокс занят другими спидтестами — попробуйте через минуту' : 'Speedtest failed',
      details: err.message,
      startedAt: (_stJobs.get(jobId) || {}).startedAt || Date.now(), finishedAt: Date.now() });
  }
}


r.post('/api/admin/speedtest/start', authMiddleware, adminMiddleware, (req, res) => {
  const nick = (req.body && req.body.nick) || req.query.nick;
  const serverName = (req.body && req.body.serverName) || req.query.serverName;
  const imei = (req.body && req.body.imei) || req.query.imei;
  if (!nick || !serverName) return res.status(400).json({ error: 'nick and serverName required' });
  const server = findServer(serverName);
  if (!server) return res.status(400).json({ error: 'Server not found' });
  _stCleanup();
  const jobId = crypto.randomBytes(8).toString('hex');
  _stJobs.set(jobId, { status: 'running', startedAt: Date.now() });
  _runSpeedtest(jobId, server, serverName, nick, imei);   // намеренно без await
  res.json({ jobId, status: 'running' });
});

r.get('/api/admin/speedtest/status', authMiddleware, adminMiddleware, (req, res) => {
  const job = _stJobs.get(String(req.query.jobId || ''));
  if (!job) return res.status(404).json({ error: 'Замер не найден (истёк или сервер перезапущен)' });
  res.json(Object.assign({ elapsedSec: Math.round((Date.now() - job.startedAt) / 1000) }, job));
});

// Старый синхронный роут — оставлен для обратной совместимости (curl/скрипты).
// UI им больше не пользуется: на длинных замерах его рвёт nginx/Cloudflare.
r.get('/api/admin/speedtest', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { nick, serverName, imei } = req.query;
    if (!nick || !serverName) return res.status(400).json({ error: 'nick and serverName required' });
    const server = findServer(serverName);
    if (!server) return res.status(400).json({ error: 'Server not found' });
    const result = await fetchApi(server, `/apix/speedtest?arg=${encodeURIComponent(nick)}`, 180000);
    if (imei && result && !result.error) {
      const key = `${serverName}_${imei}`;
      const dl = parseSpeedToMbps(result.download ?? result.Download ?? result.dl ?? 0);
      const ul = parseSpeedToMbps(result.upload ?? result.Upload ?? result.ul ?? 0);
      const ping = parsePingMs(result.ping ?? result.Ping ?? result.latency ?? 0);
      if (dl > 0 || ul > 0) {
        pushSpeedtestEntry(key, { date: new Date().toISOString(), download: dl, upload: ul, ping, raw: result });
      }
    }
    res.json(result);
  } catch (err) { res.status(502).json({ error: 'Speedtest failed', details: err.message }); }
});

r.get('/api/admin/speedtest_history', authMiddleware, adminMiddleware, (req, res) => {
  res.json(speedtestHistory);
});

// Почасовые замеры SpeedMonitor (таблица speed_monitor, миграция 058) —
// агрегация по (nick, час МСК): avg/min/max DL, avg UL/ping, доля сбоев.
// Именно то, что нужно для «какие симки убрать/добавить»: сравнение
// стабильности операторов по часам суток на длинном ряду (60 дней).
// ?hours=48 (дефолт, макс 1440) &nick=MD_01 &format=csv
r.get('/api/admin/speed-monitor', authMiddleware, adminMiddleware, (req, res) => {
  const hours = Math.min(Math.max(parseInt(req.query.hours, 10) || 48, 1), 24 * 60);
  const nick = String(req.query.nick || '').trim();
  const params = [`-${hours} hours`];
  let where = "ts >= datetime('now', ?)";
  if (nick) { where += ' AND nick = ?'; params.push(nick); }
  let rows;
  try {
    // 2026-08-13: исторические строки ok=1 с dl=0 И ul=0 — сбой спидтеста на
    // боксе (кластеры у нескольких модемов разом), а не «ноль оператора».
    // Считаем их сбоями и исключаем из средних, чтобы нули не роняли график.
    rows = db.prepare(`
      SELECT nick,
             strftime('%Y-%m-%d %H:00', ts, '+3 hours')        AS hour_msk,
             COUNT(*)                                          AS samples,
             SUM(CASE WHEN ok = 1 AND (download > 0 OR upload > 0) THEN 1 ELSE 0 END) AS ok_count,
             SUM(CASE WHEN ok = 1 AND (download > 0 OR upload > 0) THEN 0 ELSE 1 END) AS fail_count,
             ROUND(AVG(CASE WHEN ok = 1 AND (download > 0 OR upload > 0) THEN download END), 2) AS avg_dl,
             ROUND(MIN(CASE WHEN ok = 1 AND (download > 0 OR upload > 0) THEN download END), 2) AS min_dl,
             ROUND(MAX(CASE WHEN ok = 1 AND (download > 0 OR upload > 0) THEN download END), 2) AS max_dl,
             ROUND(AVG(CASE WHEN ok = 1 AND (download > 0 OR upload > 0) THEN upload END), 2)   AS avg_ul,
             ROUND(AVG(CASE WHEN ok = 1 AND (download > 0 OR upload > 0) THEN ping END), 1)     AS avg_ping
        FROM speed_monitor
       WHERE ${where}
       GROUP BY nick, hour_msk
       ORDER BY nick, hour_msk`).all(...params);
  } catch (e) {
    // Таблица появится после миграции 058 — до неё честный пустой ответ.
    return res.json({ hours, rows: [], note: 'speed_monitor unavailable: ' + e.message });
  }
  if (req.query.format === 'csv') {
    const header = 'nick,hour_msk,samples,ok,fail,avg_dl,min_dl,max_dl,avg_ul,avg_ping';
    const csv = [header].concat(rows.map(x =>
      [x.nick, x.hour_msk, x.samples, x.ok_count, x.fail_count,
       x.avg_dl, x.min_dl, x.max_dl, x.avg_ul, x.avg_ping].join(','))).join('\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    return res.send(csv);
  }
  // Мета по каждому нику для легенды графика: последний сервер (→ локация)
  // и последний непустой оператор. Локация — countryName из конфига бокса.
  const modems = [];
  try {
    const seen = new Map();
    for (const x of db.prepare(`
        SELECT nick, server, operator FROM speed_monitor
         WHERE ${nick ? 'nick = ? AND ' : ''} ts >= datetime('now', ?)
         ORDER BY ts DESC`).all(...(nick ? [nick, `-${hours} hours`] : [`-${hours} hours`]))) {
      // Строки отсортированы от свежих: первая встреченная по нику — последний
      // замер; оператора добираем из более ранних строк, если в свежей пусто
      // (например, свежая — not_found/offline).
      const cur = seen.get(x.nick);
      if (cur) { if (!cur.operator && x.operator) cur.operator = _normMetaOp(x.operator, x.server); continue; }
      const srv = x.server ? findServer(x.server) : null;
      seen.set(x.nick, {
        nick: x.nick,
        server: x.server || '',
        location: (srv && (srv.countryName || srv.country)) || x.server || '',
        // Адрес локации из карточки сервера («Армянская …») — группировка
        // по локациям на дашборде; пусто, если адрес не заполнен.
        address: (srv && srv.address) || '',
        operator: _normMetaOp(x.operator, x.server),
      });
    }
    modems.push(...seen.values());
  } catch (_) { /* мета best-effort, строки уже отданы */ }
  res.json({ hours, rows, modems });
});

// Портал клиента: почасовые замеры SpeedMonitor по модемам самого клиента.
// Тот же формат, что у /api/admin/speed-monitor, но состав ников вычисляется
// из привязки портов клиента (knownModems.portName) — чужие ники не отдаём.
r.get('/api/client/speed_monitor', authMiddleware, (req, res) => {
  const clientInfo = clientByLogin.get(req.user.login);
  const portName = (clientInfo && clientInfo.portName) || req.user.portNameFilter;
  if (!portName) return res.status(400).json({ error: 'No portName bound to account' });
  const hours = Math.min(Math.max(parseInt(req.query.hours, 10) || 48, 1), 24 * 60);

  // Никсы модемов клиента (portName '*' — аккаунт без фильтра, видит всё).
  const nicks = new Set();
  for (const portMap of Object.values(knownModems || {})) {
    for (const info of Object.values(portMap || {})) {
      if (!info || !info.nick) continue;
      if (portName === '*' || info.portName === portName) nicks.add(info.nick);
    }
  }
  if (nicks.size === 0) return res.json({ hours, rows: [], modems: [] });

  const nickList = [...nicks];
  const inClause = nickList.map(() => '?').join(',');
  const params = [`-${hours} hours`, ...nickList];
  let rows;
  try {
    // Те же правила, что у /api/admin/speed-monitor: ok=1 с dl=ul=0 — сбой
    // бокса, из средних исключаем (см. комментарий в админском роуте выше).
    rows = db.prepare(`
      SELECT nick,
             strftime('%Y-%m-%d %H:00', ts, '+3 hours')        AS hour_msk,
             COUNT(*)                                          AS samples,
             SUM(CASE WHEN ok = 1 AND (download > 0 OR upload > 0) THEN 1 ELSE 0 END) AS ok_count,
             SUM(CASE WHEN ok = 1 AND (download > 0 OR upload > 0) THEN 0 ELSE 1 END) AS fail_count,
             ROUND(AVG(CASE WHEN ok = 1 AND (download > 0 OR upload > 0) THEN download END), 2) AS avg_dl,
             ROUND(MIN(CASE WHEN ok = 1 AND (download > 0 OR upload > 0) THEN download END), 2) AS min_dl,
             ROUND(MAX(CASE WHEN ok = 1 AND (download > 0 OR upload > 0) THEN download END), 2) AS max_dl,
             ROUND(AVG(CASE WHEN ok = 1 AND (download > 0 OR upload > 0) THEN upload END), 2)   AS avg_ul,
             ROUND(AVG(CASE WHEN ok = 1 AND (download > 0 OR upload > 0) THEN ping END), 1)     AS avg_ping
        FROM speed_monitor
       WHERE ts >= datetime('now', ?) AND nick IN (${inClause})
       GROUP BY nick, hour_msk
       ORDER BY nick, hour_msk`).all(...params);
  } catch (e) {
    return res.json({ hours, rows: [], modems: [], note: 'speed_monitor unavailable: ' + e.message });
  }
  const modems = [];
  try {
    const seen = new Map();
    for (const x of db.prepare(`
        SELECT nick, server, operator FROM speed_monitor
         WHERE ts >= datetime('now', ?) AND nick IN (${inClause})
         ORDER BY ts DESC`).all(...params)) {
      const cur = seen.get(x.nick);
      if (cur) { if (!cur.operator && x.operator) cur.operator = _normMetaOp(x.operator, x.server); continue; }
      const srv = x.server ? findServer(x.server) : null;
      seen.set(x.nick, {
        nick: x.nick,
        server: x.server || '',
        location: (srv && (srv.countryName || srv.country)) || x.server || '',
        address: (srv && srv.address) || '',
        operator: _normMetaOp(x.operator, x.server),
      });
    }
    modems.push(...seen.values());
  } catch (_) { /* мета best-effort, строки уже отданы */ }
  res.json({ hours, rows, modems });
});

// 2026-10-02: «Скорость по операторам и локациям» — без привязки к модему.
// Клиенту важно, какая скорость у какого оператора на какой площадке (выбор
// при покупке), а не как у конкретного его ника. Агрегация speed_monitor по
// (server, operator) за окно; окно по умолчанию 48ч. Отдаём ВСЕ операторы
// флота (это витрина возможностей, не данные клиента).
// 2026-10-03: МЕДИАНА вместо средней (по просьбе владельца) — медиана
// устойчива к выбросам замеров. Адреса площадок клиентам не показываем.
function _median(vals) {
  if (!vals.length) return null;
  const s = vals.slice().sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}
r.get('/api/client/operator_speed', authMiddleware, (req, res) => {
  const hours = Math.min(Math.max(parseInt(req.query.hours, 10) || 48, 1), 24 * 14);
  const mine = req.query.mine === '1';
  try {
    // 2026-10-03: mine=1 — только пары (сервер, оператор), которые есть у
    // клиента (по привязке его портов), иначе витрина показывала операторов
    // всего флота. Скорость оператора на площадке не зависит от того, чей
    // модем её замерил — поэтому берём замеры флота по этим парам.
    let allowed = null;
    if (mine) {
      const clientInfo = clientByLogin.get(req.user.login);
      const portName = (clientInfo && clientInfo.portName) || req.user.portNameFilter || '';
      const nicks = new Set();
      for (const portMap of Object.values(knownModems || {})) {
        for (const info of Object.values(portMap || {})) {
          if (!info || !info.nick) continue;
          if (portName === '*' || info.portName === portName) nicks.add(info.nick);
        }
      }
      allowed = new Set();
      if (nicks.size) {
        const nickList = [...nicks];
        const inClause = nickList.map(() => '?').join(',');
        try {
          for (const r of db.prepare(`SELECT DISTINCT server_name, operator FROM modem_meta WHERE nick IN (${inClause}) AND TRIM(COALESCE(operator,'')) <> ''`).all(...nickList)) {
            allowed.add((r.server_name || '') + '|' + String(r.operator).toLowerCase());
          }
          // фолбэк: последний оператор ника в speed_monitor (modem_meta может не знать новый ник)
          for (const r of db.prepare(`SELECT DISTINCT server, operator FROM speed_monitor WHERE nick IN (${inClause}) AND TRIM(COALESCE(operator,'')) <> ''`).all(...nickList)) {
            allowed.add((r.server || '') + '|' + String(r.operator).toLowerCase());
          }
        } catch (_) { /* best-effort */ }
      }
    }
    const raw = db.prepare(`
      SELECT server, operator, download, upload, ping
        FROM speed_monitor
       WHERE ts >= datetime('now', ?) AND ok = 1 AND (download > 0 OR upload > 0)`).all(`-${hours} hours`);
    const groups = new Map();   // server|operator → { dls, uls, pings }
    for (const r of raw) {
      const k = (r.server || '') + '|' + (r.operator || '');
      if (allowed && !allowed.has((r.server || '') + '|' + String(r.operator || '').toLowerCase())) continue;
      if (!groups.has(k)) groups.set(k, { server: r.server, operator: r.operator, dls: [], uls: [], pings: [] });
      const g = groups.get(k);
      if (r.download > 0) g.dls.push(r.download);
      if (r.upload > 0) g.uls.push(r.upload);
      if (r.ping > 0) g.pings.push(r.ping);
    }
    const out = [...groups.values()].map(g => {
      const srv = g.server ? findServer(g.server) : null;
      return {
        server: g.server,
        operator: _normMetaOp(g.operator, g.server),
        location: (srv && (srv.displayName || srv.countryName)) || g.server,
        samples: g.dls.length,
        median_dl: g.dls.length ? Math.round(_median(g.dls) * 10) / 10 : null,
        median_ul: g.uls.length ? Math.round(_median(g.uls) * 10) / 10 : null,
        median_ping: g.pings.length ? Math.round(_median(g.pings)) : null,
      };
    }).sort((a, b) => String(a.location).localeCompare(String(b.location)) || (b.median_dl || 0) - (a.median_dl || 0));
    res.json({ hours, rows: out });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});


  return r;
};
