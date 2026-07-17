'use strict';
//
// src/routes/proxies.js — modem + port control endpoints (Stage 3).
//
// 25 admin routes for: reset/reboot/usb_reset modems, port CRUD,
// bulk operations, SMS/USSD send, speedtest queries, IP history.

const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcrypt');

module.exports = function createProxiesRouter(deps) {
  const {
    db, logger, authMiddleware, adminMiddleware,
    fetchApi, fetchApiRaw, postApi, postFormApi, findServer,
    parseHtmlInputFields,
    apiServers, SERVER_COUNTRIES,
    users,
    auditLog, logActivity, getClientIp,
    proxySmart,
    saveKnownModems,
    knownModems,
    saveSpeedtestHistory, speedtestHistory,
    pushSpeedtestEntry,
    ipHistory,
    saveIpHistory,
    modemRotationCache, saveRotationCache,
    saveModemMeta,
    fetchAllServersDataCached,
    syncRotationLog, _rlSelect,
    rebuildPortIdToPortName,
  } = deps;

async function _modemAction(req, res, paramName, apiPathFn, errorLabel) {
  try {
    const paramVal = req.body[paramName];
    const { serverName } = req.body;
    if (!paramVal || !serverName) return res.status(400).json({ error: `${paramName} and serverName required` });
    const server = findServer(serverName);
    if (!server) return res.status(400).json({ error: 'Server not found' });
    const result = await fetchApi(server, apiPathFn(paramVal));
    // ProxySmart apix actions reply { result, message } (or a string). A reboot
    // can SILENTLY fail when the modem's WebApp is down ("restart the modem"),
    // yet still return HTTP 200 — so inspect the body instead of always
    // reporting success, otherwise the UI says «выполнено» but nothing happens.
    let psMessage = '';
    if (result && typeof result === 'object') psMessage = result.message || result.MSG || '';
    const blob = (typeof result === 'string') ? result : JSON.stringify(result || '');
    const failed = /not available|restart the modem|web ?app|cannot|unable|is busy|no such|not found/i.test(blob)
      || /"result"\s*:\s*"?(error|fail)/i.test(blob);
    if (failed) {
      logger.warn(`[${errorLabel}] ProxySmart refused ${paramVal}@${serverName}: ${psMessage || blob.slice(0, 160)}`);
      return res.json({ ok: false, result, message: psMessage, error: psMessage || `${errorLabel}: ProxySmart не выполнил операцию (модем не отвечает — попробуйте USB-ресет)` });
    }
    return res.json({ ok: true, result, message: psMessage });
  } catch (err) { return res.status(502).json({ error: `${errorLabel} failed`, details: err.message }); }
}

  const r = express.Router();

r.post('/api/admin/reset_ip', authMiddleware, adminMiddleware, (req, res) =>
  _modemAction(req, res, 'imei', v => `/apix/reset_modem_by_imei?IMEI=${encodeURIComponent(v)}`, 'Reset'));

r.post('/api/admin/reboot', authMiddleware, adminMiddleware, (req, res) =>
  _modemAction(req, res, 'imei', v => `/apix/reboot_modem_by_imei?IMEI=${encodeURIComponent(v)}`, 'Reboot'));

r.post('/api/admin/usb_reset', authMiddleware, adminMiddleware, (req, res) =>
  _modemAction(req, res, 'nick', v => `/apix/usb_reset_modem_json?arg=${encodeURIComponent(v)}`, 'USB reset'));

// Re-Add modem: re-register the USB device in ProxySmart (the "Re-Add Modem"
// action from the ProxySmart UI). /modem/add_dev needs the device path (DEV),
// which we resolve from the live single-modem status by nick. We then verify
// ProxySmart actually executed the request by reading its {result, message}.
r.post('/api/admin/readd_modem', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { nick, serverName } = req.body;
    if (!nick || !serverName) return res.status(400).json({ error: 'nick and serverName required' });
    const server = findServer(serverName);
    if (!server) return res.status(400).json({ error: 'Server not found' });
    // Resolve DEV (device path, e.g. "modem4397") for this modem.
    const status = await fetchApi(server, `/apix/show_single_status_json?arg=${encodeURIComponent(nick)}`);
    const m = Array.isArray(status) ? status[0] : status;
    const dev = m && m.net_details && m.net_details.DEV;
    if (!dev) return res.status(404).json({ error: `Не удалось определить устройство (DEV) модема ${nick}` });
    const apiRes = await postFormApi(server, '/modem/add_dev', { DEV: dev });
    // Verify execution: ProxySmart replies JSON {result, message, EVENT_ID}.
    let psResult = '', psMessage = '';
    try { const j = JSON.parse(apiRes.raw || '{}'); psResult = j.result || ''; psMessage = j.message || ''; } catch (_) { /* non-JSON body */ }
    logger.info(`[ReAdd] ${nick}@${serverName} DEV=${dev} -> result="${psResult}" msg="${psMessage}"`);
    auditLog(req.user.login, 'readd_modem', { serverName, nick, dev, result: psResult, ip: getClientIp(req) });
    proxySmart.invalidateCache();
    res.json({ ok: true, dev, result: psResult, message: psMessage });
  } catch (err) { return res.status(502).json({ error: 'Re-add failed', details: err.message }); }
});

