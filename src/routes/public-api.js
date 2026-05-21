'use strict';
//
// src/routes/public-api.js — programmatic /api/v1/* endpoints (Stage 3).
//
// Two endpoints, both apiKey-authenticated (X-API-Key header or ?apiKey=…):
//   GET /api/v1/proxy     — JSON: proxies + billing summary for the client
//   GET /api/v1/proxies   — JSON / TXT / CSV: bare proxy list
//
// These are the only externally-callable endpoints — used by client scripts
// to pull current proxy credentials. Subject to api_usage rate logging
// (handled by middleware in server.js, not by this router).

const express = require('express');

module.exports = function createPublicApiRouter(deps) {
  const {
    _readApiKey,
    fetchAllServersDataCached, mergeServerData,
    extractServerName, SERVER_COUNTRIES,
    parseBwToBytes, trafficBytesToGb,
    getClientByApiKey, getClientByLogin,
  } = deps;
  const r = express.Router();

  r.get('/api/v1/proxy', async (req, res) => {
    const apiKey = _readApiKey(req, res);
    if (!apiKey) return res.status(401).json({ success: false, error: 'API key required. Pass via X-API-Key header.' });

    const client = getClientByApiKey(apiKey);
    if (!client) return res.status(401).json({ success: false, error: 'Invalid API key' });

    try {
      const results = await fetchAllServersDataCached();
      const merged = mergeServerData(results, client.portName);

      const COUNTRIES = SERVER_COUNTRIES;

      const proxies = [];
      for (const [imei, portList] of Object.entries(merged.ports)) {
        const serverName = extractServerName(imei);
        const ci = COUNTRIES[serverName] || {};
        let modemNick = imei;
        let operator = '', isOnline = false;
        for (const m of merged.status) {
          if (m.modem_details && m.modem_details.IMEI === imei) {
            modemNick = m.modem_details.NICK || imei;
            operator = (m.net_details && m.net_details.CELLOP) || '';
            isOnline = m.net_details && m.net_details.IS_ONLINE === 'yes';
            break;
          }
        }
        for (const p of portList) {
          if (p.LOGIN && p.PASSWORD && ci.serverIp) {
            const changeIpUrl = (p.RESET_SECURE_LINK && p.RESET_SECURE_LINK.URL) || '';
            proxies.push({
              id: modemNick,
              host: ci.serverIp,
              ports: { http: parseInt(p.HTTP_PORT) || 0, socks5: parseInt(p.SOCKS_PORT) || 0 },
              username: p.LOGIN,
              password: p.PASSWORD,
              country: ci.country || '',
              country_name: ci.name || '',
              operator,
              online: isOnline,
              change_ip_url: changeIpUrl
            });
          }
        }
      }

      // Billing
      const clientInfo = getClientByLogin(client.login);
      const totalPayments = clientInfo ? (clientInfo.payments || []).reduce((s, p) => s + (parseFloat(p.amount) || 0), 0) : 0;

      // Bandwidth totals (in MB) — use parseBwToBytes → GB → MB
      let monthBytes = 0;
      for (const b of Object.values(merged.bandwidth)) {
        monthBytes += parseBwToBytes(b.bandwidth_bytes_month_in);
        monthBytes += parseBwToBytes(b.bandwidth_bytes_month_out);
      }
      const monthMb = Math.round(trafficBytesToGb(monthBytes) * 1024);

      res.json({
        success: true,
        client: client.name,
        billing: {
          type: (clientInfo && clientInfo.billingType) || 'per_gb',
          price_per_gb: (clientInfo && clientInfo.price) || 0,
          currency: (clientInfo && clientInfo.currency) || 'RUB',
          balance: clientInfo && clientInfo.balance !== undefined ? clientInfo.balance : totalPayments,
          usage_mb: Math.round(monthMb)
        },
        proxies,
        proxy_count: proxies.length
      });
    } catch (_err) {
      res.status(502).json({ success: false, error: 'Failed to fetch proxy data' });
    }
  });

  r.get('/api/v1/proxies', async (req, res) => {
    const { apiKey, format } = req.query;
    if (!apiKey) return res.status(400).json({ error: 'apiKey required' });

    const client = getClientByApiKey(apiKey);
    if (!client) return res.status(401).json({ error: 'Invalid API key' });

    try {
      const results = await fetchAllServersDataCached();
      const merged = mergeServerData(results, client.portName);

      const COUNTRIES = SERVER_COUNTRIES;
      const proxies = [];

      for (const [imei, portList] of Object.entries(merged.ports)) {
        const serverName = extractServerName(imei);
        const ci = COUNTRIES[serverName] || {};
        let modemNick = imei;
        for (const m of merged.status) {
          if (m.modem_details && m.modem_details.IMEI === imei) { modemNick = m.modem_details.NICK || imei; break; }
        }
        for (const p of portList) {
          if (p.LOGIN && p.PASSWORD && ci.serverIp) {
            proxies.push({
              modem: modemNick,
              ip: ci.serverIp,
              httpPort: parseInt(p.HTTP_PORT) || 0,
              socksPort: parseInt(p.SOCKS_PORT) || 0,
              login: p.LOGIN,
              password: p.PASSWORD,
              resetUrl: (p.RESET_SECURE_LINK && p.RESET_SECURE_LINK.URL) || ''
            });
          }
        }
      }

      const fmt = (format || 'json').toLowerCase();
      if (fmt === 'txt') {
        const lines = proxies.map(p => `${p.ip}:${p.httpPort}:${p.login}:${p.password}|${p.resetUrl}`);
        res.type('text/plain').send(lines.join('\n'));
      } else if (fmt === 'csv') {
        const lines = ['ip,http_port,socks_port,login,password,reset_url'];
        proxies.forEach(p => lines.push([p.ip, p.httpPort, p.socksPort, p.login, p.password, p.resetUrl].join(',')));
        res.type('text/csv').send(lines.join('\n'));
      } else {
        res.json({ proxies, count: proxies.length, client: client.name });
      }
    } catch (_err) {
      res.status(502).json({ error: 'Failed to fetch proxy data' });
    }
  });

  return r;
};
