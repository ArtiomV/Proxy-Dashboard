'use strict';

/**
 * Single fetch through a modem's HTTP proxy, with detailed timing breakdown.
 *
 * Returns a sample object:
 *   {
 *     status: 'success' | 'timeout' | 'http_error' | 'conn_error',
 *     http_status: number,
 *     total_ms: number,
 *     connect_ms: number,    // time to establish TCP+TLS
 *     ttfb_ms: number,       // time-to-first-byte
 *     bytes: number,
 *     error_msg: string | null,
 *   }
 *
 * Diagnosing the BrandAnalytics-style "timeout after partial body" requires
 * separating connect-time from first-byte-time from full-body-time:
 *   - Slow connect_ms → proxy/TLS issue
 *   - Slow ttfb_ms → upstream (modem→target) issue
 *   - Fast ttfb_ms but slow total_ms → bandwidth saturation during body
 *
 * Uses `undici` (bundled with Node 18+) for proper ProxyAgent support without
 * adding a new dependency.
 */

const { fetch, ProxyAgent } = require('undici');

async function executeRequest({ url, method, headers, body, proxyUrl, timeoutMs }) {
  const t0 = process.hrtime.bigint();
  let connectMs = 0, ttfbMs = 0, bytes = 0;
  let httpStatus = 0;
  let status = 'success';
  let errMsg = null;

  // undici doesn't expose a clean per-phase timing hook, so we use AbortSignal
  // for the overall timeout and approximate connect/ttfb from response milestones.
  // connect_ms is measured up to the point we receive HTTP headers (close enough
  // to TCP+TLS handshake for our diagnostic purposes); ttfb_ms is the first body
  // chunk arrival; total_ms is body complete.
  const dispatcher = new ProxyAgent({ uri: proxyUrl, connect: { timeout: timeoutMs } });
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);

  try {
    const resp = await fetch(url, {
      method: method || 'GET',
      headers: headers || {},
      body: body || undefined,
      signal: ctrl.signal,
      dispatcher,
      redirect: 'follow',
    });
    const tConnect = process.hrtime.bigint();
    connectMs = Number((tConnect - t0) / 1000000n);
    httpStatus = resp.status;

    // Stream the body, measuring TTFB on first chunk
    let firstChunk = true;
    const reader = resp.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (firstChunk) {
        ttfbMs = Number((process.hrtime.bigint() - t0) / 1000000n);
        firstChunk = false;
      }
      bytes += value.byteLength;
    }
    if (httpStatus >= 400) status = 'http_error';
  } catch (e) {
    // Classify the failure
    const m = (e && e.message) || String(e);
    if (ctrl.signal.aborted || /aborted|timeout|TIMEOUT/i.test(m)) {
      status = 'timeout';
    } else if (/ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|ECONNABORTED/i.test(e.code || m)) {
      status = 'conn_error';
    } else {
      status = 'conn_error';
    }
    errMsg = m.slice(0, 240);
  } finally {
    clearTimeout(timer);
    try { dispatcher.close(); } catch (_) { /* best-effort */ }
  }

  const totalMs = Number((process.hrtime.bigint() - t0) / 1000000n);
  // TTFB defaults to total when body was empty
  if (ttfbMs === 0) ttfbMs = totalMs;
  return { status, http_status: httpStatus, total_ms: totalMs, connect_ms: connectMs, ttfb_ms: ttfbMs, bytes, error_msg: errMsg };
}

module.exports = { executeRequest };
