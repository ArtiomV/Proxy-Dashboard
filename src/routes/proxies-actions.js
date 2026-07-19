'use strict';
//
// src/routes/proxies-actions.js — modem actions: reset/reboot/usb_reset/readd + server ops (WP6.5 carve-out from proxies.js, VERBATIM move).
//
const express = require('express');
const bcrypt = require('bcrypt');

module.exports = function createRouter(deps) {
  const {
    logger, authMiddleware, adminMiddleware,
    fetchApi, postFormApi, findServer,
    users,
    auditLog, getClientIp,
    proxySmart,
  } = deps;
  const r = express.Router();
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
    // Hash-only comparison. The old plaintext fallback compared against the
    // "admin reference" password copy — a downgrade path around bcrypt.
    if (!adminUser.passwordHash) return res.status(403).json({ error: 'Неверный пароль' });
    const pwdValid = await bcrypt.compare(password || '', adminUser.passwordHash);
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
    // Hash-only comparison (see reboot_server above).
    if (!adminUser.passwordHash) return res.status(403).json({ error: 'Неверный пароль' });
    const pwdValid = await bcrypt.compare(password || '', adminUser.passwordHash);
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


  return r;
};
