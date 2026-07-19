'use strict';
//
// src/routes/proxies-sms.js — SMS/USSD endpoints (WP6.5 carve-out from proxies.js, VERBATIM move).
//
const express = require('express');

module.exports = function createRouter(deps) {
  const {
    authMiddleware, adminMiddleware,
    fetchApi, postApi, findServer,
  } = deps;
  const r = express.Router();
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


  return r;
};
