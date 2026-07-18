'use strict';
// Single "client owns modem" check for the client portal (WP2).
//
// Three divergent copies used to live in client-portal.js:
//   - reset-by-token: traffic_hourly ONLY → a brand-new client with no
//     traffic history got 403 on their OWN reset link (prod bug);
//   - rotation_log:   traffic_hourly ONLY;
//   - set_rotation:   live ports → fallback traffic_hourly.
//
// One priority chain now (first positive wins):
//   1. live binding — a port on the modem (nick → IMEI in the live snapshot)
//      is bound to the client's portName. If the modem is live and bound to
//      a DIFFERENT client → hard deny (reassignment must revoke instantly).
//   2. roster — known_modems binding (lastClientSeen within 24h): survives
//      reboots and short outages when the modem drops from the live feed.
//   3. history — traffic_hourly attribution (long-term fallback).
// Admin (portNameFilter '*') always passes.

const ROSTER_RETAIN_MS = 24 * 3600 * 1000;

async function isModemOwned({ nick, portNameFilter, deps }) {
  const { fetchAllServersDataCached, mergeServerData, knownModems, db } = deps || {};
  if (!nick || !portNameFilter) return false;
  if (portNameFilter === '*') return true;

  // 1. live binding (authoritative right now)
  try {
    const results = await fetchAllServersDataCached();
    const merged = mergeServerData(results, '*');
    const entry = ((merged && merged.status) || []).find(
      m => m.modem_details && m.modem_details.NICK === nick);
    if (entry) {
      const ports = ((merged && merged.ports) || {})[entry.modem_details.IMEI] || [];
      if (ports.some(p => p.portName === portNameFilter)) return true;
      // Live and bound — but not to us → instant deny (a reassignment must
      // revoke the previous client's access, history notwithstanding).
      if (ports.some(p => p.portName)) return false;
    }
  } catch (_) { /* fall through to roster/history */ }

  // 2. roster binding (24h retention — the modem may be rebooting or briefly
  //    absent from the live feed)
  const now = Date.now();
  for (const ports of Object.values(knownModems || {})) {
    for (const info of Object.values(ports || {})) {
      if (info && info.nick === nick && info.portName === portNameFilter) {
        const lcs = info.lastClientSeen != null ? info.lastClientSeen : info.lastSeen;
        const ls = typeof lcs === 'number' ? lcs : Date.parse(lcs || 0);
        if (ls && (now - ls) <= ROSTER_RETAIN_MS) return true;
      }
    }
  }

  // 3. historical attribution
  try {
    const row = db.prepare('SELECT 1 FROM traffic_hourly WHERE nick = ? AND client_name = ? LIMIT 1')
      .get(nick, portNameFilter);
    if (row) return true;
  } catch (_) { /* fall through */ }
  return false;
}

module.exports = { isModemOwned, ROSTER_RETAIN_MS };
