'use strict';
//
// src/routes/proxies.js — modem + port control endpoints (Stage 3).
//
// 25 admin routes for: reset/reboot/usb_reset modems, port CRUD,
// bulk operations, SMS/USSD send, speedtest queries, IP history.

const express = require('express');
const bcrypt = require('bcrypt');

module.exports = function createProxiesRouter(deps) {
  const {
    db, logger, authMiddleware, adminMiddleware,
    fetchApi, postApi, findServer,
    apiServers, SERVER_COUNTRIES,
    users,
    auditLog, logActivity, getClientIp,
    proxySmart,
    saveKnownModems,
    knownModems,
    saveSpeedtestHistory, speedtestHistory,
    ipHistory,
    saveIpHistory,
    modemRotationCache, saveRotationCache,
    saveModemMeta,
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
    return res.json({ ok: true, result });
  } catch (err) { return res.status(502).json({ error: `${errorLabel} failed`, details: err.message }); }
}

  const r = express.Router();

r.post('/api/admin/reset_ip', authMiddleware, adminMiddleware, (req, res) =>
  _modemAction(req, res, 'imei', v => `/apix/reset_modem_by_imei?IMEI=${encodeURIComponent(v)}`, 'Reset'));

r.post('/api/admin/reboot', authMiddleware, adminMiddleware, (req, res) =>
  _modemAction(req, res, 'imei', v => `/apix/reboot_modem_by_imei?IMEI=${encodeURIComponent(v)}`, 'Reboot'));

r.post('/api/admin/usb_reset', authMiddleware, adminMiddleware, (req, res) =>
  _modemAction(req, res, 'nick', v => `/apix/usb_reset_modem_json?arg=${encodeURIComponent(v)}`, 'USB reset'));

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
    logger.info({ merged, rawImei, serverName }, '[StoreModem] Sending to ProxySmart');
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
      logger.info(`[RotationLog] ProxySmart fetch failed for ${nick}@${serverName}: ${fetchErr.message}, serving from DB`);
    }
    // Always return from DB (has synced data + any previous data)
    const rows = _rlSelect.all(serverName, nick);
    res.json(rows);
  } catch (err) { res.status(502).json({ error: 'Failed', details: err.message }); }
});

r.get('/api/admin/speedtest', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { nick, serverName, imei } = req.query;
    if (!nick || !serverName) return res.status(400).json({ error: 'nick and serverName required' });
    const server = findServer(serverName);
    if (!server) return res.status(400).json({ error: 'Server not found' });
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
    // GET pre-filled form values from ProxySmart (portID, http_port, login, password)
    const formHtml = await fetchApiRaw(server, `/conf/add_port?imei=${rawImei}`);
    const html = formHtml.buffer ? formHtml.buffer.toString('utf8') : String(formHtml);
    const prefilled = parseHtmlInputFields(html);

    // Sanity check — without portID and http_port the form will fail server-side
    if (!prefilled.portID) {
      return res.status(502).json({ error: 'ProxySmart add_port form returned no portID', html_snippet: html.slice(0, 300) });
    }

    // Merge: user values override pre-filled, but only for fields the form supports.
    // portID/proxy_login/proxy_password generated by ProxySmart are used as-is unless user supplied a value.
    const formData = { ...prefilled };
    if (portData.portName) formData.portName = portData.portName;
    if (portData.http_port  && prefilled.http_port  !== undefined) formData.http_port  = portData.http_port;
    if (portData.socks_port && prefilled.socks_port !== undefined) formData.socks_port = portData.socks_port;
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
    auditLog(req.user.login, 'store_port', { serverName, IMEI: rawImei, portName: portData.portName, portId: actualPortId, applied, ip: getClientIp(req) });
    logActivity('modem', 'info', 'port_created', portData.portName || actualPortId, `Port created on ${serverName}/${rawImei} (id=${actualPortId})`, { applied });
    res.json({ ok: true, portId: actualPortId, applied });
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
    logger.info(`[Admin] Deleted port ${portId} from ${serverName} via ProxySmart`);
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
