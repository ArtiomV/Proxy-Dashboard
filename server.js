const express = require('express');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');

// Load .env manually
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#')) {
      const [key, ...vals] = trimmed.split('=');
      process.env[key.trim()] = vals.join('=').trim();
    }
  });
}

const PORT = process.env.PORT || 3000;

// Multiple API servers: API_<name>_URL, API_<name>_USER, API_<name>_PASS
const apiServers = [];
const serverKeys = new Set();
for (const key of Object.keys(process.env)) {
  const m = key.match(/^API_(.+)_URL$/);
  if (m) serverKeys.add(m[1]);
}
for (const name of serverKeys) {
  apiServers.push({
    name,
    url: process.env[`API_${name}_URL`],
    user: process.env[`API_${name}_USER`] || 'proxy',
    pass: process.env[`API_${name}_PASS`] || 'proxy'
  });
}
console.log(`Loaded ${apiServers.length} API server(s): ${apiServers.map(s => s.name + ' (' + s.url + ')').join(', ')}`);

// Modem login mapping: MODEM_LOGIN_<nick>=<login>
const modemLogins = {};
for (const [key, val] of Object.entries(process.env)) {
  if (key.startsWith('MODEM_LOGIN_')) {
    const nick = key.slice(12);
    modemLogins[nick] = val;
  }
}
console.log(`Loaded ${Object.keys(modemLogins).length} modem login mapping(s)`);

// Parse users from .env: USER_<login>=<password>|<portName>
const users = {};
for (const [key, val] of Object.entries(process.env)) {
  if (key.startsWith('USER_')) {
    const login = key.slice(5);
    const pipeIdx = val.indexOf('|');
    if (pipeIdx === -1) continue;
    const password = val.slice(0, pipeIdx);
    const filterPart = val.slice(pipeIdx + 1).trim();
    const portNameFilter = filterPart === '*' ? '*' : filterPart;
    users[login] = { password, portNameFilter, source: 'env' };
  }
}

// ==================== CLIENT MANAGEMENT (JSON storage) ====================
const CLIENTS_FILE = path.join(__dirname, 'clients.json');

function loadClients() {
  try {
    if (fs.existsSync(CLIENTS_FILE)) {
      return JSON.parse(fs.readFileSync(CLIENTS_FILE, 'utf8'));
    }
  } catch (e) { console.error('Failed to load clients:', e.message); }
  return [];
}

function saveClients(clientsList) {
  try { fs.writeFileSync(CLIENTS_FILE, JSON.stringify(clientsList, null, 2)); }
  catch (e) { console.error('Failed to save clients:', e.message); }
}

// ==================== BILLING LEDGER ====================
const BILLING_LEDGER_FILE = path.join(__dirname, 'billing_ledger.json');
let billingLedger = {};
try {
  if (fs.existsSync(BILLING_LEDGER_FILE)) {
    billingLedger = JSON.parse(fs.readFileSync(BILLING_LEDGER_FILE, 'utf8'));
  }
} catch (e) { console.error('Failed to load billing_ledger:', e.message); }

function saveBillingLedger() {
  try { fs.writeFileSync(BILLING_LEDGER_FILE, JSON.stringify(billingLedger, null, 2)); }
  catch (e) { console.error('Failed to save billing_ledger:', e.message); }
}

// Load clients into users map on startup
let clients = loadClients();

// Ensure all clients have required fields (migration)
let clientsMigrated = false;
for (const c of clients) {
  if (!c.payments) { c.payments = []; clientsMigrated = true; }
  if (!c.apiKey) { c.apiKey = 'prx_' + crypto.randomBytes(24).toString('hex'); clientsMigrated = true; }
  if (!c.referral_code) { c.referral_code = 'REF-' + crypto.randomBytes(4).toString('hex').toUpperCase(); clientsMigrated = true; }
  if (c.referral_balance === undefined) { c.referral_balance = 0; clientsMigrated = true; }
  if (!c.resetToken) { c.resetToken = crypto.randomBytes(16).toString('hex'); clientsMigrated = true; }
  if (!c.documents) { c.documents = []; clientsMigrated = true; }
  // Billing persistence: initialize balance from total payments
  if (c.balance === undefined) {
    c.balance = (c.payments || []).reduce((sum, p) => sum + (parseFloat(p.amount) || 0), 0);
    clientsMigrated = true;
  }
  if (!c.last_traffic_snapshot) {
    c.last_traffic_snapshot = { timestamp: null, month_bytes: 0 };
    clientsMigrated = true;
  }
}
if (clientsMigrated) saveClients(clients);

// Auto-migrate .env users (non-admin) to clients.json if not already there
for (const [login, u] of Object.entries(users)) {
  if (u.source === 'env' && u.portNameFilter !== '*') {
    const exists = clients.find(c => c.login === login);
    if (!exists) {
      const client = {
        id: crypto.randomBytes(8).toString('hex'),
        name: u.portNameFilter,
        portName: u.portNameFilter,
        login,
        password: u.password,
        contact: '',
        notes: 'Auto-migrated from .env',
        billingType: 'per_gb',
        price: 23,
        currency: 'RUB',
        payments: [],
        apiKey: 'prx_' + crypto.randomBytes(24).toString('hex'),
        referral_code: 'REF-' + crypto.randomBytes(4).toString('hex').toUpperCase(),
        referred_by: null,
        referral_balance: 0,
        resetToken: crypto.randomBytes(16).toString('hex'),
        documents: [],
        balance: 0,
        last_traffic_snapshot: { timestamp: null, month_bytes: 0 },
        createdAt: new Date().toISOString()
      };
      clients.push(client);
      console.log(`  Auto-migrated user ${login} -> client "${u.portNameFilter}"`);
    }
  }
}
saveClients(clients);

for (const c of clients) {
  if (c.login && c.password && c.portName) {
    users[c.login] = { password: c.password, portNameFilter: c.portName, source: 'client', clientId: c.id };
  }
}
console.log(`Loaded ${Object.keys(users).length} user(s): ${Object.keys(users).join(', ')}`);
console.log(`  - ${clients.length} client(s) from clients.json`);

// ==================== SESSIONS ====================
const SESSION_FILE = path.join(__dirname, 'sessions.json');
const SESSION_TTL = 365 * 24 * 60 * 60 * 1000;

let sessions = {};
try {
  if (fs.existsSync(SESSION_FILE)) {
    const raw = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
    const now = Date.now();
    for (const [token, sess] of Object.entries(raw)) {
      if (sess.expiresAt > now) sessions[token] = sess;
    }
  }
} catch (e) {}

function saveSessions() {
  try { fs.writeFileSync(SESSION_FILE, JSON.stringify(sessions)); } catch (e) {}
}

function generateToken() { return crypto.randomBytes(32).toString('hex'); }
function generateId() { return crypto.randomBytes(8).toString('hex'); }

// ==================== SETTINGS ====================
const SETTINGS_FILE = path.join(__dirname, 'settings.json');

let appSettings = {
  speedtest_times: ['02:00', '14:00'],
  pricing_tiers: [
    { min_proxies: 1, price: 30, label: '1-4 прокси' },
    { min_proxies: 5, price: 25, label: '5-9 прокси' },
    { min_proxies: 10, price: 23, label: '10-19 прокси' },
    { min_proxies: 20, price: 20, label: '20+ прокси' }
  ]
};
try {
  if (fs.existsSync(SETTINGS_FILE)) {
    appSettings = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
  }
} catch (e) { console.error('Failed to load settings:', e.message); }

function saveSettings() {
  try { fs.writeFileSync(SETTINGS_FILE, JSON.stringify(appSettings, null, 2)); }
  catch (e) { console.error('Failed to save settings:', e.message); }
}

// ==================== PRICING TIERS ====================
function getPriceForProxyCount(count) {
  const tiers = appSettings.pricing_tiers || [];
  // Sort descending by min_proxies to find the right tier
  const sorted = tiers.slice().sort((a, b) => b.min_proxies - a.min_proxies);
  for (const tier of sorted) {
    if (count >= tier.min_proxies) return tier.price;
  }
  return tiers.length > 0 ? tiers[0].price : 23; // fallback
}

// ==================== BANDWIDTH PARSING UTILS ====================
function parseBwToBytes(str) {
  if (!str || str === 0) return 0;
  const s = String(str).trim();
  const m = s.match(/([\d.]+)\s*(TB|GB|MB|KB|B)?/i);
  if (!m) return 0;
  const val = parseFloat(m[1]);
  const u = (m[2] || 'B').toUpperCase();
  const mult = { 'TB': 1024**4, 'GB': 1024**3, 'MB': 1024**2, 'KB': 1024, 'B': 1 };
  return val * (mult[u] || 1);
}

function computeClientMonthBytes(allServerResults, portName) {
  let totalBytes = 0;
  for (const data of allServerResults) {
    if (typeof data.bw === 'object') {
      for (const [portId, b] of Object.entries(data.bw)) {
        if (b.portName === portName) {
          totalBytes += parseBwToBytes(b.bandwidth_bytes_month_in);
          totalBytes += parseBwToBytes(b.bandwidth_bytes_month_out);
        }
      }
    }
  }
  return totalBytes;
}

// ==================== DOCUMENTS DIR ====================
const DOCUMENTS_DIR = path.join(__dirname, 'documents');
if (!fs.existsSync(DOCUMENTS_DIR)) fs.mkdirSync(DOCUMENTS_DIR, { recursive: true });

const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ==================== AUTH ====================

function authMiddleware(req, res, next) {
  const token = req.headers['x-auth-token'];
  const sess = token ? sessions[token] : null;
  if (!sess || sess.expiresAt < Date.now()) {
    if (sess) { delete sessions[token]; saveSessions(); }
    return res.status(401).json({ error: 'Unauthorized' });
  }
  req.user = sess;
  next();
}

function adminMiddleware(req, res, next) {
  if (req.user.portNameFilter !== '*') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

app.post('/api/login', (req, res) => {
  const { login, password } = req.body;
  if (!login || !password) return res.status(400).json({ error: 'Login and password required' });
  const user = users[login];
  if (!user || user.password !== password) return res.status(401).json({ error: 'Invalid login or password' });
  const token = generateToken();
  const isAdmin = user.portNameFilter === '*';
  sessions[token] = { login, portNameFilter: user.portNameFilter, isAdmin, expiresAt: Date.now() + SESSION_TTL };
  saveSessions();
  res.json({ token, login, isAdmin });
});

app.post('/api/logout', (req, res) => {
  const token = req.headers['x-auth-token'];
  if (token) { delete sessions[token]; saveSessions(); }
  res.json({ ok: true });
});

// ==================== ProxySmart API helpers ====================

function fetchApi(server, apiPath, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const url = new URL(apiPath, server.url);
    const auth = Buffer.from(`${server.user}:${server.pass}`).toString('base64');
    const req = http.request({
      hostname: url.hostname, port: url.port,
      path: url.pathname + url.search, method: 'GET',
      headers: { 'Authorization': `Basic ${auth}`, 'Accept': 'application/json' },
      timeout
    }, (proxyRes) => {
      let data = '';
      proxyRes.on('data', chunk => data += chunk);
      proxyRes.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { resolve({ raw: data }); }
      });
    });
    req.on('error', (err) => reject(err));
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout from ' + server.name)); });
    req.end();
  });
}

