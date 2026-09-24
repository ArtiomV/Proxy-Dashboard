'use strict';
// Single "client owns modem" check for the client portal (WP2).
//
// Three divergent copies used to live in client-portal.js:
//   - reset-by-token: traffic_hourly ONLY → a brand-new client with no
//     traffic history got 403 on their OWN reset link (prod bug);
//   - rotation_log:   traffic_hourly ONLY;
//   - set_rotation:   live ports → fallback traffic_hourly.
//
// 2026-09-24 · DEEP-37/38 (FIX-SPEC §21/22): результат авторизации —
// КОНКРЕТНАЯ сущность { server, imei, nick, via }, которую и использует
// вызывающий для команды (без повторного независимого поиска по nick по
// всем серверам — duplicate-nick на S1 больше не разрешает запись на S4).
// Для МУТАЦИЙ (purpose:'mutation') историческая атрибуция traffic_hourly —
// НЕ доказательство текущего владения (годится для read-only отчётов), а
// свежая отвязка порта в live-фиде отзывает право немедленно.
//
// Priority chain (first positive wins):
//   1. live binding — port on the modem is bound to the client's portName.
//      Live + bound to ANOTHER client → hard deny; live + unbound → deny
//      для мутаций (свежая отвязка). Опциональный serverName сужает поиск.
//   2. roster — known_modems binding (lastClientSeen within 24h): survives
//      reboots and short outages when the modem drops from the live feed.
//   3. history — traffic_hourly attribution (ТОЛЬКО purpose:'read').
// Admin (portNameFilter '*') always passes.

const ROSTER_RETAIN_MS = 24 * 3600 * 1000;

async function resolveOwnedModem({ nick, serverName, portNameFilter, purpose, deps }) {
  const { fetchAllServersDataCached, knownModems, db } = deps || {};
  if (!nick || !portNameFilter) return null;
  if (portNameFilter === '*') return { server: serverName || null, imei: null, nick, via: 'admin' };
  const mutation = purpose === 'mutation';

  // 1. live binding (authoritative right now)
  try {
    const results = await fetchAllServersDataCached();
    for (const data of results || []) {
      const srv = (data && data.serverName) || '';
      if (serverName && srv !== serverName) continue;
      const statusArr = Array.isArray(data.status) ? data.status : [];
      const entry = statusArr.find(m => m.modem_details && m.modem_details.NICK === nick);
      if (!entry) continue;
      const imei = entry.modem_details.IMEI || '';
      const ports = (data.ports || {})[imei] || [];
      if (ports.some(p => p.portName === portNameFilter)) return { server: srv, imei, nick, via: 'live' };
      // Live and bound — but not to us → instant deny (a reassignment must
      // revoke the previous client's access, history notwithstanding).
      if (ports.some(p => p.portName)) return null;
      // DEEP-38: live и НЕ привязан — для мутаций отказ немедленно; история
      // и roster больше не воскрешают отозванное право.
      if (mutation) return null;
    }
  } catch (_) { /* fall through to roster/history */ }

  // 2. roster binding (24h retention — the modem may be rebooting or briefly
  //    absent from the live feed). A port the box UNBOUND >10 min ago
  //    (_missingSince — same threshold as computeClientWorking) no longer
  //    grants access: иначе отвязанный порт сохранял бы доступ к порталу
  //    до суток после удаления (тот же класс бага, что «33/33» 17.08).
  const now = Date.now();
  for (const [srv, ports] of Object.entries(knownModems || {})) {
    if (serverName && srv !== serverName) continue;
    for (const info of Object.values(ports || {})) {
      if (info && info.nick === nick && info.portName === portNameFilter) {
        if (info._missingSince && (now - info._missingSince) >= 10 * 60 * 1000) continue;
        const lcs = info.lastClientSeen != null ? info.lastClientSeen : info.lastSeen;
        const ls = typeof lcs === 'number' ? lcs : Date.parse(lcs || 0);
        if (ls && (now - ls) <= ROSTER_RETAIN_MS) {
          return { server: srv, imei: info.imei || '', nick, via: 'roster' };
        }
      }
    }
  }

  // 3. historical attribution — ТОЛЬКО read (отчёты). DEEP-38: для мутаций
  //    нужна действующая аренда/назначение, а не былая атрибуция трафика.
  if (!mutation) {
    try {
      const row = db.prepare('SELECT 1 FROM traffic_hourly WHERE nick = ? AND client_name = ? LIMIT 1')
        .get(nick, portNameFilter);
      if (row) return { server: serverName || null, imei: null, nick, via: 'history' };
    } catch (_) { /* fall through */ }
  }
  return null;
}

async function isModemOwned({ nick, serverName, portNameFilter, purpose, deps }) {
  return !!(await resolveOwnedModem({ nick, serverName, portNameFilter, purpose, deps }));
}

module.exports = { isModemOwned, resolveOwnedModem, ROSTER_RETAIN_MS };
