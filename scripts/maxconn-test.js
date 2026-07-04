#!/usr/bin/env node
'use strict';
//
// maxconn-test.js — standalone connection-capacity ("maxconn") benchmark for a
// single modem's proxy. Mirrors the ApacheBench-style ramp:
//   for each concurrency level → fire N requests, measure RPS, derive
//   TimePerRequest = conns / RPS * 1000, and success rate.
//
// It resolves the target modem live from ProxySmart (same data the dashboard
// uses), builds http://LOGIN:PASS@serverIp:HTTP_PORT, and never touches the DB.
//
// Usage:
//   node scripts/maxconn-test.js <nick|imei|substring> [options]
//   node scripts/maxconn-test.js --list                 # list resolvable modems
//
// Options:
//   --url <url>        target fetched through the proxy   (default http://api.ipify.org)
//   --levels a,b,c     concurrency levels                  (default 5,10,20,50,100,200)
//   --requests <n>     base requests per level; actual n per level = max(n, conns*3)
//                                                          (default 200)
//   --timeout <ms>     per-request timeout                 (default 15000)
//   --server <name>    restrict resolution to one server (e.g. S1)
//   --pause <ms>       idle gap between levels to drain sockets (default 1500)
//   --html <file>      also write an HTML report like the original page
//   --http             use the HTTP proxy port instead of SOCKS5 (default).
//                      NOTE: the HTTP proxy ports are firewalled to whitelisted
//                      source IPs (e.g. the dashboard server) — from anywhere
//                      else they silently hang. SOCKS5 ports are open, so SOCKS5
//                      is the default. Use --http only when running on a
//                      whitelisted host (the prod dashboard server).
//   --yes              skip the "this hits a live proxy" warning pause
//
// Reads ProxySmart creds from .env (API_<name>_URL/USER/PASS[/PUBLIC_IP]).

const http = require('http');
const https = require('https');
const tls = require('tls');
const { URL } = require('url');

// Load .env from the project root (one level up from scripts/).
try { require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') }); } catch (_) {}

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const o = { url: 'http://api.ipify.org', levels: [5, 10, 20, 50, 100, 200],
    requests: 200, timeout: 15000, server: null, pause: 1500, html: null,
    mode: 'socks5', yes: false, list: false, query: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--list') o.list = true;
    else if (a === '--http') o.mode = 'http';
    else if (a === '--socks5' || a === '--socks') o.mode = 'socks5';
    else if (a === '--yes') o.yes = true;
    else if (a === '--url') o.url = argv[++i];
    else if (a === '--levels') o.levels = argv[++i].split(',').map(s => parseInt(s.trim(), 10)).filter(Boolean);
    else if (a === '--requests') o.requests = parseInt(argv[++i], 10);
    else if (a === '--timeout') o.timeout = parseInt(argv[++i], 10);
    else if (a === '--server') o.server = argv[++i];
    else if (a === '--pause') o.pause = parseInt(argv[++i], 10);
    else if (a === '--html') o.html = argv[++i];
    else if (!a.startsWith('--') && o.query === null) o.query = a;
    else if (!a.startsWith('--')) o.query += ' ' + a; // allow nicks with spaces
  }
  return o;
}

// ---------------------------------------------------------------------------
// ProxySmart fetch (read-only) — gather servers from env
// ---------------------------------------------------------------------------
function getServers() {
  const names = new Set();
  for (const k of Object.keys(process.env)) {
    const m = k.match(/^API_(.+)_URL$/);
    if (m) names.add(m[1]);
  }
  const out = [];
  for (const name of names) {
    const url = process.env[`API_${name}_URL`];
    if (!url) continue;
    out.push({
      name,
      url,
      user: process.env[`API_${name}_USER`] || 'proxy',
      pass: process.env[`API_${name}_PASS`] || 'proxy',
      // serverIp = the public proxy IP — same fallback rule the dashboard uses.
      serverIp: process.env[`API_${name}_PUBLIC_IP`] || new URL(url).hostname,
    });
  }
  return out;
}