r.post('/api/admin/reboot_server', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { serverName, password } = req.body;
    if (!serverName) return res.status(400).json({ error: 'serverName required' });
    const adminUser = users[req.user.login];
    if (!adminUser) return res.status(403).json({ error: 'Пользователь не найден' });
    const pwdValid = adminUser.passwordHash ? await bcrypt.compare(password || '', adminUser.passwordHash) : (adminUser.password === password);
    if (!pwdValid) return res.status(403).json({ error: 'Неверный пароль' });
    const server = findServer(serverName);
    if (!server) return res.status(400).json({ error: 'Server not found' });
    const result = await fetchApi(server, '/apix/reboot_server', 30000);
    logger.info(`[Admin] Server ${serverName} reboot requested`);
    res.json({ ok: true, result });
  } catch (err) { res.status(502).json({ error: 'Reboot server failed', details: err.message }); }
});

r.post('/api/admin/reset_complete', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { serverName, password } = req.body;
    if (!serverName) return res.status(400).json({ error: 'serverName required' });
    const adminUser = users[req.user.login];
    if (!adminUser) return res.status(403).json({ error: 'Пользователь не найден' });
    const pwdValid = adminUser.passwordHash ? await bcrypt.compare(password || '', adminUser.passwordHash) : (adminUser.password === password);
    if (!pwdValid) return res.status(403).json({ error: 'Неверный пароль' });
    const server = findServer(serverName);
    if (!server) return res.status(400).json({ error: 'Server not found' });
    // Reset IP for all modems on this server
    const statusData = await fetchApi(server, '/apix/show_status_json');
    const modems = Array.isArray(statusData) ? statusData : [];
    let resetCount = 0;
    for (const m of modems) {
      const imei = m.modem_details?.IMEI;
      if (!imei) continue;
      try {
        await fetchApi(server, `/apix/reset_modem_by_imei?IMEI=${encodeURIComponent(imei)}`, 15000);
        resetCount++;
      } catch (e) { /* skip failed */ }
    }
    logger.info(`[Admin] Reset complete on ${serverName}: ${resetCount}/${modems.length} modems`);
    res.json({ ok: true, total: modems.length, reset: resetCount });
  } catch (err) { res.status(502).json({ error: 'Reset complete failed', details: err.message }); }
});

// Reconnect all modems on a server: Re-Add (re-register USB) every modem that is
// NOT currently online — brings the disconnected/fallen-off ones back without
// touching working modems (so live client sessions aren't disrupted).
r.post('/api/admin/reconnect_all', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { serverName } = req.body;
    if (!serverName) return res.status(400).json({ error: 'serverName required' });
    const server = findServer(serverName);
    if (!server) return res.status(400).json({ error: 'Server not found' });
    const statusData = await fetchApi(server, '/apix/show_status_json');
    const modems = Array.isArray(statusData) ? statusData : [];
    let total = 0, done = 0, failed = 0;
    for (const m of modems) {
      const nd = m.net_details || {}, md = m.modem_details || {};
      const dev = nd.DEV;
      const nick = (md.NICK || '').trim();
      if (!dev) continue;                       // can't re-add without a device path
      if (/^random/i.test(nick)) continue;      // phantom port — skip
      if (nd.IS_ONLINE === 'yes') continue;     // already working — don't disrupt
      total++;
      try { await postFormApi(server, '/modem/add_dev', { DEV: dev }); done++; }
      catch (_) { failed++; }
    }
    logger.info(`[Admin] Reconnect-all ${serverName}: re-added ${done}/${total} offline modems (${failed} failed)`);
    auditLog(req.user.login, 'reconnect_all', { serverName, total, done, failed, ip: getClientIp(req) });
    proxySmart.invalidateCache();
    res.json({ ok: true, total, reconnected: done, failed });
  } catch (err) { res.status(502).json({ error: 'Reconnect-all failed', details: err.message }); }
});

