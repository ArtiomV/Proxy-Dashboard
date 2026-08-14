'use strict';

const https = require('https');
const crypto = require('crypto');
const logger = require('../logger');

// Cache for Tochka JWKS public keys.
// Keep TTL short — Tochka rotates signing keys without notice, and stale cache
// means every webhook arriving after rotation is rejected as `key_not_found`.
let tochkaJwksCache = { keys: null, fetchedAt: 0 };
// 15 min — short window so a rotation isn't masked beyond a quarter-hour.
// force-refresh-on-miss in verifyJwtSignature handles in-window rotations.
const JWKS_CACHE_TTL = 15 * 60 * 1000;

function base64urlDecode(str) {
  let b64 = str.replace(/-/g, '+').replace(/_/g, '/');
  while (b64.length % 4) b64 += '=';
  return Buffer.from(b64, 'base64');
}

function decodeJwtPayload(token) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    return JSON.parse(base64urlDecode(parts[1]).toString('utf8'));
  } catch (e) { return null; }
}

function decodeJwtHeader(token) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    return JSON.parse(base64urlDecode(parts[0]).toString('utf8'));
  } catch (e) { return null; }
}

// Fetch JWKS from Tochka Bank
function fetchTochkaJwks(apiToken) {
  // 2026-08: Tochka's authed JWKS endpoint now answers 501/"access token is
  // missing" for keys without open-banking consent (e.g. an acquiring-only API
  // key) — while webhooks still need verification. The bank publishes the same
  // RSA signing key UNauthenticated at /doc/openapi/static/keys/public
  // (single JWK, no kid). Strategy: authed JWKS first (rich, has kids); if it
  // yields no keys — fall back to the static public key.
  return fetchTochkaJwksAuthed(apiToken).then(jwks => {
    if (jwks && Array.isArray(jwks.keys) && jwks.keys.length) return jwks;
    logger.warn('[Tochka JWKS] authed endpoint gave no keys — falling back to static public key');
    return fetchTochkaStaticKey();
  }).catch(e => {
    logger.warn('[Tochka JWKS] authed endpoint failed (' + e.message + ') — falling back to static public key');
    return fetchTochkaStaticKey();
  });
}

function fetchTochkaJwksAuthed(apiToken) {
  return new Promise((resolve, reject) => {
    const headers = apiToken ? { Authorization: 'Bearer ' + apiToken } : {};
    https.get('https://enter.tochka.com/uapi/open-banking/.well-known/jwks.json', { timeout: 10000, headers }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('JWKS parse error: ' + e.message)); }
      });
    }).on('error', reject).on('timeout', function() { this.destroy(); reject(new Error('JWKS fetch timeout')); });
  });
}

// Single JWK (not a set): https://enter.tochka.com/doc/openapi/static/keys/public
// Returns {keys:[jwk]} shape so callers need no branching.
function fetchTochkaStaticKey() {
  return new Promise((resolve, reject) => {
    https.get('https://enter.tochka.com/doc/openapi/static/keys/public', { timeout: 10000 }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const jwk = JSON.parse(data);
          if (!jwk || jwk.kty !== 'RSA' || !jwk.n) return reject(new Error('static key: unexpected shape'));
          resolve({ keys: [jwk] });
        } catch (e) { reject(new Error('static key parse error: ' + e.message)); }
      });
    }).on('error', reject).on('timeout', function() { this.destroy(); reject(new Error('static key fetch timeout')); });
  });
}

// Convert JWK RSA public key to PEM format
function jwkToPem(jwk) {
  const n = base64urlDecode(jwk.n);
  const e = base64urlDecode(jwk.e);
  // Build RSA public key in DER format
  function encodeLength(len) {
    if (len < 0x80) return Buffer.from([len]);
    if (len < 0x100) return Buffer.from([0x81, len]);
    return Buffer.from([0x82, (len >> 8) & 0xff, len & 0xff]);
  }
  function encodeDerInteger(buf) {
    // Prepend 0x00 if high bit set (positive integer)
    const needsPad = buf[0] & 0x80;
    const content = needsPad ? Buffer.concat([Buffer.from([0x00]), buf]) : buf;
    return Buffer.concat([Buffer.from([0x02]), encodeLength(content.length), content]);
  }
  const nDer = encodeDerInteger(n);
  const eDer = encodeDerInteger(e);
  const rsaSeqContent = Buffer.concat([nDer, eDer]);
  const rsaSeq = Buffer.concat([Buffer.from([0x30]), encodeLength(rsaSeqContent.length), rsaSeqContent]);
  // Wrap in BIT STRING
  const bitString = Buffer.concat([Buffer.from([0x03]), encodeLength(rsaSeq.length + 1), Buffer.from([0x00]), rsaSeq]);
  // RSA OID: 1.2.840.113549.1.1.1
  const oid = Buffer.from([0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00]);
  const pubKeyContent = Buffer.concat([oid, bitString]);
  const pubKey = Buffer.concat([Buffer.from([0x30]), encodeLength(pubKeyContent.length), pubKeyContent]);
  const b64 = pubKey.toString('base64');
  const lines = b64.match(/.{1,64}/g) || [];
  return '-----BEGIN PUBLIC KEY-----\n' + lines.join('\n') + '\n-----END PUBLIC KEY-----\n';
}