function fetchApiRaw(server, apiPath, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const url = new URL(apiPath, server.url);
    const auth = Buffer.from(`${server.user}:${server.pass}`).toString('base64');
    const req = http.request({
      hostname: url.hostname, port: url.port,
      path: url.pathname + url.search, method: 'GET',
      headers: { 'Authorization': `Basic ${auth}` },
      timeout
    }, (proxyRes) => {
      const chunks = [];
      proxyRes.on('data', chunk => chunks.push(chunk));
      proxyRes.on('end', () => resolve({ buffer: Buffer.concat(chunks), contentType: proxyRes.headers['content-type'] || '' }));
    });
    req.on('error', (err) => reject(err));
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout from ' + server.name)); });
    req.end();
  });
}

function postApi(server, apiPath, body, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const url = new URL(apiPath, server.url);
    const auth = Buffer.from(`${server.user}:${server.pass}`).toString('base64');
    const postData = typeof body === 'string' ? body : JSON.stringify(body);
    const req = http.request({
      hostname: url.hostname, port: url.port,
      path: url.pathname + url.search, method: 'POST',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      },
      timeout
    }, (proxyRes) => {
      let data = '';
      proxyRes.on('data', chunk => data += chunk);
      proxyRes.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { resolve({ raw: data }); }
      });
    });
    req.on('error', (err) => reject(err));
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout from ' + server.name)); });
    req.write(postData);
    req.end();
  });
}

function findServer(serverName) {
  return apiServers.find(s => s.name === serverName);
}

// ==================== DATA FETCHING & MERGING ====================

// ===== SERVER DATA CACHE =====
// Preserves modem data + traffic when a server goes down temporarily
const SERVER_CACHE_FILE = path.join(__dirname, 'server_cache.json');
let serverCache = {};
try {
  if (fs.existsSync(SERVER_CACHE_FILE)) {
    serverCache = JSON.parse(fs.readFileSync(SERVER_CACHE_FILE, 'utf8'));
    console.log(`Loaded server cache: ${Object.keys(serverCache).length} server(s) cached`);
  }
} catch (e) { console.error('Failed to load server_cache:', e.message); }

function saveServerCache() {
  try { fs.writeFileSync(SERVER_CACHE_FILE, JSON.stringify(serverCache)); }
  catch (e) { console.error('Failed to save server_cache:', e.message); }
}

function cacheServerData(data) {
  serverCache[data.serverName] = {
    bw: data.bw,
    status: data.status,
    ports: data.ports,
    serverName: data.serverName,
    cachedAt: Date.now()
  };
  saveServerCache();
}

// When server is down, mark all modems as offline but keep bandwidth + ports
function getCachedDataAsOffline(serverName) {
  const cached = serverCache[serverName];
  if (!cached) return null;

  const ageMinutes = Math.round((Date.now() - cached.cachedAt) / 60000);
  console.log(`[Cache] Using cached data for ${serverName} (${ageMinutes} min old)`);

  // Mark all modems in status as offline + _cached flag
  let offlineStatus = [];
  if (Array.isArray(cached.status)) {
    offlineStatus = cached.status.map(m => {
      const copy = JSON.parse(JSON.stringify(m));
      if (copy.net_details) {
        copy.net_details.IS_ONLINE = 'no';
      }
      copy._cached = true;
      copy._cachedAt = cached.cachedAt;
      return copy;
    });
  }

  return {
    bw: cached.bw || {},
    status: offlineStatus,
    ports: cached.ports || {},
    serverName: serverName,
    _cached: true,
    _cachedAt: cached.cachedAt
  };
}

async function fetchServerData(server) {
  const [bw, status, ports] = await Promise.all([
    fetchApi(server, '/apix/bandwidth_report_all'),
    fetchApi(server, '/apix/show_status_json'),
    fetchApi(server, '/apix/list_ports_json')
  ]);
  const result = { bw, status, ports, serverName: server.name };
  // Cache successful response
  cacheServerData(result);
  return result;
}

// Fetch data from all servers; use cache for unreachable ones
async function fetchAllServersData() {
  const settled = await Promise.allSettled(apiServers.map(s => fetchServerData(s)));
  const results = [];
  for (let i = 0; i < settled.length; i++) {
    if (settled[i].status === 'fulfilled') {
      results.push(settled[i].value);
    } else {
      const srvName = apiServers[i].name;
      console.log(`[API] Server ${srvName} unreachable: ${settled[i].reason?.message || 'unknown'}`);
      // Try to use cached data
      const cached = getCachedDataAsOffline(srvName);
      if (cached) {
        results.push(cached);
      } else {
        console.log(`[API] No cache available for ${srvName}`);
      }
    }
  }
  return results;
}

function filterByPortName(data, portNameFilter) {
  const { bw, status, ports } = data;
  const allowedPortIds = new Set();
  const allowedImeis = new Set();
  let filteredBw = {};
  if (typeof bw === 'object') {
    for (const [portId, b] of Object.entries(bw)) {
      if (b.portName === portNameFilter) { filteredBw[portId] = b; allowedPortIds.add(portId); }
    }
  }
  if (ports && typeof ports === 'object') {
    for (const [imei, portList] of Object.entries(ports)) {
      if (Array.isArray(portList)) {
        for (const p of portList) { if (p.portID && allowedPortIds.has(p.portID)) allowedImeis.add(imei); }
      }
    }
  }
  let filteredStatus = [];
  if (Array.isArray(status)) {
    filteredStatus = status.filter(m => { const imei = m.modem_details?.IMEI; return imei && allowedImeis.has(imei); });
  }
  let filteredPorts = {};
  if (typeof ports === 'object') {
    for (const [imei, portList] of Object.entries(ports)) {
      if (allowedImeis.has(imei) && Array.isArray(portList)) {
        const filtered = portList.filter(p => allowedPortIds.has(p.portID));
        if (filtered.length > 0) filteredPorts[imei] = filtered;
      }
    }
  }
  return { bw: filteredBw, status: filteredStatus, ports: filteredPorts };
}

function mergeServerData(allData, portNameFilter) {
  const mergedBw = {}, mergedStatus = [], mergedPorts = {};
  const cachedServers = [];
  for (const data of allData) {
    const filtered = portNameFilter === '*' ? data : filterByPortName(data, portNameFilter);
    const prefix = data.serverName + '_';
    const isCached = !!data._cached;
    if (isCached) cachedServers.push({ name: data.serverName, cachedAt: data._cachedAt });
    for (const [portId, b] of Object.entries(filtered.bw)) { mergedBw[prefix + portId] = { ...b, _server: data.serverName, _cached: isCached }; }
    const statusArr = Array.isArray(filtered.status) ? filtered.status : [];
    for (const m of statusArr) {
      const entry = { ...m, _server: data.serverName };
      if (isCached) entry._cached = true;
      if (entry.modem_details && entry.modem_details.IMEI) {
        entry.modem_details = { ...entry.modem_details, IMEI: prefix + entry.modem_details.IMEI };
      }
      mergedStatus.push(entry);
    }
    const portsObj = typeof filtered.ports === 'object' ? filtered.ports : {};
    for (const [imei, portList] of Object.entries(portsObj)) {
      const prefixedImei = prefix + imei;
      const prefixedPorts = portList.map(p => ({ ...p, portID: p.portID ? prefix + p.portID : p.portID, _server: data.serverName, _cached: isCached }));
      mergedPorts[prefixedImei] = (mergedPorts[prefixedImei] || []).concat(prefixedPorts);
    }
  }
  return { bandwidth: mergedBw, status: mergedStatus, ports: mergedPorts, modemLogins, cachedServers };
}

// ==================== IP TRACKING & UPTIME TRACKING ====================

const IP_TRACKING_FILE = path.join(__dirname, 'ip_tracking.json');
const UPTIME_TRACKING_FILE = path.join(__dirname, 'uptime_tracking.json');
const IP_HISTORY_FILE = path.join(__dirname, 'ip_history.json');
const MAX_IP_HISTORY = 100;

let ipTracking = {};
try {
  if (fs.existsSync(IP_TRACKING_FILE)) {
    ipTracking = JSON.parse(fs.readFileSync(IP_TRACKING_FILE, 'utf8'));
  }
} catch (e) { console.error('Failed to load ip_tracking:', e.message); }

let uptimeTracking = {};
try {
  if (fs.existsSync(UPTIME_TRACKING_FILE)) {
    uptimeTracking = JSON.parse(fs.readFileSync(UPTIME_TRACKING_FILE, 'utf8'));
  }
} catch (e) { console.error('Failed to load uptime_tracking:', e.message); }

let ipHistory = {};
try {
  if (fs.existsSync(IP_HISTORY_FILE)) {
    ipHistory = JSON.parse(fs.readFileSync(IP_HISTORY_FILE, 'utf8'));
  }
} catch (e) { console.error('Failed to load ip_history:', e.message); }

function saveIpTracking() {
  try { fs.writeFileSync(IP_TRACKING_FILE, JSON.stringify(ipTracking, null, 2)); }
  catch (e) { console.error('Failed to save ip_tracking:', e.message); }
}

function saveUptimeTracking() {
  try { fs.writeFileSync(UPTIME_TRACKING_FILE, JSON.stringify(uptimeTracking, null, 2)); }
  catch (e) { console.error('Failed to save uptime_tracking:', e.message); }
}

function saveIpHistory() {
  try { fs.writeFileSync(IP_HISTORY_FILE, JSON.stringify(ipHistory, null, 2)); }
  catch (e) { console.error('Failed to save ip_history:', e.message); }
}

function recordIpChange(key, oldIp, newIp, timestamp) {
  if (!ipHistory[key]) ipHistory[key] = [];
  const entries = ipHistory[key];
  // Close previous entry
  if (entries.length > 0) {
    const last = entries[entries.length - 1];
    if (!last.to) last.to = timestamp;
  }
  // Add new entry
  entries.push({ ip: newIp, from: timestamp, to: null });
  // Trim to MAX_IP_HISTORY
  if (entries.length > MAX_IP_HISTORY) {
    ipHistory[key] = entries.slice(-MAX_IP_HISTORY);
  }
}