r.post('/api/admin/store_modem', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { serverName, ...modemData } = req.body;
    if (!serverName || !modemData.IMEI) return res.status(400).json({ error: 'serverName and IMEI required' });
    const server = findServer(serverName);
    if (!server) return res.status(400).json({ error: 'Server not found' });
    // Strip server prefix from IMEI (e.g. "S2_012345" → "012345")
    const rawImei = modemData.IMEI.replace(/^S\d+_/, '');
    modemData.IMEI = rawImei;
    // First GET current config to preserve existing fields
    const confHtml = await fetchApiRaw(server, `/conf/edit/${rawImei}`);
    const html = confHtml.buffer ? confHtml.buffer.toString('utf8') : String(confHtml);
    const currentFields = {};
    const fieldMatches = html.matchAll(/name="([^"]+)"[^>]*value="([^"]*)"/g);
    for (const fm of fieldMatches) currentFields[fm[1]] = fm[2];
    // Merge: user changes override current values, keep rest
    const merged = { ...currentFields, ...modemData };
    // Remove empty values that were not in original
    for (const k of Object.keys(merged)) {
      if (merged[k] === '' && currentFields[k]) merged[k] = currentFields[k];
    }
    logger.info({ merged, rawImei, serverName }, '[StoreModem] Sending to API server');
    const result = await postFormApi(server, `/conf/edit/${rawImei}`, merged);
    logger.info({ status: result.status }, '[StoreModem] Response');
    auditLog(req.user.login, 'store_modem', { serverName, IMEI: rawImei, ip: getClientIp(req) });
    // Update rotation cache immediately so dashboard reflects the change
    const newRot = parseInt(modemData.AUTO_IP_ROTATION) || 0;
    modemRotationCache[serverName + ':' + rawImei] = newRot;
    proxySmart.invalidateCache(); // invalidate data cache
    res.json({ ok: true, result });
  } catch (err) { res.status(502).json({ error: 'Store modem failed', details: err.message }); }
});

r.post('/api/admin/apply_modem', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    let { serverName, imei } = req.body;
    if (!serverName || !imei) return res.status(400).json({ error: 'serverName and imei required' });
    const server = findServer(serverName);
    if (!server) return res.status(400).json({ error: 'Server not found' });
    // Strip server prefix from IMEI
    imei = imei.replace(/^S\d+_/, '');
    const result = await postFormApi(server, '/modem/settings', { imei });
    res.json({ ok: true, result });
  } catch (err) { res.status(502).json({ error: 'Apply modem failed', details: err.message }); }
});

r.post('/api/admin/assign_modem', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { serverName, portID, newPortName } = req.body;
    if (!serverName || !portID || !newPortName) return res.status(400).json({ error: 'serverName, portID, newPortName required' });
    const server = findServer(serverName);
    if (!server) return res.status(400).json({ error: 'Server not found' });

    // Read full current form to preserve ALL required fields
    const editPageRaw = await fetchApiRaw(server, `/conf/edit_port/${portID}`);
    const editHtml = editPageRaw?.buffer ? editPageRaw.buffer.toString('utf8') : '';
    const formData = parseHtmlInputFields(editHtml);
    // Get proxy_password from port API data (not in HTML form)
    if (!formData.proxy_password) {
      try {
        const portsData = await fetchApi(server, '/apix/list_ports_json');
        for (const [, plist] of Object.entries(portsData)) {
          for (const port of plist) {
            if (port.portID === portID && port.PASSWORD) { formData.proxy_password = port.PASSWORD; break; }
          }
          if (formData.proxy_password) break;
        }
      } catch (e) { /* ignore */ }
    }
    // Apply the rename
    formData.portName = newPortName;

    const result = await postFormApi(server, `/conf/edit_port/${portID}`, formData);
    logger.info(`[AssignModem] Assigned port ${portID} to "${newPortName}" on ${serverName}`);
    // Invalidate cache so changes appear immediately
    proxySmart.invalidateCache();
    auditLog(req.user.login, 'assign_modem', { serverName, portID, newPortName, ip: getClientIp(req) });
    res.json({ ok: true });
  } catch (err) {
    logger.error('[AssignModem] Error:', err.message);
    res.status(502).json({ error: 'Failed to assign modem', details: err.message });
  }
});