function fetchJson(server, apiPath, timeout = 12000) {
  return new Promise((resolve, reject) => {
    const u = new URL(apiPath, server.url);
    const lib = u.protocol === 'https:' ? https : http;
    const auth = Buffer.from(`${server.user}:${server.pass}`).toString('base64');
    const req = lib.request({
      hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: 'GET',
      headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' }, timeout,
    }, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(new Error(`${server.name} parse HTTP ${res.statusCode}`)); } });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error(`${server.name} timeout`)); });
    req.end();
  });
}

// Build a registry: imei → { server, nick, online, operator, ports:[{httpPort,login,pass,portName}] }
async function buildRegistry(servers, restrictServer) {
  const registry = [];
  await Promise.all(servers.map(async (s) => {
    if (restrictServer && s.name !== restrictServer) return;
    let status, ports;
    try {
      [status, ports] = await Promise.all([
        fetchJson(s, '/apix/show_status_json'),
        fetchJson(s, '/apix/list_ports_json'),
      ]);
    } catch (e) {
      process.stderr.write(`[warn] ${s.name} unreachable: ${e.message}\n`);
      return;
    }
    const statusArr = Array.isArray(status) ? status : [];
    const meta = {};
    for (const m of statusArr) {
      const md = m.modem_details || {}, nd = m.net_details || {};
      if (!md.IMEI) continue;
      meta[md.IMEI] = { nick: md.NICK || md.IMEI, online: nd.IS_ONLINE === 'yes', operator: nd.CELLOP || '' };
    }
    const portsMap = (ports && typeof ports === 'object') ? ports : {};
    for (const [imei, list] of Object.entries(portsMap)) {
      if (!Array.isArray(list)) continue;
      const info = meta[imei];
      const usable = list
        .filter(p => p.LOGIN && p.PASSWORD && (p.HTTP_PORT || p.SOCKS_PORT))
        .map(p => ({ httpPort: p.HTTP_PORT, socksPort: p.SOCKS_PORT, login: p.LOGIN, pass: p.PASSWORD, portName: p.portName || '' }));
      if (!usable.length) continue;
      registry.push({
        server: s.name, serverIp: s.serverIp, imei,
        nick: info ? info.nick : imei,
        online: info ? info.online : false,
        operator: info ? info.operator : '',
        ports: usable,
      });
    }
  }));
  return registry;
}

function resolveModem(registry, query) {
  const q = String(query).trim().toLowerCase();
  const byNickExact = registry.filter(r => r.nick.toLowerCase() === q);
  if (byNickExact.length === 1) return { modem: byNickExact[0] };
  const byImeiExact = registry.filter(r => r.imei === query);
  if (byImeiExact.length === 1) return { modem: byImeiExact[0] };
  const sub = registry.filter(r => r.nick.toLowerCase().includes(q) || r.imei.includes(query));
  if (sub.length === 1) return { modem: sub[0] };
  return { modem: null, candidates: (byNickExact.length ? byNickExact : sub) };
}

// ---------------------------------------------------------------------------
// SOCKS5 CONNECT (RFC 1928 + username/password auth RFC 1929) — pure sockets.
// Resolves with a connected socket tunneled to destHost:destPort.
// ---------------------------------------------------------------------------
const net = require('net');
const dns = require('dns').promises;

