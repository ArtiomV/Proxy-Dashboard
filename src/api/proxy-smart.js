/**
 * ProxySmart API client and server-data caching.
 *
 * Extracted from server.js — contains all low-level HTTP helpers for talking
 * to ProxySmart API servers plus the multi-server fetch / cache layer.
 *
 * Usage:
 *   const proxySmart = require('./src/api/proxy-smart');
 *   proxySmart.init({ http, https, logger, apiServers, safeWriteFile,
 *                      SERVER_CACHE_FILE, updateKnownModems, injectOfflineModems,
 *                      injectRotationData });
 */

'use strict';

// ---------------------------------------------------------------------------
// External deps — injected via init()
// ---------------------------------------------------------------------------
let http, https, logger, apiServers, safeWriteFile;
let SERVER_CACHE_FILE;
let updateKnownModems, injectOfflineModems, injectRotationData;

// ---------------------------------------------------------------------------
// Module-level cache state
// ---------------------------------------------------------------------------
let serverCache = {};
let _psCache = null;
let _psCacheTs = 0;
let _psFetchPromise = null;
const PS_CACHE_TTL = 10 * 1000;

// ---------------------------------------------------------------------------
// init() — call once after apiServers are defined
// ---------------------------------------------------------------------------
function init(deps) {
  http                = deps.http;
  https               = deps.https;
  logger              = deps.logger;
  apiServers          = deps.apiServers;
  safeWriteFile       = deps.safeWriteFile;
  SERVER_CACHE_FILE   = deps.SERVER_CACHE_FILE;
  updateKnownModems   = deps.updateKnownModems;
  injectOfflineModems = deps.injectOfflineModems;
  injectRotationData  = deps.injectRotationData;

  // Load persisted server cache from disk
  const fs = require('fs');
  try {
    if (fs.existsSync(SERVER_CACHE_FILE)) {
      serverCache = JSON.parse(fs.readFileSync(SERVER_CACHE_FILE, 'utf8'));
      logger.info(`Loaded server cache: ${Object.keys(serverCache).length} server(s) cached`);
    }
  } catch (e) { logger.error('Failed to load server_cache:', e.message); }
}

// ---------------------------------------------------------------------------
// Low-level helpers
// ---------------------------------------------------------------------------

function extractServerName(prefixedId) {
  return apiServers.map(s => s.name).find(n => prefixedId.startsWith(n + '_')) || '';
}

// BUG-05: Detect protocol from URL to use http or https
function getHttpLib(url) {
  return url.protocol === 'https:' ? https : http;
}

function findServer(serverName) {
  return apiServers.find(s => s.name === serverName);
}

// ---------------------------------------------------------------------------
// HTTP fetch helpers
// ---------------------------------------------------------------------------

function fetchApi(server, apiPath, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const url = new URL(apiPath, server.url);
    const auth = Buffer.from(`${server.user}:${server.pass}`).toString('base64');
    const req = getHttpLib(url).request({
      hostname: url.hostname, port: url.port,
      path: url.pathname + url.search, method: 'GET',
      headers: { 'Authorization': `Basic ${auth}`, 'Accept': 'application/json' },
      timeout
    }, (proxyRes) => {
      let data = '';
      proxyRes.on('data', chunk => data += chunk);
      proxyRes.on('end', () => {
        if (proxyRes.statusCode >= 400) {
          reject(new Error(`${server.name} HTTP ${proxyRes.statusCode}: ${data.slice(0, 200)}`));
          return;
        }
        try { resolve(JSON.parse(data)); }
        catch (e) { resolve({ raw: data }); }
      });
    });
    req.on('error', (err) => reject(err));
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout from ' + server.name)); });
    req.end();
  });
}

function fetchApiRaw(server, apiPath, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const url = new URL(apiPath, server.url);
    const auth = Buffer.from(`${server.user}:${server.pass}`).toString('base64');
    const req = getHttpLib(url).request({
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

function postApi(server, apiPath, body, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const url = new URL(apiPath, server.url);
    const auth = Buffer.from(`${server.user}:${server.pass}`).toString('base64');
    const postData = typeof body === 'string' ? body : JSON.stringify(body);
    const req = getHttpLib(url).request({
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
        if (proxyRes.statusCode >= 400) {
          reject(new Error(`${server.name} HTTP ${proxyRes.statusCode}: ${data.slice(0, 200)}`));
          return;
        }
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

// ---------------------------------------------------------------------------
// Server-data cache (persisted to disk)
// ---------------------------------------------------------------------------

function saveServerCache() {
  safeWriteFile(SERVER_CACHE_FILE, JSON.stringify(serverCache));
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
  logger.info(`[Cache] Using cached data for ${serverName} (${ageMinutes} min old)`);

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
    bw: JSON.parse(JSON.stringify(cached.bw || {})),
    status: offlineStatus,
    ports: JSON.parse(JSON.stringify(cached.ports || {})),
    serverName: serverName,
    _cached: true,
    _cachedAt: cached.cachedAt
  };
}

// ---------------------------------------------------------------------------
// Multi-server fetch
// ---------------------------------------------------------------------------

async function fetchServerData(server) {
  const [bw, status, ports] = await Promise.all([
    fetchApi(server, '/apix/bandwidth_report_all'),
    fetchApi(server, '/apix/show_status_json'),
    fetchApi(server, '/apix/list_ports_json')
  ]);
  const result = { bw, status, ports, serverName: server.name };
  // Inject rotation data from cache
  injectRotationData(result);
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
      const data = settled[i].value;
      updateKnownModems(data);   // remember modems we've seen
      injectOfflineModems(data); // add back missing modems as offline
      results.push(data);
    } else {
      const srvName = apiServers[i].name;
      logger.info(`[API] Server ${srvName} unreachable: ${settled[i].reason?.message || 'unknown'}`);
      // Try to use cached data
      const cached = getCachedDataAsOffline(srvName);
      if (cached) {
        injectOfflineModems(cached); // add back missing modems as offline
        results.push(cached);
      } else {
        logger.info(`[API] No cache available for ${srvName}`);
      }
    }
  }
  return results;
}

async function fetchAllServersDataCached() {
  if (_psCache && (Date.now() - _psCacheTs) < PS_CACHE_TTL) return _psCache;
  if (_psFetchPromise) return _psFetchPromise;
  _psFetchPromise = fetchAllServersData()
    .then(r => { _psCache = r; _psCacheTs = Date.now(); _psFetchPromise = null; return r; })
    .catch(e => { _psFetchPromise = null; throw e; });
  return _psFetchPromise;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  init,
  extractServerName,
  getHttpLib,
  findServer,
  fetchApi,
  fetchApiRaw,
  postApi,
  saveServerCache,
  cacheServerData,
  getCachedDataAsOffline,
  fetchServerData,
  fetchAllServersData,
  fetchAllServersDataCached,
  // Expose cache state for external read (e.g. tests)
  get serverCache() { return serverCache; },
  get _psCache() { return _psCache; },
  get _psCacheTs() { return _psCacheTs; },
  PS_CACHE_TTL,
};