r.get('/api/admin/available_modems', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const results = await fetchAllServersDataCached();
    const available = [];
    for (const data of results) {
      const srvName = data.serverName || '';
      const ports = data.ports || {};
      const status = Array.isArray(data.status) ? data.status : [];
      const modemMap = {};
      status.forEach(m => { const imei = m.modem_details?.IMEI; if (imei) modemMap[imei] = m; });
      for (const imei of Object.keys(ports)) {
        const modemPorts = ports[imei];
        const modem = modemMap[imei];
        const nick = modem?.modem_details?.NICK || imei;
        modemPorts.forEach(p => {
          available.push({
            server: srvName,
            imei,
            nick,
            portID: p.portID,
            portName: p.portName || '',
            httpPort: p.HTTP_PORT,
            socksPort: p.SOCKS_PORT,
            login: p.LOGIN
          });
        });
      }
    }
    res.json({ modems: available });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

r.get('/api/admin/modem_status', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { nick, serverName } = req.query;
    if (!nick || !serverName) return res.status(400).json({ error: 'nick and serverName required' });
    const server = findServer(serverName);
    if (!server) return res.status(400).json({ error: 'Server not found' });
    const result = await fetchApi(server, `/apix/show_single_status_json?arg=${encodeURIComponent(nick)}`);
    res.json(result);
  } catch (err) { res.status(502).json({ error: 'Failed', details: err.message }); }
});

r.get('/api/admin/rotation_log', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { nick, serverName } = req.query;
    if (!nick || !serverName) return res.status(400).json({ error: 'nick and serverName required' });
    const server = findServer(serverName);
    if (!server) return res.status(400).json({ error: 'Server not found' });
    // Fetch fresh data from ProxySmart and sync to DB
    try {
      const result = await fetchApi(server, `/apix/get_rotation_log?arg=${encodeURIComponent(nick)}`);
      const entries = Array.isArray(result) ? result : (result?.log || result?.logs || result?.data || []);
      syncRotationLog(serverName, nick, entries);
    } catch (fetchErr) {
      logger.info(`[RotationLog] API fetch failed for ${nick}@${serverName}: ${fetchErr.message}, serving from DB`);
    }
    // Always return from DB (has synced data + any previous data)
    const rows = _rlSelect.all(serverName, nick);
    res.json(rows);
  } catch (err) { res.status(502).json({ error: 'Failed', details: err.message }); }
});

// ── Замер скорости: запуск в фоне + опрос статуса ───────────────────────
//
// 2026-07-16: замер идёт 30–90 с (речь про реальный speedtest.net через
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

r.get('/api/admin/ip_history', authMiddleware, adminMiddleware, (req, res) => {
  const { key } = req.query;
  if (key) {
    res.json(ipHistory[key] || []);
  } else {
    res.json(ipHistory);
  }
});

r.get('/api/admin/sms', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { imei, serverName } = req.query;
    if (!imei || !serverName) return res.status(400).json({ error: 'imei and serverName required' });
    const server = findServer(serverName);
    if (!server) return res.status(400).json({ error: 'Server not found' });
    const result = await fetchApi(server, `/modem/sms/${encodeURIComponent(imei)}?json=1`);
    res.json(result);
  } catch (err) { res.status(502).json({ error: 'Read SMS failed', details: err.message }); }
});

r.post('/api/admin/send_sms', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { imei, serverName, phone, sms } = req.body;
    if (!imei || !serverName || !phone || !sms) return res.status(400).json({ error: 'imei, serverName, phone, sms required' });
    const server = findServer(serverName);
    if (!server) return res.status(400).json({ error: 'Server not found' });
    const result = await postApi(server, '/modem/send-sms', { imei, phone, sms });
    res.json({ ok: true, result });
  } catch (err) { res.status(502).json({ error: 'Send SMS failed', details: err.message }); }
});

r.post('/api/admin/send_ussd', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { imei, serverName, ussd } = req.body;
    if (!imei || !serverName || !ussd) return res.status(400).json({ error: 'imei, serverName, ussd required' });
    const server = findServer(serverName);
    if (!server) return res.status(400).json({ error: 'Server not found' });
    const result = await postApi(server, '/modem/send-ussd', { imei, ussd });
    res.json({ ok: true, result });
  } catch (err) { res.status(502).json({ error: 'Send USSD failed', details: err.message }); }
});

r.post('/api/admin/purge_sms', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { nick, serverName } = req.body;
    if (!nick || !serverName) return res.status(400).json({ error: 'nick and serverName required' });
    const server = findServer(serverName);
    if (!server) return res.status(400).json({ error: 'Server not found' });
    const result = await fetchApi(server, `/apix/purge_sms_json?arg=${encodeURIComponent(nick)}`);
    res.json({ ok: true, result });
  } catch (err) { res.status(502).json({ error: 'Purge SMS failed', details: err.message }); }
});