// destIp MUST be a resolved IPv4 — these proxies' remote DNS (ATYP=domain) hangs,
// exactly like `curl --socks5-hostname`. Local-resolve + ATYP=IPv4 (`curl --socks5`)
// is the path that works, so we always send an address, never a hostname.
function socks5Connect(proxyIp, proxyPort, login, pass, destIp, destPort, timeout) {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host: proxyIp, port: Number(proxyPort) });
    let stage = 'greet';
    let buf = Buffer.alloc(0);
    const fail = (m) => { sock.destroy(); reject(new Error(m)); };
    sock.setTimeout(timeout, () => fail('socks timeout'));
    sock.on('error', (e) => reject(e));
    sock.on('connect', () => sock.write(Buffer.from([0x05, 0x02, 0x00, 0x02]))); // offer no-auth + user/pass
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (stage === 'greet') {
        if (buf.length < 2) return;
        const method = buf[1]; buf = buf.slice(2);
        if (method === 0x00) { stage = 'connect'; sendConnect(); }
        else if (method === 0x02) {
          stage = 'auth';
          const u = Buffer.from(login), p = Buffer.from(pass);
          sock.write(Buffer.concat([Buffer.from([0x01, u.length]), u, Buffer.from([p.length]), p]));
        } else return fail('socks: no acceptable auth method (0x' + method.toString(16) + ')');
      } else if (stage === 'auth') {
        if (buf.length < 2) return;
        const status = buf[1]; buf = buf.slice(2);
        if (status !== 0x00) return fail('socks auth failed');
        stage = 'connect'; sendConnect();
      } else if (stage === 'connect') {
        if (buf.length < 4) return;
        const rep = buf[1], atyp = buf[3];
        if (rep !== 0x00) return fail('socks connect rep 0x' + rep.toString(16));
        const addrLen = atyp === 0x01 ? 4 : atyp === 0x04 ? 16 : atyp === 0x03 ? (buf.length >= 5 ? buf[4] + 1 : 999) : 0;
        const need = 4 + addrLen + 2;
        if (buf.length < need) return;
        buf = buf.slice(need);
        stage = 'done';
        sock.setTimeout(0);
        sock.removeAllListeners('data');
        sock.removeAllListeners('timeout');
        resolve(sock);
      }
    });
    function sendConnect() {
      const octets = destIp.split('.').map(Number); // ATYP 0x01 = IPv4
      sock.write(Buffer.concat([
        Buffer.from([0x05, 0x01, 0x00, 0x01, octets[0], octets[1], octets[2], octets[3]]),
        Buffer.from([(destPort >> 8) & 0xff, destPort & 0xff]),
      ]));
    }
  });
}

// Issue a GET over an already-connected (tunnel) socket; parse the status line.
function tunnelGet(sock, t, timeout, done) {
  const reqLine = `GET ${t.pathname}${t.search} HTTP/1.1\r\nHost: ${t.host}\r\n` +
    `User-Agent: maxconn-test\r\nAccept: */*\r\nConnection: close\r\n\r\n`;
  const layer = t.protocol === 'https:'
    ? tls.connect({ socket: sock, servername: t.hostname }, () => layer.write(reqLine))
    : (sock.write(reqLine), sock);
  let buf = '';
  layer.setTimeout(timeout, () => { layer.destroy(); done(false, 0, 'read timeout'); });
  layer.on('data', (c) => { if (buf.length < 4096) buf += c.toString('latin1'); });
  layer.on('end', () => { const m = buf.match(/^HTTP\/\d\.\d (\d{3})/); const sc = m ? Number(m[1]) : 0; done(sc >= 200 && sc < 400, sc); });
  layer.on('close', () => { if (!buf) done(false, 0, 'closed empty'); });
  layer.on('error', (e) => done(false, 0, e.code || e.message));
}

