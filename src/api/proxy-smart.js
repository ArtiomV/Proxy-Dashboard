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

// Default TLS options for outbound HTTPS — explicit strict cert validation
// so a future copy-paste can't accidentally disable it.
const TLS_DEFAULTS = { rejectUnauthorized: true };

function findServer(serverName) {
  return apiServers.find(s => s.name === serverName);
}

// ---------------------------------------------------------------------------
// HTTP fetch helpers
// ---------------------------------------------------------------------------

// Validate API path to prevent path traversal (SSRF mitigation)
function _validateApiPath(apiPath) {
  if (typeof apiPath !== 'string') throw new Error('Invalid API path');
  if (apiPath.includes('..') || apiPath.includes('\x00')) throw new Error('Path traversal blocked');
}

// Hard cap on response body to protect against runaway HTML from broken
// ProxySmart instances (we've seen 100MB+ status dumps under high load).
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024; // 16 MB

// In-flight request map keyed by `${server.name}|${method}|${path}` so two
// concurrent reads of the same status endpoint share a single TCP request.
// Helps when multiple admin tabs render simultaneously.
const _inflight = new Map();

function _inflightKey(serverName, method, apiPath) {
  return `${serverName}|${method}|${apiPath}`;
}

function fetchApi(server, apiPath, timeout = 10000) {
  _validateApiPath(apiPath);
  const key = _inflightKey(server.name, 'GET-json', apiPath);
  const existing = _inflight.get(key);
  if (existing) return existing;
  const p = new Promise((resolve, reject) => {
    const url = new URL(apiPath, server.url);
    const auth = Buffer.from(`${server.user}:${server.pass}`).toString('base64');
    const req = getHttpLib(url).request({
      hostname: url.hostname, port: url.port,
      path: url.pathname + url.search, method: 'GET',
      headers: { 'Authorization': `Basic ${auth}`, 'Accept': 'application/json' },
      timeout
    }, (proxyRes) => {
      let data = '';
      let bytes = 0;
      let aborted = false;
      proxyRes.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > MAX_RESPONSE_BYTES) {
          aborted = true; req.destroy();
          reject(new Error(`Response from ${server.name} exceeded ${MAX_RESPONSE_BYTES} bytes`));
          return;
        }
        data += chunk;
      });
      proxyRes.on('end', () => {
        if (aborted) return;
        if (proxyRes.statusCode >= 400) {
          if (proxyRes.statusCode === 401) {
            logger.error(`[ProxySmart AUTH] ${server.name} returned 401 Unauthorized — credentials may need rotation`);
          }
          reject(new Error(`${server.name} HTTP ${proxyRes.statusCode}: ${data.slice(0, 200)}`));
          return;
        }
        // Try JSON parse first — ProxySmart serves valid JSON with
        // Content-Type: text/html (server quirk), so the content-type header
        // is unreliable. Only reject if BOTH parse fails AND body actually
        // starts with HTML markers — that's the real auth-wall signature.
        try { resolve(JSON.parse(data)); return; } catch (_) { /* not JSON */ }
        const head = data.slice(0, 200).trim();
        if (/^<!DOCTYPE|^<html|^<HTML/i.test(head)) {
          reject(new Error(`${server.name} returned HTML instead of JSON (likely auth-wall or maintenance page)`));
          return;
        }
        // Empty success body — acceptable (some endpoints return nothing on OK).
        if (!data || !data.trim()) { resolve({ raw: '' }); return; }
        reject(new Error(`${server.name} returned non-JSON body: ${data.slice(0, 200)}`));
      });
    });
    req.on('error', (err) => reject(err));
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout from ' + server.name)); });
    req.end();
  }).finally(() => _inflight.delete(key));
  _inflight.set(key, p);
  return p;
}