// Verify JWT signature using cached JWKS
async function verifyJwtSignature(token, apiToken) {
  const header = decodeJwtHeader(token);
  const payload = decodeJwtPayload(token);
  if (!header || !payload) return { verified: false, payload: null, reason: 'invalid_jwt_format' };

  // Fetch/cache JWKS
  const now = Date.now();
  if (!tochkaJwksCache.keys || (now - tochkaJwksCache.fetchedAt) > JWKS_CACHE_TTL) {
    try {
      const jwks = await fetchTochkaJwks(apiToken);
      tochkaJwksCache = { keys: jwks.keys || [], fetchedAt: now };
      logger.info(`[Tochka JWKS] Fetched ${tochkaJwksCache.keys.length} key(s)`);
      if (!tochkaJwksCache.keys.length) logger.warn('[Tochka JWKS] response had no keys: ' + (jwks.message || jwks.error || JSON.stringify(jwks).slice(0, 160)));
    } catch (e) {
      logger.error('[Tochka JWKS] Failed to fetch keys:', e.message);
      // If we have cached keys, use them even if expired
      if (tochkaJwksCache.keys) {
        logger.warn('[Tochka JWKS] Using expired cached keys');
      } else {
        // No keys at all — log warning but still return decoded payload (graceful degradation)
        logger.warn('[Tochka JWKS] No cached keys, skipping signature verification');
        return { verified: false, payload, reason: 'jwks_unavailable' };
      }
    }
  }

  // Find matching key
  const kid = header.kid;
  const alg = header.alg || 'RS256';
  let matchingKey = kid ? tochkaJwksCache.keys.find(k => k.kid === kid) : tochkaJwksCache.keys[0];
  // Static-key fallback set is a single kid-less JWK — use it for any kid:
  // the RSA signature check below remains the real authenticity gate.
  if (!matchingKey && tochkaJwksCache.keys.length === 1 && !tochkaJwksCache.keys[0].kid) {
    matchingKey = tochkaJwksCache.keys[0];
  }

  // Tochka may rotate signing keys at any time. If kid not found in cache,
  // force-refresh the JWKS once and try again before rejecting.
  if (!matchingKey) {
    logger.warn(`[Tochka JWT] kid="${kid}" not in cache — force-refreshing JWKS`);
    try {
      const jwks = await fetchTochkaJwks(apiToken);
      tochkaJwksCache = { keys: jwks.keys || [], fetchedAt: Date.now() };
      logger.info(`[Tochka JWKS] Force-refreshed: ${tochkaJwksCache.keys.length} key(s)`);
      matchingKey = kid ? tochkaJwksCache.keys.find(k => k.kid === kid) : tochkaJwksCache.keys[0];
    } catch (e) {
      logger.error('[Tochka JWT] Force-refresh failed:', e.message);
    }
  }

  if (!matchingKey) {
    const known = tochkaJwksCache.keys.map(k => k.kid).join(', ');
    logger.warn(`[Tochka JWT] kid="${kid}" still not found after refresh. Known kids: [${known}]`);
    return { verified: false, payload, reason: 'key_not_found' };
  }

  try {
    const pem = jwkToPem(matchingKey);
    const parts = token.split('.');
    const signedData = parts[0] + '.' + parts[1];
    const signature = base64urlDecode(parts[2]);

    const algMap = { 'RS256': 'RSA-SHA256', 'RS384': 'RSA-SHA384', 'RS512': 'RSA-SHA512' };
    const cryptoAlg = algMap[alg] || 'RSA-SHA256';

    const verifier = crypto.createVerify(cryptoAlg);
    verifier.update(signedData);
    const isValid = verifier.verify(pem, signature);

    return { verified: isValid, payload, reason: isValid ? 'ok' : 'signature_invalid' };
  } catch (e) {
    logger.error('[Tochka JWT] Verification error:', e.message);
    return { verified: false, payload, reason: 'verification_error: ' + e.message };
  }
}

module.exports = {
  decodeJwtPayload,
  decodeJwtHeader,
  fetchTochkaJwks,
  jwkToPem,
  verifyJwtSignature
};
