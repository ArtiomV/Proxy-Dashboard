'use strict';
//
// src/routes/proxies.js — modem + port control endpoints (Stage 3).
//
// WP6.5: actions/speedtest/sms/ports carved out to proxies-actions.js,
// proxies-speedtest.js, proxies-sms.js, proxies-ports.js. Kept here:
// modem config (store/apply/assign/available/status), rotation_log, ip_history.

const express = require('express');

module.exports = function createProxiesRouter(deps) {
  const {
    logger, authMiddleware, adminMiddleware,
    fetchApi, fetchApiRaw, postFormApi, findServer,
    parseHtmlInputFields,
    auditLog, getClientIp,
    proxySmart,
    modemRotationCache,
    fetchAllServersDataCached,
    syncRotationLog, _rlSelect,
    pushSpeedtestEntry, ipHistory,
  } = deps;

// (_modemAction moved to src/routes/proxies-actions.js with its callers — WP6.5)


  const r = express.Router();
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
r.get('/api/admin/ip_history', authMiddleware, adminMiddleware, (req, res) => {
  const { key } = req.query;
  if (key) {
    res.json(ipHistory[key] || []);
  } else {
    res.json(ipHistory);
  }
});


  return r;
};