function fetchApiRaw(server, apiPath, timeout = 10000) {
  _validateApiPath(apiPath);
  const key = _inflightKey(server.name, 'GET-raw', apiPath);
  const existing = _inflight.get(key);
  if (existing) return existing;
  const p = new Promise((resolve, reject) => {
    const url = new URL(apiPath, server.url);
    const auth = Buffer.from(`${server.user}:${server.pass}`).toString('base64');
    const req = getHttpLib(url).request({
      hostname: url.hostname, port: url.port,
      path: url.pathname + url.search, method: 'GET',
      headers: { 'Authorization': `Basic ${auth}` },
      timeout
    }, (proxyRes) => {
      const chunks = [];
      let bytes = 0;
      let aborted = false;
      proxyRes.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > MAX_RESPONSE_BYTES) {
          aborted = true; req.destroy();
          reject(new Error(`Response from ${server.name} exceeded ${MAX_RESPONSE_BYTES} bytes`));
          return;
        }
        chunks.push(chunk);
      });
      proxyRes.on('end', () => {
        if (aborted) return;
        if (proxyRes.statusCode >= 400) {
          reject(new Error(`${server.name} HTTP ${proxyRes.statusCode}`));
          return;
        }
        resolve({ buffer: Buffer.concat(chunks), contentType: proxyRes.headers['content-type'] || '' });
      });
    });
    req.on('error', (err) => reject(err));
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout from ' + server.name)); });
    req.end();
  }).finally(() => _inflight.delete(key));
  _inflight.set(key, p);
  return p;
}

function postApi(server, apiPath, body, timeout = 10000) {
  // No dedup for POST — they're mutating, must always go through.
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
      let bytes = 0;
      let aborted = false;
      proxyRes.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > MAX_RESPONSE_BYTES) {
          aborted = true; req.destroy();
          reject(new Error(`Response from ${server.name} exceeded ${MAX_RESPONSE_BYTES} bytes`));
          return;
        }
        data += chunk;
      });
      proxyRes.on('end', () => {
        if (aborted) return;
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

  // Use structuredClone (Node 17+) — 5-10x faster than JSON.parse(JSON.stringify(...)).
  // Plus it preserves Dates and doesn't choke on undefined.
  const deepClone = (typeof structuredClone === 'function')
    ? (v) => structuredClone(v)
    : (v) => JSON.parse(JSON.stringify(v));

  let offlineStatus = [];
  if (Array.isArray(cached.status)) {
    offlineStatus = cached.status.map(m => {
      const copy = deepClone(m);
      if (copy.net_details) copy.net_details.IS_ONLINE = 'no';
      copy._cached = true;
      copy._cachedAt = cached.cachedAt;
      return copy;
    });
  }

  return {
    bw: deepClone(cached.bw || {}),
    status: offlineStatus,
    ports: deepClone(cached.ports || {}),
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
  // Atomic check-or-start: previously between the cache check and the
  // _psFetchPromise check there was a window where two concurrent callers
  // both started fresh fetches. Snapshot now-state once and decide.
  const cacheFresh = _psCache && (Date.now() - _psCacheTs) < PS_CACHE_TTL;
  if (cacheFresh) return _psCache;
  if (_psFetchPromise) return _psFetchPromise;
  // Set promise FIRST so a concurrent caller hitting line 348 sees it.
  let resolveOuter, rejectOuter;
  _psFetchPromise = new Promise((resolve, reject) => { resolveOuter = resolve; rejectOuter = reject; });
  fetchAllServersData()
    .then(r => { _psCache = r; _psCacheTs = Date.now(); _psFetchPromise = null; resolveOuter(r); })
    .catch(e => { _psFetchPromise = null; rejectOuter(e); });
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
  // Drop the multi-server fetchAllServersDataCached() cache so the next call
  // re-fetches from ProxySmart. Server.js previously did this via
  //   _psCache = null; _psCacheTs = 0;
  // which was a silent no-op (identifiers don't exist in server.js scope) —
  // every cache-invalidate code path was broken before this function existed.
  invalidateCache() { _psCache = null; _psCacheTs = 0; },
  PS_CACHE_TTL,
};
