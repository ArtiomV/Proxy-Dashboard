'use strict';
//
// src/routes/proxy-checks.js — proxy health-check (Stage 3).
//
// 2 routes:
//   GET  /api/admin/top_hosts               — live top domains snapshot
//   POST /api/tools/check_proxy             — client-tool: test arbitrary proxy list
// (top_hosts_aggregated/top_hosts_refresh were removed with #tab-traffic, C4 —
//  the nightly TopHosts job keeps the aggregate cache for itself.)

const express = require('express');
const http = require('http');
const net = require('net');
const dns = require('dns').promises;

module.exports = function createProxyChecksRouter(deps) {
  const {
    authMiddleware, adminMiddleware, checkProxyLimiter,
    fetchApi, findServer,
  } = deps;
  const r = express.Router();

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

// 2026-09-24 · DEEP-61/62: канонизация адресов и честный контракт результата.
// PRIVATE охватывает IPv4 (10/8, 172.16/12, 192.168/16, 127/8, 169.254/16,
// 100.64/10, 0.x) и IPv6 (::1, fc00::/7, fe80::/10, ::ffff: mapped IPv4) —
// старый regex по началу строки пропускал localhost и ::ffff:127.0.0.1.
function _isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const p = ip.split('.').map(Number);
    if (p[0] === 10 || p[0] === 127 || p[0] === 0) return true;
    if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;
    if (p[0] === 192 && p[1] === 168) return true;
    if (p[0] === 169 && p[1] === 254) return true;
    if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return true;
    return false;
  }
  if (net.isIPv6(ip)) {
    const low = ip.toLowerCase();
    if (low === '::1' || low === '::') return true;
    if (low.startsWith('::ffff:')) {
      const mapped = low.slice(7);
      if (net.isIPv4(mapped)) return _isPrivateIp(mapped);
      return true;   // нестандартная mapped-форма — не разрешаем
    }
    if (/^f[cd]/.test(low)) return true;          // fc00::/7
    if (/^fe[89ab]/.test(low)) return true;       // fe80::/10
    return false;
  }
  return true;   // не IP — не адрес для connect
}

// Резолв host в проверенный публичный IP (IP-литерал или DNS: проверяем ВСЕ
// A/AAAA и закрепляем первый публичный — без непроверенного повторного
// разрешения при connect). null → запрет.
async function _resolvePublicHost(host) {
  const raw = String(host || '').trim();
  if (!raw || raw.length > 253) return { error: 'invalid host' };
  if (net.isIP(raw)) return _isPrivateIp(raw) ? { error: 'Private IP not allowed' } : { host: raw };
  if (!/^[a-z0-9._-]+$/i.test(raw)) return { error: 'invalid host' };
  let addrs;
  try { addrs = await dns.lookup(raw, { all: true, verbatim: true }); }
  catch (e) { return { error: 'DNS: ' + e.message }; }
  if (!addrs.length) return { error: 'DNS: no addresses' };
  if (addrs.some(a => _isPrivateIp(a.address))) return { error: 'Private IP not allowed (DNS)' };
  return { host: addrs[0].address };
}

const _IP_OUT_RE = /^(?:\d{1,3}\.){3}\d{1,3}$|^[0-9a-f:]{3,}$/i;
function _validDetectedIp(s) {
  const v = String(s || '').trim();
  return (_IP_OUT_RE.test(v) && (net.isIPv4(v) || net.isIPv6(v))) ? v : null;
}

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

  const MAX_BODY = 64 * 1024;
  async function checkOneProxy(proxy) {
    const start = Date.now();
    // DEEP-61: строгая схема элемента списка ([null] раньше ронял весь Promise).
    if (!proxy || typeof proxy !== 'object') {
      return { ip: null, port: null, working: false, error: 'Invalid proxy entry' };
    }
    const portNum = parseInt(proxy.port, 10);
    if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
      return { ip: proxy.ip || null, port: proxy.port || null, working: false, error: 'Invalid port' };
    }
    const resolved = await _resolvePublicHost(proxy.ip);
    if (resolved.error) {
      return { ip: proxy.ip, port: proxy.port, working: false, error: resolved.error };
    }
    const host = resolved.host;
    const proxyAuth = proxy.login && proxy.password
      ? `${proxy.login}:${proxy.password}` : null;
    for (const target of checkTargets) {
      try {
        const result = await new Promise((resolve, reject) => {
          const r = http.request({
            hostname: host,
            port: portNum,
            path: target.url,
            method: 'GET',
            headers: {
              'Host': target.host,
              ...(proxyAuth ? { 'Proxy-Authorization': 'Basic ' + Buffer.from(proxyAuth).toString('base64') } : {})
            },
            timeout: 10000   // DEEP-62: общий срок на попытку (было 15s без потолка body)
          }, (proxyRes) => {
            const chunks = [];
            let bytes = 0;
            proxyRes.on('data', chunk => {
              const remaining = MAX_BODY - bytes;
              if (remaining > 0) {
                chunks.push(chunk.subarray(0, remaining));
                bytes += Math.min(remaining, chunk.length);
              }
              // DEEP-62: бесконечное тело не накапливаем — за потолком обрываем.
              if (bytes >= MAX_BODY) proxyRes.destroy();
            });
            proxyRes.on('end', () => resolve({ body: Buffer.concat(chunks).toString('utf8'), status: proxyRes.statusCode }));
            proxyRes.on('close', () => {
              if (!proxyRes.complete) resolve({ body: Buffer.concat(chunks).toString('utf8'), status: proxyRes.statusCode || 0, truncated: true });
            });
          });
          r.on('error', reject);
          r.on('timeout', () => { r.destroy(); reject(new Error('Timeout')); });
          r.end();
        });
        if (result.status >= 200 && result.status < 400) {
          // DEEP-62: detectedIp — только валидный адрес, не произвольное тело.
          const detectedIp = _validDetectedIp(target.parseIp(result.body) || result.body.trim());
          return {
            ip: proxy.ip, port: proxy.port,
            working: true, http_ok: true, tcp_reachable: true,
            responseTime: Date.now() - start, detectedIp, status: result.status,
          };
        }
      } catch (e) { continue; }
    }
    // DEEP-62: TCP fallback — это tcp_reachable, НЕ «working прокси»:
    // открытый порт не доказывает авторизацию и передачу HTTP.
    try {
      await new Promise((resolve, reject) => {
        const sock = new net.Socket();
        sock.setTimeout(5000);
        sock.once('connect', () => { sock.destroy(); resolve(true); });
        sock.once('error', (err) => { sock.removeAllListeners(); sock.destroy(); reject(err); });
        sock.once('timeout', () => { sock.removeAllListeners(); sock.destroy(); reject(new Error('Timeout')); });
        try { sock.connect(portNum, host); } catch (e) { sock.destroy(); reject(e); }
      });
      return {
        ip: proxy.ip, port: proxy.port,
        working: false, http_ok: false, tcp_reachable: true,
        responseTime: Date.now() - start, detectedIp: null, status: 0,
        note: 'Порт открыт, но HTTP через прокси не проходит',
      };
    } catch (e) {
      return { ip: proxy.ip, port: proxy.port, working: false, http_ok: false, tcp_reachable: false, responseTime: Date.now() - start, error: e.message };
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

  return r;
};