r.post('/api/admin/store_port', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { serverName, ...portData } = req.body;
    if (!serverName || !portData.IMEI) return res.status(400).json({ error: 'serverName and IMEI required' });
    const server = findServer(serverName);
    if (!server) return res.status(400).json({ error: 'Server not found' });
    const rawImei = portData.IMEI.replace(/^S\d+_/, '');
    if (portData.portName && portData.portName.length < 4) return res.status(400).json({ error: 'portName must be at least 4 characters' });
    // ProxySmart silently rejects port names with characters outside a conservative
    // set — notably '@' (Telegram handles like @yakovlevArtm): the add_port POST
    // 302-redirects back to the form, the port is never written, yet the redirect
    // looks identical to success. Reject upfront with a clear message instead of
    // letting it fail invisibly.
    if (portData.portName && !/^[A-Za-z0-9._-]+$/.test(portData.portName)) {
      return res.status(400).json({ error: 'Имя порта: только латиница, цифры, точка, _ и - (без @, пробелов и спецсимволов — ProxySmart их не принимает).' });
    }
    // Reject an accidental duplicate: the SAME portName already on THIS modem. A
    // modem may legitimately host several ports with DIFFERENT names (e.g. WildBox
    // + yakovlevArtm), and the same client name may live on different modems — so
    // only an exact portName+IMEI match is a dup. That is precisely what a
    // lost-response retry produces (the operator re-submits, thinking it failed).
    if (portData.portName) {
      try {
        const existing = await fetchApi(server, '/apix/list_ports_json');
        const onModem = (existing && existing[rawImei]) || [];
        if (Array.isArray(onModem) && onModem.some(p => p && p.portName === portData.portName)) {
          return res.status(409).json({ error: `Порт «${portData.portName}» уже существует на этом модеме — дубль не создан.` });
        }
      } catch (e) {
        logger.warn(`[store_port] dup-check failed for ${rawImei}: ${e.message}`);   // best-effort, don't block a real create
      }
    }
    // GET pre-filled form values from ProxySmart (portID, http_port, login, password)
    const formHtml = await fetchApiRaw(server, `/conf/add_port?imei=${rawImei}`);
    const html = formHtml.buffer ? formHtml.buffer.toString('utf8') : String(formHtml);
    const prefilled = parseHtmlInputFields(html);

    // Sanity check — without portID and http_port the form will fail server-side
    if (!prefilled.portID) {
      return res.status(502).json({ error: 'add_port form returned no portID', html_snippet: html.slice(0, 300) });
    }

    // Merge: user values override pre-filled, but only for fields the form supports.
    // portID/proxy_login/proxy_password generated by ProxySmart are used as-is unless user supplied a value.
    const formData = { ...prefilled };
    if (portData.portName) formData.portName = portData.portName;
    // IMPORTANT: do NOT override http_port/socks_port with the caller's values.
    // ProxySmart prefills a MATCHED pair from two distinct pools (e.g. http=8029,
    // socks=5029). The frontend used to pass http+socks as two CONSECUTIVE entries
    // from /api/admin/free_ports (e.g. 8029 + 8030) — a socks port in the HTTP
    // range. ProxySmart silently REJECTS that (the add_port POST 302-redirects back
    // to the form, the port is never written to its DB), so the port "создавался,
    // но не появлялся". Always trust ProxySmart's prefilled http/socks pair.
    if (portData.proxy_login    && prefilled.proxy_login    !== undefined) formData.proxy_login    = portData.proxy_login;
    if (portData.proxy_password && prefilled.proxy_password !== undefined) formData.proxy_password = portData.proxy_password;

    const actualPortId = formData.portID;

    // Submit the form. postFormApi now rejects on HTTP 4xx/5xx (was silently
    // swallowing failures before).
    await postFormApi(server, `/conf/add_port?imei=${rawImei}`, formData);

    // Auto-apply the new port. Previously the frontend had to make a second
    // request, but it was passing the client-side generated portID instead of
    // the one ProxySmart actually used → apply_port always 404'd → port was
    // created but never activated. Doing it here uses the authoritative ID.
    let applied = false;
    try {
      await fetchApi(server, `/apix/apply_port?arg=${encodeURIComponent(actualPortId)}`);
      applied = true;
    } catch (e) {
      logger.warn(`[store_port] apply_port failed for ${actualPortId}: ${e.message}`);
    }

    proxySmart.invalidateCache();
    // ProxySmart returns a 302 on BOTH a successful add AND a silent validation
    // reject (see the portName note above), and postFormApi can't tell them apart.
    // Confirm the port actually landed in the live port list before reporting
    // success — otherwise we'd log a phantom "port_created" and the operator would
    // retry, stacking duplicates (which then collide on the same port-pair).
    let persisted = true;
    try {
      const listRaw = await fetchApi(server, '/apix/list_ports_json');
      persisted = JSON.stringify(listRaw || '').includes(actualPortId);
    } catch (e) {
      logger.warn(`[store_port] persistence check failed for ${actualPortId}: ${e.message}`);
    }
    if (!persisted) {
      logger.warn(`[store_port] port ${actualPortId} did NOT persist — ProxySmart rejected the add (portName=${JSON.stringify(portData.portName)})`);
      return res.status(422).json({ ok: false, error: 'ProxySmart не сохранил порт (отклонён). Частая причина — недопустимое имя порта. Порт НЕ создан, повтор не нужен.' });
    }

    auditLog(req.user.login, 'store_port', { serverName, IMEI: rawImei, portName: portData.portName, portId: actualPortId, applied, ip: getClientIp(req) });
    logActivity('modem', 'info', 'port_created', portData.portName || actualPortId, `Port created on ${serverName}/${rawImei} (id=${actualPortId})`, { applied });
    res.json({ ok: true, portId: actualPortId, applied,
      http_port: formData.http_port, socks_port: formData.socks_port, proxy_login: formData.proxy_login });
  } catch (err) {
    logger.error('[store_port] ' + err.message);
    res.status(502).json({ error: 'Store port failed', details: err.message });
  }
});