// Combined tracking: IP changes + uptime percentage (runs every 10 min)
// Uptime fix: skip rotating/rebooting modems, skip unreachable servers
async function trackModems() {
  const now = Date.now();
  let totalTracked = 0;

  for (const server of apiServers) {
    let statusArr;
    try {
      const data = await fetchServerData(server);
      statusArr = Array.isArray(data.status) ? data.status : [];
    } catch (e) {
      // Server unreachable -- skip all modems on this server (don't count as offline)
      console.log(`[Tracking] Server ${server.name} unreachable, skipping: ${e.message}`);
      continue;
    }

    const prefix = server.name + '_';

    for (const m of statusArr) {
      const imei = m.modem_details?.IMEI;
      if (!imei) continue;
      const key = prefix + imei;
      const extIp = m.net_details?.EXT_IP || '';
      const isOnline = m.net_details?.IS_ONLINE === 'yes';
      const isRotating = m.IS_ROTATED === 'true' || m.IS_ROTATED === true;
      const isRebooting = m.IS_REBOOTING === 'true' || m.IS_REBOOTING === true;

      // IP tracking (always, regardless of status)
      if (extIp && extIp !== 'IP_RESET') {
        if (!ipTracking[key]) {
          ipTracking[key] = { ip: extIp, since: now };
          // Record initial IP in history
          recordIpChange(key, null, extIp, now);
        } else if (ipTracking[key].ip !== extIp) {
          // IP changed! Record in history with timestamp
          recordIpChange(key, ipTracking[key].ip, extIp, now);
          ipTracking[key] = { ip: extIp, since: now };
        }
        // else same IP -- keep existing `since`
      }

      // Uptime tracking -- skip if rotating, rebooting, or IP is resetting
      if (isRotating || isRebooting || extIp === 'IP_RESET' || extIp === '') {
        continue;
      }

      if (!uptimeTracking[key]) {
        uptimeTracking[key] = { total_checks: 0, online_checks: 0, first_check: now, consecutive_failures: 0 };
      }
      if (!uptimeTracking[key].consecutive_failures) uptimeTracking[key].consecutive_failures = 0;

      if (isOnline) {
        // Online: reset consecutive failures, count as online
        uptimeTracking[key].consecutive_failures = 0;
        uptimeTracking[key].total_checks++;
        uptimeTracking[key].online_checks++;
      } else {
        // Offline: increment consecutive failures
        uptimeTracking[key].consecutive_failures++;
        // Only count as downtime after 3 consecutive failures
        if (uptimeTracking[key].consecutive_failures >= 3) {
          uptimeTracking[key].total_checks++;
          // don't increment online_checks = counts as downtime
        } else {
          // Less than 3 failures: still count as online (100%)
          uptimeTracking[key].total_checks++;
          uptimeTracking[key].online_checks++;
        }
      }
      totalTracked++;
    }
  }

  saveIpTracking();
  saveUptimeTracking();
  saveIpHistory();
  console.log(`[Tracking] Updated IP & uptime for ${Object.keys(ipTracking).length} modems (${totalTracked} uptime checks)`);
}

// ==================== SPEEDTEST HISTORY ====================

const SPEEDTEST_HISTORY_FILE = path.join(__dirname, 'speedtest_history.json');
const MAX_SPEEDTEST_ENTRIES = 30;

let speedtestHistory = {};
try {
  if (fs.existsSync(SPEEDTEST_HISTORY_FILE)) {
    speedtestHistory = JSON.parse(fs.readFileSync(SPEEDTEST_HISTORY_FILE, 'utf8'));
  }
} catch (e) { console.error('Failed to load speedtest_history:', e.message); }

function saveSpeedtestHistory() {
  try { fs.writeFileSync(SPEEDTEST_HISTORY_FILE, JSON.stringify(speedtestHistory, null, 2)); }
  catch (e) { console.error('Failed to save speedtest_history:', e.message); }
}

let speedtestRunning = false;

async function runNightlySpeedtests() {
  if (speedtestRunning) {
    console.log('[Speedtest] Already running, skipping...');
    return;
  }
  speedtestRunning = true;
  console.log('[Speedtest] Starting speedtest run...');
  let testedCount = 0, errorCount = 0;

  try {
    for (const server of apiServers) {
      try {
        const statusData = await fetchApi(server, '/apix/show_status_json');
        const modems = Array.isArray(statusData) ? statusData : [];
        console.log(`[Speedtest] ${server.name}: ${modems.length} modems to test`);

        for (const m of modems) {
          const nick = m.modem_details?.NICK;
          const imei = m.modem_details?.IMEI;
          const isOnline = m.net_details?.IS_ONLINE === 'yes';
          if (!nick || !imei || !isOnline) continue;

          const key = server.name + '_' + imei;
          try {
            console.log(`[Speedtest] Testing ${nick} (${server.name})...`);
            const result = await fetchApi(server, `/apix/speedtest?arg=${encodeURIComponent(nick)}`, 180000);

            let dl = 0, ul = 0, ping = 0;
            if (result && typeof result === 'object') {
              dl = parseFloat(result.download || result.Download || result.dl || 0);
              ul = parseFloat(result.upload || result.Upload || result.ul || 0);
              ping = parseFloat(result.ping || result.Ping || result.latency || 0);
              if (result.raw && typeof result.raw === 'string') {
                const dlMatch = result.raw.match(/download[:\s]*([\d.]+)/i);
                const ulMatch = result.raw.match(/upload[:\s]*([\d.]+)/i);
                const pingMatch = result.raw.match(/ping[:\s]*([\d.]+)/i);
                if (dlMatch) dl = parseFloat(dlMatch[1]);
                if (ulMatch) ul = parseFloat(ulMatch[1]);
                if (pingMatch) ping = parseFloat(pingMatch[1]);
              }
            }

            const entry = {
              date: new Date().toISOString(),
              download: dl,
              upload: ul,
              ping: ping,
              raw: result
            };

            // Re-test if DL or UL is below 1 Mbps
            if ((dl < 1 || ul < 1)) {
              console.log(`[Speedtest] ${nick}: DL=${dl} UL=${ul} — near-zero detected, re-testing in 10 min...`);
              setTimeout(async () => {
                try {
                  console.log(`[Speedtest] Re-testing ${nick} (${server.name})...`);
                  const retryResult = await fetchApi(server, `/apix/speedtest?arg=${encodeURIComponent(nick)}`, 180000);
                  let rdl = 0, rul = 0, rping = 0;
                  if (retryResult && typeof retryResult === 'object') {
                    rdl = parseFloat(retryResult.download || retryResult.Download || retryResult.dl || 0);
                    rul = parseFloat(retryResult.upload || retryResult.Upload || retryResult.ul || 0);
                    rping = parseFloat(retryResult.ping || retryResult.Ping || retryResult.latency || 0);
                    if (retryResult.raw && typeof retryResult.raw === 'string') {
                      const rdlM = retryResult.raw.match(/download[:\s]*([\d.]+)/i);
                      const rulM = retryResult.raw.match(/upload[:\s]*([\d.]+)/i);
                      const rpM = retryResult.raw.match(/ping[:\s]*([\d.]+)/i);
                      if (rdlM) rdl = parseFloat(rdlM[1]);
                      if (rulM) rul = parseFloat(rulM[1]);
                      if (rpM) rping = parseFloat(rpM[1]);
                    }
                  }
                  // Use retry result if better
                  if (rdl + rul > dl + ul) {
                    const retryEntry = { date: new Date().toISOString(), download: rdl, upload: rul, ping: rping, raw: retryResult, retry: true, ...(rdl < 1 || rul < 1 ? { _lowSpeed: true } : {}) };
                    if (!speedtestHistory[key]) speedtestHistory[key] = [];
                    speedtestHistory[key].push(retryEntry);
                    if (speedtestHistory[key].length > MAX_SPEEDTEST_ENTRIES) speedtestHistory[key] = speedtestHistory[key].slice(-MAX_SPEEDTEST_ENTRIES);
                    saveSpeedtestHistory();
                    console.log(`[Speedtest] Re-test ${nick}: DL=${rdl} UL=${rul} (improved)`);
                  } else {
                    console.log(`[Speedtest] Re-test ${nick}: DL=${rdl} UL=${rul} (not improved)`);
                  }
                } catch (e) { console.error(`[Speedtest] Re-test ${nick} error:`, e.message); }
              }, 10 * 60 * 1000);
            }

            if (!speedtestHistory[key]) speedtestHistory[key] = [];
            speedtestHistory[key].push(entry);
            if (speedtestHistory[key].length > MAX_SPEEDTEST_ENTRIES) {
              speedtestHistory[key] = speedtestHistory[key].slice(-MAX_SPEEDTEST_ENTRIES);
            }
            saveSpeedtestHistory();
            testedCount++;
            console.log(`[Speedtest] ${nick}: DL=${dl} UL=${ul} Ping=${ping}`);
          } catch (e) {
            console.error(`[Speedtest] Error testing ${nick}:`, e.message);
            errorCount++;
          }

          await new Promise(r => setTimeout(r, 2000));
        }
      } catch (e) {
        console.error(`[Speedtest] Error on server ${server.name}:`, e.message);
        errorCount++;
      }
    }
  } finally {
    speedtestRunning = false;
  }

  console.log(`[Speedtest] Complete: ${testedCount} tested, ${errorCount} errors`);
}

function getSpeedtestLatest() {
  const latest = {};
  for (const [key, entries] of Object.entries(speedtestHistory)) {
    if (entries.length > 0) {
      const last = entries[entries.length - 1];
      latest[key] = { download: last.download, upload: last.upload, ping: last.ping, date: last.date, ...(last._lowSpeed ? { _lowSpeed: true } : {}) };
    }
  }
  return latest;
}

// ==================== CLIENT DASHBOARD API ====================

app.get('/api/dashboard_data', authMiddleware, async (req, res) => {
  try {
    const results = await fetchAllServersData();
    const merged = mergeServerData(results, req.user.portNameFilter);
    const clientInfo = clients.find(c => c.login === req.user.login);
    if (clientInfo) {
      const totalPayments = (clientInfo.payments || []).reduce((sum, p) => sum + (parseFloat(p.amount) || 0), 0);
      // Current month expense from billing ledger
      const ledgerEntries = billingLedger[clientInfo.id] || [];
      const currentMonthPrefix = new Date().toISOString().slice(0, 7);
      const monthExpense = ledgerEntries
        .filter(e => e.type === 'charge' && e.date && e.date.startsWith(currentMonthPrefix))
        .reduce((sum, e) => sum + (e.cost || 0), 0);

      merged.billing = {
        billingType: clientInfo.billingType || 'per_gb',
        price: clientInfo.price || 0,
        currency: clientInfo.currency || 'RUB',
        totalPayments,
        balance: clientInfo.balance !== undefined ? clientInfo.balance : totalPayments,
        monthExpense: Math.round(monthExpense * 100) / 100,
        apiKey: clientInfo.apiKey || ''
      };
    }

    // Include tracking data filtered for this user's modems
    if (req.user.portNameFilter !== '*') {
      const filteredIpTracking = {};
      const filteredUptimeTracking = {};
      const filteredSpeedtest = {};
      const filteredIpHistory = {};
      const speedLatest = getSpeedtestLatest();

      const clientImeis = new Set();
      for (const imei of Object.keys(merged.ports)) {
        clientImeis.add(imei);
      }

      for (const imei of clientImeis) {
        if (ipTracking[imei]) filteredIpTracking[imei] = ipTracking[imei];
        if (uptimeTracking[imei]) filteredUptimeTracking[imei] = uptimeTracking[imei];
        if (speedLatest[imei]) filteredSpeedtest[imei] = speedLatest[imei];
        if (ipHistory[imei]) filteredIpHistory[imei] = ipHistory[imei];
      }

      merged.ipTracking = filteredIpTracking;
      merged.uptimeTracking = filteredUptimeTracking;
      merged.speedtestLatest = filteredSpeedtest;
      merged.ipHistory = filteredIpHistory;
    }

    res.json(merged);
  } catch (err) {
    res.status(502).json({ error: 'API request failed', details: err.message });
  }
});