// ---------------------------------------------------------------------------
// One proxied request — returns { ok, status, ms, err }
// ---------------------------------------------------------------------------
function doRequest(proxy, targetUrl, targetIp, mode, timeout) {
  const start = Date.now();
  const t = new URL(targetUrl);
  let settled = false;
  return new Promise((resolve) => {
    const done = (ok, status, err) => { if (settled) return; settled = true; resolve({ ok, status, ms: Date.now() - start, err: err || null }); };

    if (mode === 'socks5') {
      const port = t.protocol === 'https:' ? (t.port || 443) : (t.port || 80);
      socks5Connect(proxy.serverIp, proxy.socksPort, proxy.login, proxy.pass, targetIp, Number(port), timeout)
        .then((sock) => tunnelGet(sock, t, timeout, done))
        .catch((e) => done(false, 0, e.code || e.message));
      return;
    }

    const auth = 'Basic ' + Buffer.from(`${proxy.login}:${proxy.pass}`).toString('base64');
    if (t.protocol === 'http:') {
      // Absolute-URI GET through the HTTP proxy (Connection: close → fresh TCP per req).
      const req = http.request({
        host: proxy.serverIp, port: Number(proxy.httpPort), method: 'GET', path: targetUrl,
        headers: { Host: t.host, 'Proxy-Authorization': auth, Connection: 'close' }, timeout,
      }, (res) => {
        res.on('data', () => {});
        res.on('end', () => done(res.statusCode >= 200 && res.statusCode < 400, res.statusCode));
        res.on('error', (e) => done(false, res.statusCode, e.message));
      });
      req.on('error', (e) => done(false, 0, e.code || e.message));
      req.on('timeout', () => { req.destroy(); done(false, 0, 'timeout'); });
      req.end();
      return;
    }
    // https target through HTTP proxy → CONNECT, then TLS, then GET.
    const port = t.port || 443;
    const req = http.request({
      host: proxy.serverIp, port: Number(proxy.httpPort), method: 'CONNECT', path: `${t.hostname}:${port}`,
      headers: { 'Proxy-Authorization': auth, Host: `${t.hostname}:${port}` }, timeout,
    });
    req.on('connect', (res, socket) => {
      if (res.statusCode !== 200) { socket.destroy(); return done(false, res.statusCode, 'CONNECT ' + res.statusCode); }
      tunnelGet(socket, t, timeout, done);
    });
    req.on('error', (e) => done(false, 0, e.code || e.message));
    req.on('timeout', () => { req.destroy(); done(false, 0, 'timeout'); });
    req.end();
  });
}

