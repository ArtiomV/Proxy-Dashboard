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
    proxyConf,
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
    // First GET current config to preserve existing fields. proxyConf обходит
    // логин-стену /conf/* (S2): раньше POST улетал в /modem/login, а фронт
    // получал ok:true — «сохранено», хотя ProxySmart ничего не менял.
    const form = await proxyConf.getConfForm(server, `/conf/edit/${rawImei}`);
    if (!form.ok) {
      logger.warn({ serverName, rawImei, reason: form.reason }, '[StoreModem] /conf/edit недоступен — настройки НЕ сохранены');
      return res.status(502).json({ error: `ProxySmart не отдал форму модема (${form.reason}) — настройки НЕ сохранены` });
    }
    const currentFields = form.fields;
    // Merge: user changes override current values, keep rest
    const merged = { ...currentFields, ...modemData };
    // Remove empty values that were not in original
    for (const k of Object.keys(merged)) {
      if (merged[k] === '' && currentFields[k]) merged[k] = currentFields[k];
    }
    const posted = await proxyConf.postConfForm(server, `/conf/edit/${rawImei}`, merged);
    if (!posted.ok) {
      logger.warn({ serverName, rawImei, reason: posted.reason }, '[StoreModem] POST не прошёл');
      return res.status(502).json({ error: `ProxySmart не сохранил настройки (${posted.reason})` });
    }
    // Verify-after-write: перечитываем форму и сверяем ротацию, если её меняли.
    // Кэш UI обновляем ТОЛЬКО подтверждённым значением (и только если поле
    // вообще прислали — раньше любой save без ротации затирал кэш нулём).
    const wantRot = modemData.AUTO_IP_ROTATION != null ? (parseInt(modemData.AUTO_IP_ROTATION) || 0) : null;
    if (wantRot != null) {
      const back = await proxyConf.getConfForm(server, `/conf/edit/${rawImei}`);
      const gotRot = back.ok ? proxyConf.parseRotation(back.html) : null;
      if (gotRot !== wantRot) {
        logger.warn({ serverName, rawImei, wantRot, gotRot, backReason: back.ok ? null : back.reason }, '[StoreModem] verify-after-write FAILED');
        return res.status(502).json({ error: `ProxySmart не применил AUTO_IP_ROTATION: запрошено ${wantRot}, в форме ${gotRot == null ? 'нет данных' : gotRot}` });
      }
      modemRotationCache[serverName + ':' + rawImei] = wantRot;
    }
    logger.info({ rawImei, serverName, verified: wantRot != null }, '[StoreModem] saved');
    auditLog(req.user.login, 'store_modem', { serverName, IMEI: rawImei, ip: getClientIp(req) });
    proxySmart.invalidateCache(); // invalidate data cache
    res.json({ ok: true, verified: wantRot != null });
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

    // Read full current form to preserve ALL required fields (через proxyConf — обход логин-стены S2)
    const asForm = await proxyConf.getConfForm(server, `/conf/edit_port/${portID}`);
    if (!asForm.ok) return res.status(502).json({ error: `ProxySmart не отдал форму порта (${asForm.reason})` });
    const formData = parseHtmlInputFields(asForm.html);
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

    const asPosted = await proxyConf.postConfForm(server, `/conf/edit_port/${portID}`, formData);
    if (!asPosted.ok) return res.status(502).json({ error: `ProxySmart не сохранил привязку (${asPosted.reason})` });
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