// ==================== CLIENT: IP RESET (non-admin) ====================

app.post('/api/client/reset_ip', authMiddleware, async (req, res) => {
  try {
    const { imei, serverName } = req.body;
    if (!imei || !serverName) return res.status(400).json({ error: 'imei and serverName required' });
    const server = findServer(serverName);
    if (!server) return res.status(400).json({ error: 'Server not found' });
    const result = await fetchApi(server, `/apix/reset_modem_by_imei?IMEI=${encodeURIComponent(imei)}`);
    const success = result && result.result === 'success';
    if (success) {
      res.json({ ok: true, result });
    } else {
      res.json({ ok: false, error: result?.message || 'Reset failed', result });
    }
  } catch (err) { res.status(502).json({ ok: false, error: 'Reset failed', details: err.message }); }
});

// ==================== CLIENT: TOKEN-BASED IP RESET (public, no session) ====================

app.get('/api/client/reset_ip_by_token', async (req, res) => {
  const { nick, token } = req.query;
  if (!nick || !token) return res.status(400).json({ error: 'nick and token required' });
  const client = clients.find(c => c.resetToken === token);
  if (!client) return res.status(401).json({ error: 'Invalid token' });
  // Try all servers
  for (const server of apiServers) {
    try {
      const result = await fetchApi(server, `/apix/reset_modem?arg=${encodeURIComponent(nick)}`);
      if (result) return res.json({ ok: true, result });
    } catch (e) { /* try next server */ }
  }
  res.status(404).json({ error: 'Modem not found' });
});

// ==================== CLIENT: ROTATION LOG ====================

app.get('/api/client/rotation_log', authMiddleware, async (req, res) => {
  try {
    const { nick, serverName } = req.query;
    if (!nick || !serverName) return res.status(400).json({ error: 'nick and serverName required' });
    const server = findServer(serverName);
    if (!server) return res.status(400).json({ error: 'Server not found' });
    const result = await fetchApi(server, `/apix/get_rotation_log?arg=${encodeURIComponent(nick)}`);
    res.json(result);
  } catch (err) { res.status(502).json({ error: 'Failed', details: err.message }); }
});

// ==================== CLIENT: IP HISTORY ====================

app.get('/api/client/ip_history', authMiddleware, (req, res) => {
  const { key } = req.query;
  if (!key) return res.status(400).json({ error: 'key required' });
  res.json(ipHistory[key] || []);
});

// ==================== CLIENT: CREDENTIALS EXPORT ====================

app.get('/api/client/credentials_export', authMiddleware, async (req, res) => {
  try {
    const results = await fetchAllServersData();
    const merged = mergeServerData(results, req.user.portNameFilter);

    const COUNTRIES = { S1: { serverIp: '89.149.100.92' }, S2: { serverIp: '31.5.194.89' } };
    // Build server URL map for direct reset URLs
    const credentials = [];

    for (const [imei, portList] of Object.entries(merged.ports)) {
      const serverName = imei.startsWith('S1_') ? 'S1' : imei.startsWith('S2_') ? 'S2' : '';
      const ci = COUNTRIES[serverName] || {};
      let modemNick = imei;
      for (const m of merged.status) {
        if (m.modem_details?.IMEI === imei) {
          modemNick = m.modem_details.NICK || imei;
          break;
        }
      }
      for (const p of portList) {
        if (p.LOGIN && p.PASSWORD) {
          credentials.push({
            modem: modemNick,
            server: serverName,
            serverIp: ci.serverIp || '',
            httpPort: p.HTTP_PORT || '',
            socksPort: p.SOCKS_PORT || '',
            login: p.LOGIN,
            password: p.PASSWORD,
            httpProxy: ci.serverIp ? `${ci.serverIp}:${p.HTTP_PORT}` : '',
            socks5Proxy: ci.serverIp ? `${ci.serverIp}:${p.SOCKS_PORT}` : '',
            httpCreds: p.http_creds || '',
            socks5Creds: p.socks5_creds || '',
            resetUrl: p.RESET_SECURE_LINK?.URL || ''
          });
        }
      }
    }

    // Also include server info so frontend can build direct URLs
    const serverInfo = {};
    for (const s of apiServers) {
      const urlObj = new URL(s.url);
      serverInfo[s.name] = { url: s.url, user: s.user, pass: s.pass, host: urlObj.host };
    }

    const clientInfo = clients.find(c => c.login === req.user.login);
    res.json({
      credentials,
      clientName: req.user.login,
      exportDate: new Date().toISOString(),
      resetToken: clientInfo ? clientInfo.resetToken : '',
      serverInfo
    });
  } catch (err) { res.status(502).json({ error: 'Export failed', details: err.message }); }
});

// ==================== CLIENT: REFERRAL PROGRAM ====================

app.get('/api/client/referral', authMiddleware, (req, res) => {
  const client = clients.find(c => c.login === req.user.login);
  if (!client) return res.status(404).json({ error: 'Client not found' });
  const referrals = clients.filter(c => c.referred_by === client.id);
  res.json({
    referrals_count: referrals.length,
    referral_balance: client.referral_balance || 0,
    referrals: referrals.map(r => ({ name: r.name, createdAt: r.createdAt }))
  });
});

// ==================== CLIENT: DOCUMENTS ====================

app.get('/api/client/documents', authMiddleware, (req, res) => {
  const client = clients.find(c => c.login === req.user.login);
  if (!client) return res.json([]);
  res.json((client.documents || []).map(d => ({ id: d.id, name: d.name, date: d.date })));
});

app.get('/api/client/documents/:docId/download', authMiddleware, (req, res) => {
  const client = clients.find(c => c.login === req.user.login);
  if (!client) return res.status(404).json({ error: 'Not found' });
  const doc = (client.documents || []).find(d => d.id === req.params.docId);
  if (!doc) return res.status(404).json({ error: 'Document not found' });
  const filePath = path.join(DOCUMENTS_DIR, doc.fileName);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });
  res.download(filePath, doc.name);
});

// ==================== CORS for Public API (Bug #6) ====================
app.use('/api/v1', (req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'X-API-Key, Content-Type');
  res.header('Access-Control-Max-Age', '86400');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }
  next();
});

// ==================== PUBLIC: PROXY API v2 (Evomi-style, apiKey via header or query) ====================

