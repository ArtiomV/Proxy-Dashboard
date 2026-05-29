'use strict';
//
// src/routes/proxy-checks.js — proxy health-check + top-hosts (Stage 3).
//
// 6 routes:
//   GET  /api/admin/proxy_checks            — latency history per modem
//   POST /api/admin/proxy_check             — manual single/bulk latency probe
//   GET  /api/admin/top_hosts               — live top domains snapshot
//   GET  /api/admin/top_hosts_aggregated    — cached aggregate
//   POST /api/admin/top_hosts_refresh       — force re-aggregation
//   POST /api/tools/check_proxy             — client-tool: test arbitrary proxy list

const express = require('express');
const http = require('http');
const https = require('https');
const net = require('net');

module.exports = function createProxyChecksRouter(deps) {
  const {
    db, logger, authMiddleware, adminMiddleware, checkProxyLimiter,
    fetchAllServersDataCached, fetchApi, findServer,
    apiServers, SERVER_COUNTRIES,
    curlCheckProxy, normalizeOperator,
    dbStmts,
    appSettings,
    getTopHostsCache, aggregateTopHosts,
  } = deps;
  const r = express.Router();

r.get('/api/admin/proxy_checks', authMiddleware, adminMiddleware, (req, res) => {
  try {
    const nick = req.query.nick;
    const days = Math.min(parseInt(req.query.days) || 7, 30);
    const since = new Date(Date.now() - days * 86400000).toISOString();
    if (nick) {
      const checks = dbStmts.proxyCheckByNick.all(nick, since);
      res.json({ checks });
    } else {
      const checks = dbStmts.proxyCheckRecent.all(since);
      res.json({ checks });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

r.post('/api/admin/proxy_check', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { modems } = req.body; // [{nick, server}] or single {nick, server}
    const list = Array.isArray(modems) ? modems : (req.body.nick ? [{ nick: req.body.nick, server: req.body.server }] : []);
    if (!list.length) return res.status(400).json({ error: 'No modems specified' });
    if (list.length > 50) return res.status(400).json({ error: 'Max 50 modems per request' });

    const results = await fetchAllServersDataCached();
    const nowIso = new Date().toISOString();

    // Build proxy map: nick+server → proxyUrl
    const proxyMap = {};
    for (const data of results) {
      const srv = data.serverName || '';
      const sc = SERVER_COUNTRIES[srv] || {};
      const serverIp = sc.serverIp || '';
      if (!serverIp) continue;
      const statusArr = Array.isArray(data.status) ? data.status : [];
      const portsMap = data.ports || {};
      const modemInfo = {};
      for (const m of statusArr) {
        const md = m.modem_details || {};
        const imei = md.IMEI;
        if (!imei) continue;
        modemInfo[imei] = { nick: md.NICK || imei, operator: normalizeOperator(m.net_details?.CELLOP, srv === 'S2' || srv.startsWith('S2')) };
      }
      for (const [imei, portList] of Object.entries(portsMap)) {
        const info = modemInfo[imei];
        if (!info) continue;
        for (const p of portList) {
          if (!p.HTTP_PORT || !p.LOGIN || !p.PASSWORD) continue;
          proxyMap[info.nick + '|' + srv] = {
            server: srv, nick: info.nick, client: p.portName || '', operator: info.operator || '',
            proxyUrl: `http://${p.LOGIN}:${p.PASSWORD}@${serverIp}:${p.HTTP_PORT}`,
          };
          break;
        }
      }
    }

    // Run checks
    const checks = [];
    for (const item of list) {
      const key = (item.nick || '') + '|' + (item.server || '');
      const proxy = proxyMap[key];
      if (!proxy) {
        checks.push({ nick: item.nick, server: item.server, error: 'Proxy not found' });
        continue;
      }
      // Unassigned proxies don't accept connections in ProxySmart.
      // Skip the actual check and return a clear explanation instead of
      // a misleading "connection refused" / "407" error.
      if (!proxy.client || !proxy.client.trim()) {
        checks.push({
          nick: proxy.nick, server: proxy.server, client: '',
          operator: proxy.operator, status_code: null, total_ms: null, connect_ms: null,
          error: 'Прокси не в аренде — присвойте portName клиенту, чтобы порт стал активным'
        });
        continue;
      }
      const r = await curlCheckProxy(proxy.proxyUrl);
      const entry = { server: proxy.server, nick: proxy.nick, client: proxy.client, operator: proxy.operator, ...r };
      dbStmts.proxyCheckInsert.run(entry.server, entry.nick, entry.client, entry.operator || '', nowIso, entry.connect_ms, entry.total_ms, entry.status_code, entry.error);
      checks.push(entry);
    }

    res.json({ ok: true, checks });
  } catch (e) {
    logger.error('[ProxyCheck] Manual check error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

r.get('/api/admin/top_hosts', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { portId, serverName } = req.query;
    if (!portId || !serverName) return res.status(400).json({ error: 'portId and serverName required' });
    const server = findServer(serverName);
    if (!server) return res.status(400).json({ error: 'Server not found' });
    const result = await fetchApi(server, `/apix/top_hosts?arg=${encodeURIComponent(portId)}`);
    res.json(result);
  } catch (err) { res.status(502).json({ error: 'Failed', details: err.message }); }
});

r.post('/api/tools/check_proxy', checkProxyLimiter, authMiddleware, async (req, res) => {
  const { proxies } = req.body;
  if (!Array.isArray(proxies) || proxies.length === 0) {
    return res.status(400).json({ error: 'proxies array required' });
  }
  const toCheck = proxies.slice(0, 50);

  // Check targets in order of reliability
  const checkTargets = [
    { url: 'http://api.ipify.org?format=json', host: 'api.ipify.org', parseIp: d => { try { return JSON.parse(d).ip; } catch(e) { return null; } } },
    { url: 'http://ip-api.com/json', host: 'ip-api.com', parseIp: d => { try { return JSON.parse(d).query; } catch(e) { return null; } } }
  ];

  const PRIVATE_IP_RE = /^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|127\.|::1|0\.|169\.254\.|fc|fd)/;
  async function checkOneProxy(proxy) {
    if (PRIVATE_IP_RE.test(proxy.ip)) {
      return { ip: proxy.ip, port: proxy.port, working: false, error: 'Private IP not allowed' };
    }
    const start = Date.now();
    const proxyAuth = proxy.login && proxy.password
      ? `${proxy.login}:${proxy.password}` : null;
    for (const target of checkTargets) {
      try {
        const result = await new Promise((resolve, reject) => {
          const r = http.request({
            hostname: proxy.ip,
            port: parseInt(proxy.port),
            path: target.url,
            method: 'GET',
            headers: {
              'Host': target.host,
              ...(proxyAuth ? { 'Proxy-Authorization': 'Basic ' + Buffer.from(proxyAuth).toString('base64') } : {})
            },
            timeout: 15000
          }, (proxyRes) => {
            let data = '';
            proxyRes.on('data', chunk => data += chunk);
            proxyRes.on('end', () => resolve({ body: data, status: proxyRes.statusCode }));
          });
          r.on('error', reject);
          r.on('timeout', () => { r.destroy(); reject(new Error('Timeout')); });
          r.end();
        });
        if (result.status >= 200 && result.status < 400) {
          const detectedIp = target.parseIp(result.body) || result.body.trim();
          return { ip: proxy.ip, port: proxy.port, working: true, responseTime: Date.now() - start, detectedIp, status: result.status };
        }
      } catch (e) { continue; }
    }
    // TCP fallback — proxy port is open but HTTP check failed
    try {
      await new Promise((resolve, reject) => {
        const sock = new net.Socket();
        sock.setTimeout(5000);
        sock.once('connect', () => { sock.destroy(); resolve(true); });
        sock.once('error', (err) => { sock.removeAllListeners(); sock.destroy(); reject(err); });
        sock.once('timeout', () => { sock.removeAllListeners(); sock.destroy(); reject(new Error('Timeout')); });
        try { sock.connect(parseInt(proxy.port), proxy.ip); } catch (e) { sock.destroy(); reject(e); }
      });
      return { ip: proxy.ip, port: proxy.port, working: true, responseTime: Date.now() - start, detectedIp: '(порт открыт, IP не определён)', status: 0 };
    } catch (e) {
      return { ip: proxy.ip, port: proxy.port, working: false, responseTime: Date.now() - start, error: e.message };
    }
  }

  // Run checks in parallel (batches of 15)
  const results = [];
  for (let i = 0; i < toCheck.length; i += 15) {
    const batch = toCheck.slice(i, i + 15);
    const batchResults = await Promise.all(batch.map(p => checkOneProxy(p)));
    results.push(...batchResults);
  }

  res.json({ results });
});

r.get('/api/admin/top_hosts_aggregated', authMiddleware, adminMiddleware, (req, res) => {
  res.json(getTopHostsCache());
});

r.post('/api/admin/top_hosts_refresh', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const result = await aggregateTopHosts();
    res.json({ ok: true, stats: result.stats, updatedAt: result.updatedAt });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

  return r;
};