// Fire `total` requests at concurrency `conns`; return level metrics.
async function runLevel(proxy, targetUrl, targetIp, mode, conns, total, timeout) {
  let launched = 0, completed = 0, success = 0;
  const errs = {};
  const t0 = Date.now();
  await new Promise((resolve) => {
    const launchNext = () => {
      if (launched >= total) { if (completed >= total) resolve(); return; }
      launched++;
      doRequest(proxy, targetUrl, targetIp, mode, timeout)
        .then((r) => {
          completed++;
          if (r.ok) success++;
          else errs[r.err || ('HTTP' + r.status)] = (errs[r.err || ('HTTP' + r.status)] || 0) + 1;
          if (completed >= total) resolve(); else launchNext();
        });
    };
    for (let i = 0; i < Math.min(conns, total); i++) launchNext();
  });
  const elapsed = (Date.now() - t0) / 1000;
  const rps = completed / elapsed;
  return {
    conns, total, completed, success,
    successRate: completed ? (success / completed) * 100 : 0,
    rps,
    tpr: rps > 0 ? (conns / rps) * 1000 : 0, // ApacheBench "time per request" (mean)
    elapsed, errs,
  };
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------
function printConsole(modem, proxy, mode, targetUrl, rows) {
  const line = '-'.repeat(78);
  const port = mode === 'socks5' ? proxy.socksPort : proxy.httpPort;
  console.log('\nConnections test result');
  console.log(`IMEI: ${modem.imei}   NICK: ${modem.nick}   server: ${modem.server}`);
  console.log(`proxy: ${proxy.serverIp}:${port} (${mode})   target: ${targetUrl}` +
    (proxy.portName ? `   client: ${proxy.portName}` : '   (порт без аренды)'));
  console.log(line);
  console.log(['Conns'.padStart(6), 'Success%'.padStart(9), 'Req/s'.padStart(9), 'TimePerReq(ms)'.padStart(16), 'n'.padStart(6)].join('  '));
  console.log(line);
  for (const r of rows) {
    console.log([
      String(r.conns).padStart(6),
      r.successRate.toFixed(1).padStart(9),
      r.rps.toFixed(2).padStart(9),
      r.tpr.toFixed(3).padStart(16),
      String(r.completed).padStart(6),
    ].join('  '));
    const errKeys = Object.keys(r.errs);
    if (errKeys.length) console.log('         errors: ' + errKeys.map(k => `${k}×${r.errs[k]}`).join(', '));
  }
  console.log(line);

  // Effective maxconn heuristic: highest level that still keeps ≥95% success AND
  // where throughput is still climbing meaningfully (>8% RPS gain vs the prior
  // level). Once RPS plateaus or success drops, the modem is saturated.
  let best = rows[0];
  for (let i = 1; i < rows.length; i++) {
    const prev = rows[i - 1], cur = rows[i];
    const gain = prev.rps > 0 ? (cur.rps - prev.rps) / prev.rps : 1;
    if (cur.successRate >= 95 && gain >= 0.08) best = cur;
    else break;
  }
  const peak = rows.reduce((a, b) => (b.rps > a.rps ? b : a), rows[0]);
  const stillClimbing = best === rows[rows.length - 1];
  if (stillClimbing) {
    console.log(`\nПотолок ещё НЕ достигнут: на верхнем уровне ${best.conns} коннектов RPS всё ещё растёт ` +
      `(${peak.rps.toFixed(1)} req/s, success ${best.successRate.toFixed(0)}%). Подними уровни, напр. --levels ${rows.map(r=>r.conns).join(',')},${best.conns*2},${best.conns*5}`);
  } else {
    console.log(`\nЭффективный maxconn ≈ ${best.conns} коннектов ` +
      `(пик RPS ${peak.rps.toFixed(1)} @ ${peak.conns}; выше throughput не растёт, латентность линейно вверх).`);
  }
  const dropped = rows.find(r => r.successRate < 95);
  if (dropped) console.log(`⚠ success rate < 95% начиная с ${dropped.conns} коннектов (${dropped.successRate.toFixed(1)}%).`);
  console.log('');
}

function buildHtml(modem, proxy, mode, targetUrl, rows) {
  const port = mode === 'socks5' ? proxy.socksPort : proxy.httpPort;
  const cells = rows.map(r => `    <tr><td>${r.conns}</td><td>${r.successRate.toFixed(0)}</td>` +
    `<td>${r.rps.toFixed(2)}</td><td>${r.tpr.toFixed(3)}</td></tr>`).join('\n');
  return `<!doctype html><html><head><meta charset="utf-8"><title>Connections test result</title>
<style>body{font-family:Georgia,serif;margin:32px}h1{font-size:34px}table{border-collapse:collapse;width:100%;margin-top:20px}
th,td{border:1px solid #000;padding:10px 14px;text-align:center}th{font-weight:bold}</style></head><body>
<h1>Connections test result</h1>
<h3>IMEI: ${modem.imei} &nbsp; NICK: ${modem.nick} &nbsp; server: ${modem.server} &nbsp; proxy: ${proxy.serverIp}:${port} (${mode}) &nbsp; target: ${targetUrl}</h3>
<table><thead><tr><th>Conns</th><th>Success rate</th><th>RequestsPerSecond</th><th>TimePerRequest (ms)</th></tr></thead>
<tbody>
${cells}
</tbody></table></body></html>`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const o = parseArgs(process.argv.slice(2));
  const servers = getServers();
  if (!servers.length) { console.error('No API_<name>_URL servers found in .env'); process.exit(1); }

  const registry = await buildRegistry(servers, o.server);
  if (!registry.length) { console.error('No modems with usable ports resolved from ProxySmart.'); process.exit(1); }

  if (o.list || !o.query) {
    console.log(`\nResolvable modems (${registry.length}):`);
    console.log('server  online  nick                 IMEI              client');
    for (const r of registry.sort((a, b) => (a.server + a.nick).localeCompare(b.server + b.nick))) {
      console.log([r.server.padEnd(6), (r.online ? ' on ' : ' off').padEnd(7),
        r.nick.padEnd(20), r.imei.padEnd(17), (r.ports[0].portName || '—')].join(' '));
    }
    if (!o.query) console.log('\nUsage: node scripts/maxconn-test.js <nick|imei>  (pass a modem above)\n');
    return;
  }

  const { modem, candidates } = resolveModem(registry, o.query);
  if (!modem) {
    console.error(`\n"${o.query}" — ${candidates && candidates.length ? 'неоднозначно, подходят:' : 'не найдено.'}`);
    (candidates || []).forEach(c => console.error(`  ${c.server}  ${c.nick}  ${c.imei}  ${c.ports[0].portName || '—'}`));
    console.error('\nЗапусти с --list, чтобы увидеть все модемы, и укажи точный ник или IMEI.\n');
    process.exit(2);
  }

  // Pick the proxy port: prefer an in-rent (named) port — those actually accept
  // connections in ProxySmart; an unassigned port would just refuse.
  const port = modem.ports.find(p => p.portName && p.portName.trim()) || modem.ports[0];
  const proxy = { serverIp: modem.serverIp, httpPort: port.httpPort, socksPort: port.socksPort,
    login: port.login, pass: port.pass, portName: port.portName };
  const activePort = o.mode === 'socks5' ? proxy.socksPort : proxy.httpPort;
  if (!activePort) {
    console.error(`\nУ порта нет ${o.mode === 'socks5' ? 'SOCKS_PORT' : 'HTTP_PORT'}. Попробуй другой режим (--http / --socks5).\n`);
    process.exit(2);
  }

  if (!modem.online) console.error(`\n⚠ Модем ${modem.nick} помечен OFFLINE в ProxySmart — тест может полностью провалиться.`);
  if (!port.portName) console.error(`\n⚠ У порта нет аренды (portName пуст) — ProxySmart, скорее всего, будет отклонять коннекты.`);
  if (o.mode === 'http') console.error('\n⚠ Режим --http: эти порты зафильтрованы по source-IP. Если ты не на whitelisted-хосте (прод-сервер), всё упадёт в таймаут — используй SOCKS5.');

  console.log(`\nЦель: ${modem.nick} (IMEI ${modem.imei}, ${modem.server}, ${modem.operator || 'оператор ?'})`);
  console.log(`Прокси: ${proxy.serverIp}:${activePort} (${o.mode})  |  target ${o.url}  |  levels ${o.levels.join(',')}  |  base n=${o.requests}`);
  console.log('⚠ Это РЕАЛЬНАЯ нагрузка на живой прокси — на высоких уровнях может задеть клиента на этом модеме.');
  if (!o.yes) {
    process.stdout.write('Старт через 4с (Ctrl-C для отмены, --yes чтобы убрать паузу)...');
    await new Promise(r => setTimeout(r, 4000));
    console.log(' поехали.\n');
  }

  // Resolve the target once locally (the proxies' remote DNS hangs — see socks5Connect).
  let targetIp = new URL(o.url).hostname;
  try { targetIp = (await dns.lookup(new URL(o.url).hostname, { family: 4 })).address; }
  catch (e) { console.error(`\nНе удалось зарезолвить ${o.url}: ${e.message}`); process.exit(1); }

  const rows = [];
  for (const conns of o.levels) {
    const total = Math.max(o.requests, conns * 3);
    process.stdout.write(`  level ${String(conns).padStart(4)}: n=${total} ... `);
    const row = await runLevel(proxy, o.url, targetIp, o.mode, conns, total, o.timeout);
    rows.push(row);
    console.log(`RPS ${row.rps.toFixed(2)}  success ${row.successRate.toFixed(1)}%  TPR ${row.tpr.toFixed(0)}ms`);
    if (o.pause) await new Promise(r => setTimeout(r, o.pause));
  }

  printConsole(modem, proxy, o.mode, o.url, rows);

  if (o.html) {
    require('fs').writeFileSync(o.html, buildHtml(modem, proxy, o.mode, o.url, rows));
    console.log(`HTML отчёт: ${o.html}\n`);
  }
}

main().catch((e) => { console.error('FATAL:', e.message); process.exit(1); });