app.get('/api/v1/proxy', async (req, res) => {
  const apiKey = req.headers['x-api-key'] || req.query.apikey;
  if (!apiKey) return res.status(401).json({ success: false, error: 'API key required. Pass via X-API-Key header or ?apikey= query parameter.' });

  const client = clients.find(c => c.apiKey === apiKey);
  if (!client) return res.status(401).json({ success: false, error: 'Invalid API key' });

  try {
    const results = await fetchAllServersData();
    const merged = mergeServerData(results, client.portName);

    const COUNTRIES = { S1: { serverIp: '89.149.100.92', country: 'MD', name: 'Moldova' }, S2: { serverIp: '31.5.194.89', country: 'RO', name: 'Romania' } };

    const proxies = [];
    for (const [imei, portList] of Object.entries(merged.ports)) {
      const serverName = imei.startsWith('S1_') ? 'S1' : imei.startsWith('S2_') ? 'S2' : '';
      const ci = COUNTRIES[serverName] || {};
      let modemNick = imei;
      let operator = '', isOnline = false;
      for (const m of merged.status) {
        if (m.modem_details?.IMEI === imei) {
          modemNick = m.modem_details.NICK || imei;
          operator = m.net_details?.CELLOP || '';
          isOnline = m.net_details?.IS_ONLINE === 'yes';
          break;
        }
      }
      for (const p of portList) {
        if (p.LOGIN && p.PASSWORD && ci.serverIp) {
          // Use RESET_SECURE_LINK from port data (direct modem server URL)
          const changeIpUrl = p.RESET_SECURE_LINK?.URL || '';
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
    const clientInfo = clients.find(c => c.login === client.login);
    const totalPayments = clientInfo ? (clientInfo.payments || []).reduce((s, p) => s + (parseFloat(p.amount) || 0), 0) : 0;

    // Bandwidth totals (in MB)
    let monthMb = 0;
    const parseToMb = (str) => {
      if (!str || str === 0) return 0;
      const s = String(str);
      const m = s.match(/([\d.]+)\s*(TB|GB|MB|KB|B)?/i);
      if (!m) return 0;
      const val = parseFloat(m[1]);
      const u = (m[2] || '').toUpperCase();
      if (u === 'TB') return val * 1024 * 1024;
      if (u === 'GB') return val * 1024;
      if (u === 'MB') return val;
      if (u === 'KB') return val / 1024;
      return 0; // no unit = likely 0
    };
    for (const b of Object.values(merged.bandwidth)) {
      monthMb += parseToMb(b.bandwidth_bytes_month_in);
      monthMb += parseToMb(b.bandwidth_bytes_month_out);
    }

    res.json({
      success: true,
      client: client.name,
      billing: {
        type: clientInfo?.billingType || 'per_gb',
        price_per_gb: clientInfo?.price || 0,
        currency: clientInfo?.currency || 'RUB',
        balance: clientInfo?.balance !== undefined ? clientInfo.balance : totalPayments,
        usage_mb: Math.round(monthMb)
      },
      proxies,
      proxy_count: proxies.length
    });
  } catch (err) {
    res.status(502).json({ success: false, error: 'Failed to fetch proxy data' });
  }
});

// ==================== PUBLIC: PROXY API v1 (legacy, kept for backward compat) ====================

app.get('/api/v1/proxies', async (req, res) => {
  const { apiKey, format } = req.query;
  if (!apiKey) return res.status(400).json({ error: 'apiKey required' });

  const client = clients.find(c => c.apiKey === apiKey);
  if (!client) return res.status(401).json({ error: 'Invalid API key' });

  try {
    const results = await fetchAllServersData();
    const merged = mergeServerData(results, client.portName);

    const COUNTRIES = { S1: { serverIp: '89.149.100.92' }, S2: { serverIp: '31.5.194.89' } };
    const proxies = [];

    for (const [imei, portList] of Object.entries(merged.ports)) {
      const serverName = imei.startsWith('S1_') ? 'S1' : imei.startsWith('S2_') ? 'S2' : '';
      const ci = COUNTRIES[serverName] || {};
      let modemNick = imei;
      for (const m of merged.status) {
        if (m.modem_details?.IMEI === imei) { modemNick = m.modem_details.NICK || imei; break; }
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
            resetUrl: p.RESET_SECURE_LINK?.URL || ''
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
  } catch (err) {
    res.status(502).json({ error: 'Failed to fetch proxy data' });
  }
});

// ==================== ADMIN: FULL DATA ====================

app.get('/api/admin/data', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const results = await fetchAllServersData();
    const merged = mergeServerData(results, '*');
    const servers = apiServers.map(s => ({ name: s.name, url: s.url }));
    // Include server auth info for direct reset URLs
    const serverAuth = {};
    for (const s of apiServers) {
      const urlObj = new URL(s.url);
      serverAuth[s.name] = { user: s.user, pass: s.pass, host: urlObj.host, protocol: urlObj.protocol };
    }
    res.json({
      ...merged,
      servers,
      serverAuth,
      clients,
      ipTracking,
      uptimeTracking,
      speedtestLatest: getSpeedtestLatest(),
      ipHistory,
      settings: appSettings
    });
  } catch (err) {
    res.status(502).json({ error: 'API request failed', details: err.message });
  }
});

// ==================== ADMIN: CLIENT MANAGEMENT ====================

app.get('/api/admin/clients', authMiddleware, adminMiddleware, (req, res) => {
  res.json(clients);
});

app.post('/api/admin/clients', authMiddleware, adminMiddleware, (req, res) => {
  const { name, portName, login, password, contact, notes, billingType, price, currency, referred_by } = req.body;
  if (!name || !portName || !login || !password) {
    return res.status(400).json({ error: 'name, portName, login, password required' });
  }
  if (users[login]) {
    return res.status(400).json({ error: 'Login already exists: ' + login });
  }
  const client = {
    id: generateId(),
    name, portName, login, password,
    contact: contact || '',
    notes: notes || '',
    billingType: billingType || 'per_gb',
    price: parseFloat(price) || 0,
    currency: currency || 'RUB',
    payments: [],
    apiKey: 'prx_' + crypto.randomBytes(24).toString('hex'),
    referral_code: 'REF-' + crypto.randomBytes(4).toString('hex').toUpperCase(),
    referred_by: null,
    referral_balance: 0,
    resetToken: crypto.randomBytes(16).toString('hex'),
    documents: [],
    balance: 0,
    last_traffic_snapshot: { timestamp: null, month_bytes: 0 },
    createdAt: new Date().toISOString()
  };

  // Handle referral: if referred_by code is provided
  if (referred_by) {
    const referrer = clients.find(c => c.referral_code === referred_by);
    if (referrer) {
      client.referred_by = referrer.id;
    }
  }

  clients.push(client);
  saveClients(clients);
  users[login] = { password, portNameFilter: portName, source: 'client', clientId: client.id };
  res.json({ ok: true, client });
});

app.put('/api/admin/clients/:id', authMiddleware, adminMiddleware, (req, res) => {
  const idx = clients.findIndex(c => c.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Client not found' });
  const old = clients[idx];
  const { name, portName, login, password, contact, notes, billingType, price, currency } = req.body;
  if (login && login !== old.login) {
    if (users[login]) return res.status(400).json({ error: 'Login already exists: ' + login });
    delete users[old.login];
  }
  const updated = {
    ...old,
    name: name || old.name,
    portName: portName || old.portName,
    login: login || old.login,
    password: password || old.password,
    contact: contact !== undefined ? contact : old.contact,
    notes: notes !== undefined ? notes : old.notes,
    billingType: billingType !== undefined ? billingType : (old.billingType || 'per_gb'),
    price: price !== undefined ? parseFloat(price) : (old.price || 0),
    currency: currency !== undefined ? currency : (old.currency || 'RUB')
  };
  clients[idx] = updated;
  saveClients(clients);
  users[updated.login] = { password: updated.password, portNameFilter: updated.portName, source: 'client', clientId: updated.id };
  res.json({ ok: true, client: updated });
});

// DELETE client -- with port protection
app.delete('/api/admin/clients/:id', authMiddleware, adminMiddleware, async (req, res) => {
  const idx = clients.findIndex(c => c.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Client not found' });

  const client = clients[idx];

  try {
    const results = await fetchAllServersData();
    let hasActivePorts = false;
    for (const data of results) {
      if (typeof data.bw === 'object') {
        for (const [portId, b] of Object.entries(data.bw)) {
          if (b.portName === client.portName) { hasActivePorts = true; break; }
        }
      }
      if (hasActivePorts) break;
    }

    if (hasActivePorts) {
      return res.status(400).json({
        error: `Нельзя удалить: у клиента есть активные порты (portName: ${client.portName}). Сначала закройте все порты.`
      });
    }
  } catch (e) {
    console.warn('[DeleteClient] Could not verify ports, proceeding with deletion:', e.message);
  }

  const removed = clients.splice(idx, 1)[0];
  saveClients(clients);
  delete users[removed.login];
  for (const [token, sess] of Object.entries(sessions)) {
    if (sess.login === removed.login) delete sessions[token];
  }
  saveSessions();
  res.json({ ok: true });
});

// ==================== ADMIN: PAYMENTS ====================

app.post('/api/admin/clients/:id/payment', authMiddleware, adminMiddleware, (req, res) => {
  const idx = clients.findIndex(c => c.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Client not found' });
  const { amount, date, note } = req.body;
  if (!amount || !date) return res.status(400).json({ error: 'amount and date required' });
  if (!clients[idx].payments) clients[idx].payments = [];
  clients[idx].payments.push({
    amount: parseFloat(amount),
    date,
    note: note || '',
    createdAt: new Date().toISOString()
  });

  // Update persistent balance
  const paymentAmount = parseFloat(amount);
  const balanceBefore = clients[idx].balance || 0;
  clients[idx].balance = Math.round((balanceBefore + paymentAmount) * 100) / 100;

  // Ledger entry for payment
  const ledgerKey = clients[idx].id;
  if (!billingLedger[ledgerKey]) billingLedger[ledgerKey] = [];
  billingLedger[ledgerKey].push({
    type: 'payment',
    date: date,
    timestamp: new Date().toISOString(),
    amount: paymentAmount,
    currency: clients[idx].currency || 'RUB',
    balance_before: balanceBefore,
    balance_after: clients[idx].balance,
    note: note || 'Admin payment'
  });

  // Referral: credit 15% to referrer
  if (clients[idx].referred_by) {
    const referrer = clients.find(c => c.id === clients[idx].referred_by);
    if (referrer) {
      const commission = paymentAmount * 0.15;
      referrer.referral_balance = (referrer.referral_balance || 0) + commission;
      console.log(`[Referral] Credited ${commission.toFixed(2)} to ${referrer.name} (15% of ${amount})`);
    }
  }

  saveClients(clients);
  saveBillingLedger();
  res.json({ ok: true, payments: clients[idx].payments, balance: clients[idx].balance });
});

app.get('/api/admin/clients/:id/payments', authMiddleware, adminMiddleware, (req, res) => {
  const client = clients.find(c => c.id === req.params.id);
  if (!client) return res.status(404).json({ error: 'Client not found' });
  res.json(client.payments || []);
});

app.delete('/api/admin/clients/:id/payment/:index', authMiddleware, adminMiddleware, (req, res) => {
  const idx = clients.findIndex(c => c.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Client not found' });
  const payIdx = parseInt(req.params.index);
  if (!clients[idx].payments || payIdx < 0 || payIdx >= clients[idx].payments.length) {
    return res.status(400).json({ error: 'Invalid payment index' });
  }
  const deletedPayment = clients[idx].payments[payIdx];
  const deletedAmount = parseFloat(deletedPayment.amount) || 0;
  clients[idx].payments.splice(payIdx, 1);

  // Update persistent balance
  const balanceBefore = clients[idx].balance || 0;
  clients[idx].balance = Math.round((balanceBefore - deletedAmount) * 100) / 100;

  // Ledger entry for reversal
  const ledgerKey = clients[idx].id;
  if (!billingLedger[ledgerKey]) billingLedger[ledgerKey] = [];
  billingLedger[ledgerKey].push({
    type: 'payment_reversal',
    date: new Date().toISOString().slice(0, 10),
    timestamp: new Date().toISOString(),
    amount: -deletedAmount,
    currency: clients[idx].currency || 'RUB',
    balance_before: balanceBefore,
    balance_after: clients[idx].balance,
    note: 'Payment deleted by admin'
  });

  saveClients(clients);
  saveBillingLedger();
  res.json({ ok: true, payments: clients[idx].payments, balance: clients[idx].balance });
});

// ==================== ADMIN: BILLING LEDGER ====================

app.get('/api/admin/clients/:id/ledger', authMiddleware, adminMiddleware, (req, res) => {
  const client = clients.find(c => c.id === req.params.id);
  if (!client) return res.status(404).json({ error: 'Client not found' });
  const entries = billingLedger[client.id] || [];
  res.json({
    balance: client.balance,
    last_snapshot: client.last_traffic_snapshot,
    entries: entries.slice(-100) // last 100 entries
  });
});

app.post('/api/admin/clients/:id/balance_adjust', authMiddleware, adminMiddleware, (req, res) => {
  const idx = clients.findIndex(c => c.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Client not found' });
  const { amount, note } = req.body;
  if (amount === undefined) return res.status(400).json({ error: 'amount required' });

  const adjustment = parseFloat(amount);
  const balanceBefore = clients[idx].balance || 0;
  clients[idx].balance = Math.round((balanceBefore + adjustment) * 100) / 100;

  const ledgerKey = clients[idx].id;
  if (!billingLedger[ledgerKey]) billingLedger[ledgerKey] = [];
  billingLedger[ledgerKey].push({
    type: 'adjustment',
    date: new Date().toISOString().slice(0, 10),
    timestamp: new Date().toISOString(),
    amount: adjustment,
    currency: clients[idx].currency || 'RUB',
    balance_before: balanceBefore,
    balance_after: clients[idx].balance,
    note: note || 'Manual balance adjustment'
  });

  saveClients(clients);
  saveBillingLedger();
  res.json({ ok: true, balance: clients[idx].balance });
});

// ==================== ADMIN: DOCUMENTS ====================

app.post('/api/admin/clients/:id/document', authMiddleware, adminMiddleware, (req, res) => {
  const idx = clients.findIndex(c => c.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Client not found' });
  const { name, fileBase64, mimeType } = req.body;
  if (!name || !fileBase64) return res.status(400).json({ error: 'name and fileBase64 required' });

  const docId = generateId();
  const ext = name.split('.').pop() || 'pdf';
  const fileName = `${docId}.${ext}`;
  const filePath = path.join(DOCUMENTS_DIR, fileName);

  fs.writeFileSync(filePath, Buffer.from(fileBase64, 'base64'));

  if (!clients[idx].documents) clients[idx].documents = [];
  clients[idx].documents.push({
    id: docId,
    name,
    fileName,
    mimeType: mimeType || 'application/pdf',
    date: new Date().toISOString()
  });
  saveClients(clients);
  res.json({ ok: true });
});

app.delete('/api/admin/clients/:id/document/:docId', authMiddleware, adminMiddleware, (req, res) => {
  const idx = clients.findIndex(c => c.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Client not found' });
  if (!clients[idx].documents) return res.status(404).json({ error: 'No documents' });
  const docIdx = clients[idx].documents.findIndex(d => d.id === req.params.docId);
  if (docIdx === -1) return res.status(404).json({ error: 'Document not found' });
  const doc = clients[idx].documents[docIdx];
  // Delete file
  try { fs.unlinkSync(path.join(DOCUMENTS_DIR, doc.fileName)); } catch (e) {}
  clients[idx].documents.splice(docIdx, 1);
  saveClients(clients);
  res.json({ ok: true });
});

// ==================== ADMIN: API KEY MANAGEMENT ====================

app.post('/api/admin/clients/:id/regenerate_key', authMiddleware, adminMiddleware, (req, res) => {
  const idx = clients.findIndex(c => c.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Client not found' });
  clients[idx].apiKey = 'prx_' + crypto.randomBytes(24).toString('hex');
  saveClients(clients);
  res.json({ ok: true, apiKey: clients[idx].apiKey });
});

// ==================== ADMIN: SETTINGS ====================

app.get('/api/admin/settings', authMiddleware, adminMiddleware, (req, res) => {
  res.json(appSettings);
});

app.put('/api/admin/settings', authMiddleware, adminMiddleware, (req, res) => {
  const { speedtest_times, pricing_tiers } = req.body;
  if (speedtest_times && Array.isArray(speedtest_times)) {
    appSettings.speedtest_times = speedtest_times.filter(t => /^\d{2}:\d{2}$/.test(t));
  }
  if (pricing_tiers && Array.isArray(pricing_tiers)) {
    appSettings.pricing_tiers = pricing_tiers.map(t => ({
      min_proxies: parseInt(t.min_proxies) || 1,
      price: parseFloat(t.price) || 0,
      label: t.label || ''
    }));
  }
  saveSettings();
  rescheduleSpeedtests();
  res.json({ ok: true, settings: appSettings });
});

// ==================== ADMIN: MODEM ACTIONS ====================

app.post('/api/admin/reset_ip', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { imei, serverName } = req.body;
    if (!imei || !serverName) return res.status(400).json({ error: 'imei and serverName required' });
    const server = findServer(serverName);
    if (!server) return res.status(400).json({ error: 'Server not found' });
    const result = await fetchApi(server, `/apix/reset_modem_by_imei?IMEI=${encodeURIComponent(imei)}`);
    res.json({ ok: true, result });
  } catch (err) { res.status(502).json({ error: 'Reset failed', details: err.message }); }
});

app.post('/api/admin/reboot', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { imei, serverName } = req.body;
    if (!imei || !serverName) return res.status(400).json({ error: 'imei and serverName required' });
    const server = findServer(serverName);
    if (!server) return res.status(400).json({ error: 'Server not found' });
    const result = await fetchApi(server, `/apix/reboot_modem_by_imei?IMEI=${encodeURIComponent(imei)}`);
    res.json({ ok: true, result });
  } catch (err) { res.status(502).json({ error: 'Reboot failed', details: err.message }); }
});

app.post('/api/admin/usb_reset', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { nick, serverName } = req.body;
    if (!nick || !serverName) return res.status(400).json({ error: 'nick and serverName required' });
    const server = findServer(serverName);
    if (!server) return res.status(400).json({ error: 'Server not found' });
    const result = await fetchApi(server, `/apix/usb_reset_modem_json?arg=${encodeURIComponent(nick)}`);
    res.json({ ok: true, result });
  } catch (err) { res.status(502).json({ error: 'USB reset failed', details: err.message }); }
});

app.post('/api/admin/store_modem', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { serverName, ...modemData } = req.body;
    if (!serverName || !modemData.IMEI) return res.status(400).json({ error: 'serverName and IMEI required' });
    const server = findServer(serverName);
    if (!server) return res.status(400).json({ error: 'Server not found' });
    const result = await postApi(server, '/crud/store_modem', modemData);
    res.json({ ok: true, result });
  } catch (err) { res.status(502).json({ error: 'Store modem failed', details: err.message }); }
});

app.post('/api/admin/apply_modem', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { serverName, imei } = req.body;
    if (!serverName || !imei) return res.status(400).json({ error: 'serverName and imei required' });
    const server = findServer(serverName);
    if (!server) return res.status(400).json({ error: 'Server not found' });
    const result = await postApi(server, '/modem/settings', { imei });
    res.json({ ok: true, result });
  } catch (err) { res.status(502).json({ error: 'Apply modem failed', details: err.message }); }
});

app.get('/api/admin/modem_status', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { nick, serverName } = req.query;
    if (!nick || !serverName) return res.status(400).json({ error: 'nick and serverName required' });
    const server = findServer(serverName);
    if (!server) return res.status(400).json({ error: 'Server not found' });
    const result = await fetchApi(server, `/apix/show_single_status_json?arg=${encodeURIComponent(nick)}`);
    res.json(result);
  } catch (err) { res.status(502).json({ error: 'Failed', details: err.message }); }
});

