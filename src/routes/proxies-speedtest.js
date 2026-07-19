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


  return r;
};