r.post('/api/admin/move_port', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { serverName, portID, newIMEI } = req.body;
    if (!serverName || !portID || !newIMEI) return res.status(400).json({ error: 'serverName, portID, newIMEI required' });
    const server = findServer(serverName);
    if (!server) return res.status(400).json({ error: 'Server not found' });
    // Read full current port form
    const raw = await fetchApiRaw(server, `/conf/edit_port/${portID}`);
    const html = raw?.buffer ? raw.buffer.toString('utf8') : '';
    const formData = parseHtmlInputFields(html);
    // Get proxy_password from port API
    if (!formData.proxy_password) {
      try {
        const portsData = await fetchApi(server, '/apix/list_ports_json');
        for (const [, plist] of Object.entries(portsData)) {
          for (const port of plist) {
            if (port.portID === portID && port.PASSWORD) { formData.proxy_password = port.PASSWORD; break; }
          }
          if (formData.proxy_password) break;
        }
      } catch (e) { /* ignore */ }
    }
    // Change IMEI to move port to new modem
    formData.IMEI = newIMEI;
    await postFormApi(server, `/conf/edit_port/${portID}`, formData);
    // Re-apply so ProxySmart picks up the new IMEI binding
    try { await fetchApi(server, `/apix/apply_port?arg=${encodeURIComponent(portID)}`); }
    catch (e) { logger.warn(`[move_port] apply_port failed for ${portID}: ${e.message}`); }
    auditLog(req.user.login, 'move_port', { serverName, portID, newIMEI, ip: getClientIp(req) });
    proxySmart.invalidateCache();
    res.json({ ok: true });
  } catch (err) { res.status(502).json({ error: 'Move port failed', details: err.message }); }
});

r.post('/api/admin/update_port_creds', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { serverName, IMEI, portID, proxy_login, proxy_password } = req.body;
    if (!serverName || !IMEI || !portID) return res.status(400).json({ error: 'serverName, IMEI, portID required' });
    if (!proxy_login && !proxy_password) return res.status(400).json({ error: 'proxy_login or proxy_password required' });
    const server = findServer(serverName);
    if (!server) return res.status(400).json({ error: 'Server not found' });
    // Send to ProxySmart store_port (updates existing port)
    const portData = { IMEI, portID };
    if (proxy_login) portData.proxy_login = proxy_login;
    if (proxy_password) portData.proxy_password = proxy_password;
    const storeResult = await postApi(server, '/crud/store_port', portData);
    // Apply changes
    const applyResult = await fetchApi(server, `/apix/apply_port?arg=${encodeURIComponent(portID)}`);
    res.json({ ok: true, storeResult, applyResult });
  } catch (err) { res.status(502).json({ error: 'Update credentials failed', details: err.message }); }
});