app.get('/api/admin/rotation_log', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { nick, serverName } = req.query;
    if (!nick || !serverName) return res.status(400).json({ error: 'nick and serverName required' });
    const server = findServer(serverName);
    if (!server) return res.status(400).json({ error: 'Server not found' });
    const result = await fetchApi(server, `/apix/get_rotation_log?arg=${encodeURIComponent(nick)}`);
    res.json(result);
  } catch (err) { res.status(502).json({ error: 'Failed', details: err.message }); }
});

app.get('/api/admin/speedtest', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { nick, serverName } = req.query;
    if (!nick || !serverName) return res.status(400).json({ error: 'nick and serverName required' });
    const server = findServer(serverName);
    if (!server) return res.status(400).json({ error: 'Server not found' });
    const result = await fetchApi(server, `/apix/speedtest?arg=${encodeURIComponent(nick)}`, 120000);
    res.json(result);
  } catch (err) { res.status(502).json({ error: 'Speedtest failed', details: err.message }); }
});

app.get('/api/admin/speedtest_history', authMiddleware, adminMiddleware, (req, res) => {
  res.json(speedtestHistory);
});

app.get('/api/admin/top_hosts', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { portId, serverName } = req.query;
    if (!portId || !serverName) return res.status(400).json({ error: 'portId and serverName required' });
    const server = findServer(serverName);
    if (!server) return res.status(400).json({ error: 'Server not found' });
    const result = await fetchApi(server, `/apix/top_hosts?arg=${encodeURIComponent(portId)}`);
    res.json(result);
  } catch (err) { res.status(502).json({ error: 'Failed', details: err.message }); }
});

app.get('/api/admin/ip_history', authMiddleware, adminMiddleware, (req, res) => {
  const { key } = req.query;
  if (key) {
    res.json(ipHistory[key] || []);
  } else {
    res.json(ipHistory);
  }
});

// ==================== ADMIN: SMS / USSD ====================

app.get('/api/admin/sms', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { imei, serverName } = req.query;
    if (!imei || !serverName) return res.status(400).json({ error: 'imei and serverName required' });
    const server = findServer(serverName);
    if (!server) return res.status(400).json({ error: 'Server not found' });
    const result = await fetchApi(server, `/modem/sms/${encodeURIComponent(imei)}?json=1`);
    res.json(result);
  } catch (err) { res.status(502).json({ error: 'Read SMS failed', details: err.message }); }
});

app.post('/api/admin/send_sms', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { imei, serverName, phone, sms } = req.body;
    if (!imei || !serverName || !phone || !sms) return res.status(400).json({ error: 'imei, serverName, phone, sms required' });
    const server = findServer(serverName);
    if (!server) return res.status(400).json({ error: 'Server not found' });
    const result = await postApi(server, '/modem/send-sms', { imei, phone, sms });
    res.json({ ok: true, result });
  } catch (err) { res.status(502).json({ error: 'Send SMS failed', details: err.message }); }
});

app.post('/api/admin/send_ussd', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { imei, serverName, ussd } = req.body;
    if (!imei || !serverName || !ussd) return res.status(400).json({ error: 'imei, serverName, ussd required' });
    const server = findServer(serverName);
    if (!server) return res.status(400).json({ error: 'Server not found' });
    const result = await postApi(server, '/modem/send-ussd', { imei, ussd });
    res.json({ ok: true, result });
  } catch (err) { res.status(502).json({ error: 'Send USSD failed', details: err.message }); }
});

app.post('/api/admin/purge_sms', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { nick, serverName } = req.body;
    if (!nick || !serverName) return res.status(400).json({ error: 'nick and serverName required' });
    const server = findServer(serverName);
    if (!server) return res.status(400).json({ error: 'Server not found' });
    const result = await fetchApi(server, `/apix/purge_sms_json?arg=${encodeURIComponent(nick)}`);
    res.json({ ok: true, result });
  } catch (err) { res.status(502).json({ error: 'Purge SMS failed', details: err.message }); }
});

// ==================== ADMIN: PORT CRUD ====================

app.post('/api/admin/store_port', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { serverName, ...portData } = req.body;
    if (!serverName || !portData.IMEI || !portData.portID) return res.status(400).json({ error: 'serverName, IMEI, portID required' });
    const server = findServer(serverName);
    if (!server) return res.status(400).json({ error: 'Server not found' });
    const result = await postApi(server, '/crud/store_port', portData);
    res.json({ ok: true, result });
  } catch (err) { res.status(502).json({ error: 'Store port failed', details: err.message }); }
});

// Update proxy credentials (login/password) for an existing port
app.post('/api/admin/update_port_creds', authMiddleware, adminMiddleware, async (req, res) => {
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

app.post('/api/admin/apply_port', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { portId, serverName } = req.body;
    if (!portId || !serverName) return res.status(400).json({ error: 'portId and serverName required' });
    const server = findServer(serverName);
    if (!server) return res.status(400).json({ error: 'Server not found' });
    const result = await fetchApi(server, `/apix/apply_port?arg=${encodeURIComponent(portId)}`);
    res.json({ ok: true, result });
  } catch (err) { res.status(502).json({ error: 'Apply port failed', details: err.message }); }
});

app.post('/api/admin/purge_port', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { portId, serverName } = req.body;
    if (!portId || !serverName) return res.status(400).json({ error: 'portId and serverName required' });
    const server = findServer(serverName);
    if (!server) return res.status(400).json({ error: 'Server not found' });
    const result = await fetchApi(server, `/apix/purge_port?arg=${encodeURIComponent(portId)}`);
    res.json({ ok: true, result });
  } catch (err) { res.status(502).json({ error: 'Purge port failed', details: err.message }); }
});

app.get('/api/admin/free_ports', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { serverName } = req.query;
    if (!serverName) return res.status(400).json({ error: 'serverName required' });
    const server = findServer(serverName);
    if (!server) return res.status(400).json({ error: 'Server not found' });
    const result = await fetchApi(server, '/apix/get_free_tcp_ports');
    res.json(result);
  } catch (err) { res.status(502).json({ error: 'Failed', details: err.message }); }
});

// ==================== ADMIN: BANDWIDTH ====================

app.get('/api/admin/bandwidth_single', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { portId, serverName } = req.query;
    if (!portId || !serverName) return res.status(400).json({ error: 'portId and serverName required' });
    const server = findServer(serverName);
    if (!server) return res.status(400).json({ error: 'Server not found' });
    const result = await fetchApi(server, `/apix/bandwidth_report_json?arg=${encodeURIComponent(portId)}`);
    res.json(result);
  } catch (err) { res.status(502).json({ error: 'Failed', details: err.message }); }
});

