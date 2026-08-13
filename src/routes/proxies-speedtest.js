'use strict';
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
    db,
  } = deps;
  const r = express.Router();

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

async function _runSpeedtest(jobId, server, serverName, nick, imei) {
  try {
    const result = await fetchApi(server, `/apix/speedtest?arg=${encodeURIComponent(nick)}`, 180000);
    // Save to history when imei provided and result is valid
    if (imei && result && !result.error) {
      const key = `${serverName}_${imei}`;
      const dl = parseFloat(result.download || result.Download || result.dl || 0);
      const ul = parseFloat(result.upload || result.Upload || result.ul || 0);
      const ping = parseFloat(result.ping || result.Ping || result.latency || 0);
      if (dl > 0 || ul > 0) {
        pushSpeedtestEntry(key, { date: new Date().toISOString(), download: dl, upload: ul, ping, raw: result });
      }
    }
    _stJobs.set(jobId, { status: 'done', result, startedAt: _stJobs.get(jobId).startedAt, finishedAt: Date.now() });
  } catch (err) {
    _stJobs.set(jobId, { status: 'error', error: 'Speedtest failed', details: err.message,
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
      const dl = parseFloat(result.download || result.Download || result.dl || 0);
      const ul = parseFloat(result.upload || result.Upload || result.ul || 0);
      const ping = parseFloat(result.ping || result.Ping || result.latency || 0);
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
    rows = db.prepare(`
      SELECT nick,
             strftime('%Y-%m-%d %H:00', ts, '+3 hours')        AS hour_msk,
             COUNT(*)                                          AS samples,
             SUM(CASE WHEN ok = 1 THEN 1 ELSE 0 END)           AS ok_count,
             SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END)           AS fail_count,
             ROUND(AVG(CASE WHEN ok = 1 THEN download END), 2) AS avg_dl,
             ROUND(MIN(CASE WHEN ok = 1 THEN download END), 2) AS min_dl,
             ROUND(MAX(CASE WHEN ok = 1 THEN download END), 2) AS max_dl,
             ROUND(AVG(CASE WHEN ok = 1 THEN upload END), 2)   AS avg_ul,
             ROUND(AVG(CASE WHEN ok = 1 THEN ping END), 1)     AS avg_ping
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
      if (cur) { if (!cur.operator && x.operator) cur.operator = x.operator; continue; }
      const srv = x.server ? findServer(x.server) : null;
      seen.set(x.nick, {
        nick: x.nick,
        server: x.server || '',
        location: (srv && (srv.countryName || srv.country)) || x.server || '',
        operator: x.operator || '',
      });
    }
    modems.push(...seen.values());
  } catch (_) { /* мета best-effort, строки уже отданы */ }
  res.json({ hours, rows, modems });
});


  return r;
};