r.get('/api/admin/get_port_config', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { serverName, portId } = req.query;
    if (!serverName || !portId) return res.status(400).json({ error: 'serverName and portId required' });
    const server = findServer(serverName);
    if (!server) return res.status(400).json({ error: 'Server not found' });
    const raw = await fetchApiRaw(server, `/conf/edit_port/${portId}`);
    const html = raw?.buffer ? raw.buffer.toString('utf8') : '';
    const extract = (name) => {
      const m = html.match(new RegExp(`name="${name}"[^>]*value="([^"]*)"`));
      if (m) return m[1];
      const m2 = html.match(new RegExp(`value="([^"]*)"[^>]*name="${name}"`));
      return m2 ? m2[1] : '';
    };
    const extractSelected = (name) => {
      const re = new RegExp(`<select[^>]*name="${name}"[\\s\\S]*?</select>`);
      const blockM = html.match(re);
      if (!blockM) return '';
      const block = blockM[0];
      const sel = block.match(/<option[^>]*selected[^>]*value\s*=\s*"([^"]*)"/);
      if (sel) return sel[1];
      const sel2 = block.match(/<option[^>]*value\s*=\s*"([^"]*)"[^>]*selected/);
      return sel2 ? sel2[1] : '';
    };
    res.json({
      portID: extract('portID') || portId,
      portName: extract('portName'),
      http_port: extract('http_port'),
      socks_port: extract('socks_port'),
      proxy_login: extract('proxy_login'),
      proxy_password: extract('proxy_password'),
      MAXCONN: extract('MAXCONN'),
      CONNLIM: extract('CONNLIM'),
      bandlimin: extract('bandlimin'),
      bandlimout: extract('bandlimout'),
      bw_quota: extract('bw_quota'),
      QUOTA_TYPE: extractSelected('QUOTA_TYPE'),
      QUOTA_DIRECTION: extractSelected('QUOTA_DIRECTION'),
      PROXY_VALID_BEFORE: extract('PROXY_VALID_BEFORE'),
      CREATED_AT: extract('CREATED_AT'),
      OS: extractSelected('OS'),
      IP_MODE: extractSelected('IP_MODE'),
    });
  } catch (err) {
    logger.error('[GetPortConfig]', err.message);
    res.status(502).json({ error: 'Get port config failed', details: err.message });
  }
});

r.post('/api/admin/save_port_config', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { serverName, portId, ...fields } = req.body;
    if (!serverName || !portId) return res.status(400).json({ error: 'serverName and portId required' });
    const server = findServer(serverName);
    if (!server) return res.status(400).json({ error: 'Server not found' });
    // Batch 2: validate numeric limit fields BEFORE they reach ProxySmart.
    // ProxySmart silently rejects malformed input (302-redirects back to the
    // form, change lost, no error) — same trap as the portName gotcha. Catch
    // it here with a clear 400 instead of a phantom "сохранено".
    const _numLimitFields = ['MAXCONN', 'CONNLIM', 'bandlimin', 'bandlimout', 'bw_quota'];
    for (const f of _numLimitFields) {
      const v = fields[f];
      if (v === undefined || v === null || String(v).trim() === '') continue;
      const n = Number(v);
      if (!Number.isInteger(n) || n < 0) {
        return res.status(400).json({ error: `Поле ${f}: ожидается целое число ≥ 0 (0 = без лимита).` });
      }
      fields[f] = String(n);
    }
    // Read full current form to preserve ALL required fields
    const raw = await fetchApiRaw(server, `/conf/edit_port/${portId}`);
    const html = raw?.buffer ? raw.buffer.toString('utf8') : '';
    const formData = parseHtmlInputFields(html);
    // Get proxy_password from port API data (not in HTML form)
    if (!formData.proxy_password) {
      try {
        const portsData = await fetchApi(server, '/apix/list_ports_json');
        for (const [, plist] of Object.entries(portsData)) {
          for (const port of plist) {
            if (port.portID === portId && port.PASSWORD) { formData.proxy_password = port.PASSWORD; break; }
          }
          if (formData.proxy_password) break;
        }
      } catch (e) { /* ignore — password may already be in fields */ }
    }
    // Merge user changes on top of current values
    for (const [k, v] of Object.entries(fields)) {
      if (k === 'OS_SPOOF') formData.OS = v; // Map dashboard → ProxySmart field names
      else if (k === 'IP_VERSION') formData.IP_MODE = v;
      else formData[k] = v;
    }
    // Remove internal fields not needed by ProxySmart form
    delete formData.serverName; delete formData.OS_SPOOF; delete formData.IP_VERSION;
    const result = await postFormApi(server, `/conf/edit_port/${portId}`, formData);
    // Apply the port changes
    await fetchApi(server, `/apix/apply_port?arg=${encodeURIComponent(portId)}`);
    proxySmart.invalidateCache();
    auditLog(req.user.login, 'save_port_config', { serverName, portId, fields: Object.keys(fields), ip: getClientIp(req) });
    const success = result.status === 302 || result.status === 200;
    res.json({ ok: success, status: result.status });
  } catch (err) {
    logger.error('[SavePortConfig]', err.message);
    res.status(502).json({ error: 'Save port config failed', details: err.message });
  }
});