app.get('/api/admin/bandwidth_period', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { portId, serverName, start, end } = req.query;
    if (!portId || !serverName || !start || !end) return res.status(400).json({ error: 'portId, serverName, start, end required' });
    const server = findServer(serverName);
    if (!server) return res.status(400).json({ error: 'Server not found' });
    const result = await fetchApi(server, `/apix/get_counters_port?PORTID=${encodeURIComponent(portId)}&START=${encodeURIComponent(start)}&END=${encodeURIComponent(end)}`);
    res.json(result);
  } catch (err) { res.status(502).json({ error: 'Failed', details: err.message }); }
});

app.post('/api/admin/reset_bandwidth', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { portId, serverName } = req.body;
    if (!portId || !serverName) return res.status(400).json({ error: 'portId and serverName required' });
    const server = findServer(serverName);
    if (!server) return res.status(400).json({ error: 'Server not found' });
    const result = await fetchApi(server, `/apix/bandwidth_reset_counter?arg=${encodeURIComponent(portId)}`);
    res.json({ ok: true, result });
  } catch (err) { res.status(502).json({ error: 'Failed', details: err.message }); }
});

// ==================== ADMIN: ANALYTICS ====================

app.get('/api/admin/unique_ips', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { serverName } = req.query;
    if (!serverName) return res.status(400).json({ error: 'serverName required' });
    const server = findServer(serverName);
    if (!server) return res.status(400).json({ error: 'Server not found' });
    const result = await fetchApi(server, '/apix/unique_ips_json');
    res.json(result);
  } catch (err) { res.status(502).json({ error: 'Failed', details: err.message }); }
});

app.get('/api/admin/backup', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { serverName } = req.query;
    if (!serverName) return res.status(400).json({ error: 'serverName required' });
    const server = findServer(serverName);
    if (!server) return res.status(400).json({ error: 'Server not found' });
    const result = await fetchApi(server, '/crud/backup_export');
    res.json(result);
  } catch (err) { res.status(502).json({ error: 'Backup failed', details: err.message }); }
});

app.get('/api/admin/vpn_profile', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { portId, serverName } = req.query;
    if (!portId || !serverName) return res.status(400).json({ error: 'portId and serverName required' });
    const server = findServer(serverName);
    if (!server) return res.status(400).json({ error: 'Server not found' });
    const { buffer, contentType } = await fetchApiRaw(server, `/get_vpn_profile/${encodeURIComponent(portId)}.ovpn`);
    res.set('Content-Type', contentType || 'application/x-openvpn-profile');
    res.set('Content-Disposition', `attachment; filename="${portId}.ovpn"`);
    res.send(buffer);
  } catch (err) { res.status(502).json({ error: 'VPN profile failed', details: err.message }); }
});

app.get('/api/admin/shop_report', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { shop, period, serverName } = req.query;
    if (!shop || !period || !serverName) return res.status(400).json({ error: 'shop, period, serverName required' });
    const server = findServer(serverName);
    if (!server) return res.status(400).json({ error: 'Server not found' });
    const result = await fetchApi(server, `/apix/shop_report/${encodeURIComponent(shop)}/${encodeURIComponent(period)}`);
    res.json(result);
  } catch (err) { res.status(502).json({ error: 'Failed', details: err.message }); }
});

// ==================== TOOLS: PROXY CHECKER ====================

app.post('/api/tools/check_proxy', authMiddleware, async (req, res) => {
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

  async function checkOneProxy(proxy) {
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
        const net = require('net');
        const sock = new net.Socket();
        sock.setTimeout(5000);
        sock.connect(parseInt(proxy.port), proxy.ip, () => { sock.destroy(); resolve(true); });
        sock.on('error', (err) => { sock.destroy(); reject(err); });
        sock.on('timeout', () => { sock.destroy(); reject(new Error('Timeout')); });
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

// ==================== TOP HOSTS AGGREGATION (auto-nightly) ====================
const TOP_HOSTS_CACHE_FILE = path.join(__dirname, 'top_hosts_cache.json');

let topHostsCache = { data: {}, perPort: {}, updatedAt: null };
try {
  if (fs.existsSync(TOP_HOSTS_CACHE_FILE)) {
    topHostsCache = JSON.parse(fs.readFileSync(TOP_HOSTS_CACHE_FILE, 'utf8'));
    if (!topHostsCache.perPort) topHostsCache.perPort = {};
  }
} catch (e) { console.error('Failed to load top_hosts cache:', e.message); }

async function aggregateTopHosts() {
  console.log('[TopHosts] Starting aggregation...');
  const merged = {};
  const perPort = {};
  let fetchedCount = 0;
  let errorCount = 0;

  for (const server of apiServers) {
    try {
      const [portsResult, bwResult] = await Promise.all([
        fetchApi(server, '/apix/list_ports_json'),
        fetchApi(server, '/apix/bandwidth_report_all')
      ]);

      const portNameMap = {};
      if (bwResult && typeof bwResult === 'object') {
        for (const [portId, b] of Object.entries(bwResult)) {
          if (b.portName) portNameMap[portId] = b.portName;
        }
      }

      const portKeys = portsResult ? Object.keys(portsResult).filter(k => k !== 'raw') : [];
      console.log(`[TopHosts] ${server.name} list_ports_json: ${portKeys.length} IMEIs`);

      let portsMap = {};
      if (portsResult && typeof portsResult === 'object' && !portsResult.raw) {
        portsMap = portsResult;
      } else if (portsResult && portsResult.raw) {
        try { portsMap = JSON.parse(portsResult.raw); } catch(e) { console.log('[TopHosts] Failed to parse raw'); }
      }

      const portIds = [];
      for (const imei in portsMap) {
        if (imei === 'raw' || imei === '_server') continue;
        const ports = portsMap[imei];
        if (Array.isArray(ports)) {
          ports.forEach(p => { if (p.portID) portIds.push(p.portID); });
        }
      }
      console.log(`[TopHosts] ${server.name}: found ${portIds.length} ports to scan`);

      for (const portId of portIds) {
        try {
          const result = await fetchApi(server, `/apix/top_hosts?arg=${encodeURIComponent(portId)}`, 15000);
          if (result && typeof result === 'object') {
            let entries = [];
            if (Array.isArray(result)) entries = result;
            else {
              for (const k in result) {
                if (k !== 'raw' && typeof result[k] !== 'object') entries.push({ host: k, count: parseInt(result[k]) || 0 });
              }
            }

            const portName = portNameMap[portId] || portId;

            entries.forEach(e => {
              const h = e.host || e.domain || 'unknown';
              const count = e.count || e.requests || 1;
              merged[h] = (merged[h] || 0) + count;
              if (!perPort[portName]) perPort[portName] = {};
              perPort[portName][h] = (perPort[portName][h] || 0) + count;
            });
            if (entries.length > 0) fetchedCount++;
          }
        } catch (e) { errorCount++; }
      }
    } catch (e) {
      console.error(`[TopHosts] Error on server ${server.name}:`, e.message);
      errorCount++;
    }
  }

  topHostsCache = {
    data: merged,
    perPort,
    updatedAt: new Date().toISOString(),
    stats: { domains: Object.keys(merged).length, portsScanned: fetchedCount, errors: errorCount }
  };
  try {
    fs.writeFileSync(TOP_HOSTS_CACHE_FILE, JSON.stringify(topHostsCache, null, 2));
  } catch (e) { console.error('[TopHosts] Failed to save cache:', e.message); }
  console.log(`[TopHosts] Aggregation complete: ${Object.keys(merged).length} domains from ${fetchedCount} ports (${errorCount} errors), ${Object.keys(perPort).length} portNames`);
  return topHostsCache;
}

app.get('/api/admin/top_hosts_aggregated', authMiddleware, adminMiddleware, (req, res) => {
  res.json(topHostsCache);
});

app.post('/api/admin/top_hosts_refresh', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const result = await aggregateTopHosts();
    res.json({ ok: true, stats: result.stats, updatedAt: result.updatedAt });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ==================== SCHEDULERS ====================

// Dynamic speedtest scheduler (supports multiple times per day)
let speedtestTimers = [];

function rescheduleSpeedtests() {
  // Clear existing timers
  speedtestTimers.forEach(t => { if (t.timeout) clearTimeout(t.timeout); if (t.interval) clearInterval(t.interval); });
  speedtestTimers = [];

  const times = appSettings.speedtest_times || ['02:00', '14:00'];
  for (const timeStr of times) {
    const parts = timeStr.split(':').map(Number);
    if (parts.length !== 2 || isNaN(parts[0]) || isNaN(parts[1])) continue;
    scheduleRepeating(parts[0], parts[1], 'Speedtest-' + timeStr, runNightlySpeedtests);
  }
}

function scheduleRepeating(hour, minute, label, fn) {
  const now = new Date();
  const next = new Date();
  next.setUTCHours(hour, minute, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  const msUntil = next - now;
  console.log(`[${label}] Next run at ${next.toISOString()} (in ${Math.round(msUntil / 60000)} min)`);
  const entry = {};
  entry.timeout = setTimeout(() => {
    fn().catch(e => console.error(`[${label}] Error:`, e.message));
    entry.interval = setInterval(() => {
      fn().catch(e => console.error(`[${label}] Error:`, e.message));
    }, 24 * 60 * 60 * 1000);
  }, msUntil);
  speedtestTimers.push(entry);
}

// Schedule nightly TopHosts at 03:00
function scheduleNightly(hour, label, fn) {
  const now = new Date();
  const next = new Date();
  next.setUTCHours(hour, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  const msUntil = next - now;
  console.log(`[${label}] Next run at ${next.toISOString()} (in ${Math.round(msUntil / 60000)} min)`);
  setTimeout(() => {
    fn().catch(e => console.error(`[${label}] Error:`, e.message));
    setInterval(() => {
      fn().catch(e => console.error(`[${label}] Error:`, e.message));
    }, 24 * 60 * 60 * 1000);
  }, msUntil);
}

// ==================== DAILY BILLING ====================
async function runDailyBilling() {
  console.log('[Billing] Starting daily billing run...');
  let results;
  try {
    results = await fetchAllServersData();
  } catch (e) {
    console.error('[Billing] Failed to fetch server data:', e.message);
    return;
  }

  let charged = 0, skipped = 0;

  for (const client of clients) {
    if (!client.portName || !client.price || client.price <= 0) {
      skipped++;
      continue;
    }

    try {
      const currentMonthBytes = computeClientMonthBytes(results, client.portName);
      const snapshot = client.last_traffic_snapshot || { timestamp: null, month_bytes: 0 };
      const previousBytes = snapshot.month_bytes || 0;

      // Compute delta
      let deltaBytes;
      if (currentMonthBytes < previousBytes) {
        // Month reset detected: ProxySmart zeroed the counters
        console.log(`[Billing] Month reset detected for ${client.name}: prev=${previousBytes}, current=${currentMonthBytes}`);
        deltaBytes = currentMonthBytes;
      } else {
        deltaBytes = currentMonthBytes - previousBytes;
      }

      // Always update snapshot
      client.last_traffic_snapshot = {
        timestamp: new Date().toISOString(),
        month_bytes: currentMonthBytes
      };

      if (deltaBytes <= 0) {
        skipped++;
        continue;
      }

      // Compute cost based on billing type
      let cost = 0;
      const deltaGb = deltaBytes / (1024 * 1024 * 1024);

      if (client.billingType === 'per_modem') {
        // Per-modem: daily proration of monthly rate
        let modemCount = 0;
        for (const data of results) {
          if (typeof data.bw === 'object') {
            for (const [portId, b] of Object.entries(data.bw)) {
              if (b.portName === client.portName) modemCount++;
            }
          }
        }
        cost = (client.price * modemCount) / 30;
      } else {
        // per_gb billing (default)
        cost = client.price * deltaGb;
      }

      cost = Math.round(cost * 100) / 100;

      if (cost <= 0) {
        skipped++;
        continue;
      }

      // Deduct from balance
      const balanceBefore = client.balance || 0;
      client.balance = Math.round((balanceBefore - cost) * 100) / 100;

      // Record in ledger
      const ledgerKey = client.id;
      if (!billingLedger[ledgerKey]) billingLedger[ledgerKey] = [];
      billingLedger[ledgerKey].push({
        type: 'charge',
        date: new Date().toISOString().slice(0, 10),
        timestamp: new Date().toISOString(),
        delta_bytes: Math.round(deltaBytes),
        delta_gb: Math.round(deltaGb * 1000) / 1000,
        price_per_unit: client.price,
        billing_type: client.billingType || 'per_gb',
        cost,
        currency: client.currency || 'RUB',
        balance_before: balanceBefore,
        balance_after: client.balance,
        note: 'Daily traffic charge'
      });

      charged++;
      console.log(`[Billing] ${client.name}: delta=${deltaGb.toFixed(3)}GB, cost=${cost} ${client.currency || 'RUB'}, balance=${client.balance}`);
    } catch (e) {
      console.error(`[Billing] Error billing ${client.name}:`, e.message);
    }
  }

  saveClients(clients);
  saveBillingLedger();
  console.log(`[Billing] Complete: ${charged} charged, ${skipped} skipped`);
}

// ==================== AUTO-CREATE MISSING CLIENTS ====================

async function autoCreateMissingClients() {
  try {
    const results = await fetchAllServersData();
    const existingPortNames = new Set(clients.map(c => c.portName));
    const allPortNames = new Set();

    for (const data of results) {
      if (typeof data.bw === 'object') {
        for (const [portId, b] of Object.entries(data.bw)) {
          if (b.portName) allPortNames.add(b.portName);
        }
      }
    }

    // Count ports per portName for pricing
    const portCountMap = {};
    for (const data of results) {
      if (typeof data.bw === 'object') {
        for (const [portId, b] of Object.entries(data.bw)) {
          if (b.portName) portCountMap[b.portName] = (portCountMap[b.portName] || 0) + 1;
        }
      }
    }

    let created = 0;
    for (const pn of allPortNames) {
      if (existingPortNames.has(pn)) continue;
      const login = pn.toLowerCase().replace(/[^a-z0-9_]/g, '_');
      if (users[login]) continue;

      const proxyCount = portCountMap[pn] || 1;
      const autoPrice = getPriceForProxyCount(proxyCount);
      const password = crypto.randomBytes(8).toString('hex');
      const client = {
        id: generateId(),
        name: pn,
        portName: pn,
        login: login,
        password: password,
        contact: '',
        notes: 'Auto-created from portName',
        billingType: 'per_gb',
        price: autoPrice,
        currency: 'RUB',
        payments: [],
        apiKey: 'prx_' + crypto.randomBytes(24).toString('hex'),
        referral_code: 'REF-' + crypto.randomBytes(4).toString('hex').toUpperCase(),
        referred_by: null,
        referral_balance: 0,
        resetToken: crypto.randomBytes(16).toString('hex'),
        documents: [],
        balance: 0,
        last_traffic_snapshot: { timestamp: null, month_bytes: 0 },
        createdAt: new Date().toISOString()
      };
      clients.push(client);
      users[login] = { password, portNameFilter: pn, source: 'client', clientId: client.id };
      created++;
      console.log(`  Auto-created client for portName "${pn}" (login: ${login}, pass: ${password})`);
    }

    if (created > 0) {
      saveClients(clients);
      console.log(`[AutoCreate] Created ${created} new client(s)`);
    } else {
      console.log('[AutoCreate] All portNames have client accounts');
    }
  } catch (e) {
    console.error('[AutoCreate] Error:', e.message);
  }
}

// ==================== PAGES ====================

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// ==================== API DOCUMENTATION ====================

app.get('/api/docs', (req, res) => {
  const baseUrl = `${req.protocol}://${req.get('host')}`;
  res.json({
    title: 'Proxies.Rent API Documentation',
    version: '1.0',
    baseUrl,
    authentication: {
      description: 'Используйте API ключ из вашего личного кабинета',
      methods: [
        { name: 'Query parameter', example: `${baseUrl}/api/v1/proxies?apiKey=YOUR_API_KEY` },
        { name: 'Session token', header: 'X-Auth-Token', description: 'Получается через /api/login' }
      ]
    },
    endpoints: {
      public: [
        {
          method: 'GET',
          path: '/api/v1/proxies',
          description: 'Получить список всех ваших прокси',
          params: {
            apiKey: { required: true, description: 'Ваш API ключ (найдите в личном кабинете)' },
            format: { required: false, default: 'json', options: ['json', 'txt', 'csv'], description: 'Формат ответа' }
          },
          examples: {
            json: `curl "${baseUrl}/api/v1/proxies?apiKey=YOUR_KEY&format=json"`,
            txt: `curl "${baseUrl}/api/v1/proxies?apiKey=YOUR_KEY&format=txt"`,
            csv: `curl "${baseUrl}/api/v1/proxies?apiKey=YOUR_KEY&format=csv"`
          },
          response_json: {
            proxies: [{ modem: 'MD2_64', ip: '89.149.100.92', httpPort: 8040, socksPort: 9040, login: 'user', password: 'pass', resetUrl: 'http://...' }],
            count: 1,
            client: 'ClientName'
          },
          response_txt: 'ip:port:login:password|reset_url (по одному на строку)'
        },
        {
          method: 'GET',
          path: '/api/client/reset_ip_by_token',
          description: 'Сброс IP модема по токену (не требует авторизации)',
          params: {
            nick: { required: true, description: 'Ник модема (например MD2_64)' },
            token: { required: true, description: 'Токен сброса из вашего аккаунта' }
          },
          example: `curl "${baseUrl}/api/client/reset_ip_by_token?nick=MD2_64&token=YOUR_TOKEN"`
        }
      ],
      authenticated: [
        {
          method: 'POST',
          path: '/api/login',
          description: 'Авторизация — получение токена сессии',
          body: { login: 'string', password: 'string' },
          response: { token: 'string', login: 'string', isAdmin: 'boolean' }
        },
        {
          method: 'GET',
          path: '/api/client/data',
          description: 'Получить все данные клиента (модемы, трафик, порты)',
          headers: { 'X-Auth-Token': 'YOUR_TOKEN' }
        },
        {
          method: 'GET',
          path: '/api/client/credentials_export',
          description: 'Экспорт доступов прокси с прямыми ссылками на смену IP',
          headers: { 'X-Auth-Token': 'YOUR_TOKEN' }
        },
        {
          method: 'POST',
          path: '/api/client/reset_ip',
          description: 'Сброс IP модема',
          headers: { 'X-Auth-Token': 'YOUR_TOKEN', 'Content-Type': 'application/json' },
          body: { imei: 'IMEI модема', serverName: 'S1 или S2' }
        },
        {
          method: 'GET',
          path: '/api/client/rotation_log',
          description: 'Лог ротации IP модема',
          params: { nick: 'Ник модема', serverName: 'S1 или S2' }
        },
        {
          method: 'GET',
          path: '/api/client/ip_history',
          description: 'История смены IP с точными временными метками',
          params: { key: 'IMEI ключ (формат: S1_IMEI или S2_IMEI)' }
        },
        {
          method: 'GET',
          path: '/api/client/referral',
          description: 'Информация о партнёрской программе'
        },
        {
          method: 'GET',
          path: '/api/client/documents',
          description: 'Список закрывающих документов'
        },
        {
          method: 'POST',
          path: '/api/tools/check_proxy',
          description: 'Проверка работоспособности прокси (макс. 50 штук)',
          body: { proxies: [{ ip: 'string', port: 'number', login: 'string (опц.)', password: 'string (опц.)' }] }
        }
      ]
    },
    formats: {
      txt: 'ip:port:login:password|direct_reset_url',
      csv: 'ip,http_port,socks_port,login,password,reset_url',
      json: 'Полный JSON объект со всеми данными'
    },
    notes: [
      'Ссылка для смены IP работает напрямую с сервером — не требует работы нашего сервера',
      'API ключ можно найти в личном кабинете',
      'Спидтесты выполняются автоматически в 02:00 и 14:00 UTC',
      'IP история обновляется каждые 10 минут'
    ]
  });
});

// ==================== JSON fallback for unknown API routes (Bug #5) ====================
app.use('/api', (req, res) => {
  res.status(404).json({
    success: false,
    error: `Cannot ${req.method} ${req.path}`
  });
});

app.listen(PORT, () => {
  console.log(`Proxies.Rent Dashboard running at http://localhost:${PORT}`);

  // Schedule speedtests (configurable times, default 02:00 + 14:00)
  rescheduleSpeedtests();

  // Schedule nightly TopHosts at 03:00
  scheduleNightly(3, 'TopHosts', aggregateTopHosts);

  // Start modem tracking (IP + uptime) every 5 minutes
  console.log('[Tracking] Starting IP & uptime tracking (every 5 min)...');
  trackModems().catch(e => console.error('[Tracking] Initial error:', e.message));
  setInterval(() => {
    trackModems().catch(e => console.error('[Tracking] Error:', e.message));
  }, 5 * 60 * 1000);

  // If no cached top_hosts data, do initial aggregation
  if (!topHostsCache.updatedAt) {
    console.log('[TopHosts] No cached data, running initial aggregation...');
    aggregateTopHosts().catch(e => console.error('[TopHosts] Initial error:', e.message));
  }

  // Auto-create client accounts for all portNames that don't have one
  autoCreateMissingClients().catch(e => console.error('[AutoCreate] Error:', e.message));

  // Schedule daily billing at 23:55 UTC
  scheduleRepeating(23, 55, 'DailyBilling', runDailyBilling);

  // Billing catch-up: if last snapshot is older than 26 hours, run now
  (async () => {
    try {
      const now = Date.now();
      let needsCatchup = false;
      for (const c of clients) {
        if (c.last_traffic_snapshot && c.last_traffic_snapshot.timestamp) {
          const lastRun = new Date(c.last_traffic_snapshot.timestamp).getTime();
          if (now - lastRun > 26 * 60 * 60 * 1000) {
            needsCatchup = true;
            break;
          }
        }
      }
      if (needsCatchup) {
        console.log('[Billing] Catch-up: missed billing detected, running now...');
        await runDailyBilling();
      }
    } catch (e) {
      console.error('[Billing] Catch-up error:', e.message);
    }
  })();
});