r.post('/api/admin/bulk_os_spoof', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { ports, os } = req.body;
    if (!Array.isArray(ports) || !ports.length) return res.status(400).json({ error: 'ports array required' });
    // Pre-fetch passwords per server (cache list_ports_json once per server)
    const pwCache = {};
    const serverNames = [...new Set(ports.map(p => p.serverName))];
    for (const sn of serverNames) {
      const server = findServer(sn);
      if (!server) continue;
      try {
        const portsData = await fetchApi(server, '/apix/list_ports_json');
        pwCache[sn] = {};
        for (const [, plist] of Object.entries(portsData)) {
          for (const port of plist) {
            if (port.portID && port.PASSWORD) pwCache[sn][port.portID] = port.PASSWORD;
          }
        }
      } catch (e) { logger.warn(`[BulkOS] Failed to fetch ports for ${sn}: ${e.message}`); }
    }
    let ok = 0, failed = 0;
    for (const p of ports) {
      try {
        const server = findServer(p.serverName);
        if (!server) { failed++; continue; }
        const raw = await fetchApiRaw(server, `/conf/edit_port/${p.portId}`);
        const html = raw?.buffer ? raw.buffer.toString('utf8') : '';
        const fields = parseHtmlInputFields(html);
        // Password from pre-fetched cache
        const pw = (pwCache[p.serverName] || {})[p.portId];
        if (pw) fields.proxy_password = pw;
        fields.OS = os || '';
        const result = await postFormApi(server, `/conf/edit_port/${p.portId}`, fields);
        if (result.status === 302 || result.status === 200) ok++;
        else failed++;
      } catch (e) { failed++; }
    }
    proxySmart.invalidateCache();
    auditLog(req.user.login, 'bulk_os_spoof', { os, count: ports.length, ok, failed, ip: getClientIp(req) });
    res.json({ ok: true, updated: ok, failed });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

r.post('/api/admin/bulk_rotation', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { modems, rotation } = req.body;
    if (!Array.isArray(modems) || !modems.length) return res.status(400).json({ error: 'modems array required' });
    const rotVal = String(rotation != null ? rotation : 10);
    let ok = 0, failed = 0;
    for (const m of modems) {
      try {
        const server = findServer(m.serverName);
        if (!server) { failed++; continue; }
        const raw = await fetchApiRaw(server, `/conf/edit/${m.imei}`);
        const html = raw?.buffer ? raw.buffer.toString('utf8') : '';
        const fields = parseHtmlInputFields(html);
        fields.AUTO_IP_ROTATION = rotVal;
        await postFormApi(server, `/conf/edit/${m.imei}`, fields);
        modemRotationCache[m.serverName + ':' + m.imei] = parseInt(rotVal) || 0;
        ok++;
      } catch (e) { failed++; }
    }
    proxySmart.invalidateCache();
    auditLog(req.user.login, 'bulk_rotation', { rotation: rotVal, count: modems.length, ok, failed, ip: getClientIp(req) });
    res.json({ ok: true, updated: ok, failed });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

r.post('/api/admin/apply_port', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { portId, serverName } = req.body;
    if (!portId || !serverName) return res.status(400).json({ error: 'portId and serverName required' });
    const server = findServer(serverName);
    if (!server) return res.status(400).json({ error: 'Server not found' });
    const result = await fetchApi(server, `/apix/apply_port?arg=${encodeURIComponent(portId)}`);
    res.json({ ok: true, result });
  } catch (err) { res.status(502).json({ error: 'Apply port failed', details: err.message }); }
});

r.post('/api/admin/purge_port', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { portId, serverName } = req.body;
    if (!portId || !serverName) return res.status(400).json({ error: 'portId and serverName required' });
    const server = findServer(serverName);
    if (!server) return res.status(400).json({ error: 'Server not found' });
    const result = await fetchApi(server, `/conf/delete_port/${encodeURIComponent(portId)}`);
    logger.info(`[Admin] Deleted port ${portId} from ${serverName}`);
    res.json({ ok: true, result });
  } catch (err) { res.status(502).json({ error: 'Delete port failed', details: err.message }); }
});

r.get('/api/admin/free_ports', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { serverName } = req.query;
    if (!serverName) return res.status(400).json({ error: 'serverName required' });
    const server = findServer(serverName);
    if (!server) return res.status(400).json({ error: 'Server not found' });
    const result = await fetchApi(server, '/apix/get_free_tcp_ports');
    res.json(result);
  } catch (err) { res.status(502).json({ error: 'Failed', details: err.message }); }
});

  return r;
};
