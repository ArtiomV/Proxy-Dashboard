'use strict';

// One coherent modem-fleet count. Replaces the old tangle where the numerator
// (online) came from the inflated live `_modemMap` while the denominator
// (active) came from modem_meta — two sources that could disagree (e.g. 85/82).
//
// Three numbers that ALWAYS satisfy  online + offline = total  and  online ≤ total:
//   total (активные)  — distinct non-random modems seen ONLINE within
//                       `retentionMs` (durable uptime history), PLUS any modem
//                       online in the live snapshot right now. A server being
//                       unreachable *now* does not drop its modems (they were
//                       online recently), so the denominator stays steady; a
//                       re-add phantom that was never really online is excluded.
//   online (онлайн)   — fleet modems reported IS_ONLINE=yes in the live snapshot.
//   offline (отключено) — total − online.
//
// Inputs:
//   metaRows   [{ srv, imei, nick }]  — modem_meta rows (non-random, non-test).
//   uptime     { 'srv_imei': { last_online_check } }  — in-memory uptime_tracking.
//   liveStatus  merged.status array — live snapshot (IMEIs prefixed 'S<n>_…').
//   opts.now / opts.retentionMs
function computeFleet(metaRows, uptime, liveStatus, opts) {
  opts = opts || {};
  const now = opts.now || Date.now();
  const retentionMs = opts.retentionMs || 48 * 3600 * 1000;   // 48h: online within 2 days = active fleet
  const fleet = new Map();   // 'srv|imei' -> { srv, online }

  // 1) Durable membership: modems online within the retention window.
  for (const r of (metaRows || [])) {
    if (!r || !r.imei || !r.srv) continue;
    const nick = String(r.nick || '').trim();
    if (!nick || /^random/i.test(nick)) continue;   // defensive (the SQL already excludes these)
    const ut = uptime ? uptime[r.srv + '_' + r.imei] : null;
    const lo = (ut && ut.last_online_check) ? Date.parse(ut.last_online_check) : 0;
    if (lo && (now - lo) <= retentionMs) fleet.set(r.srv + '|' + r.imei, { srv: r.srv, nick, online: false, lastOnline: lo });
  }

  // 2) Current online from the live snapshot — and union in any online modem not
  //    already a member, so `online` is always a subset of the fleet.
  for (const m of (liveStatus || [])) {
    if (!m || m._cached) continue;
    const md = m.modem_details || {}, nd = m.net_details || {};
    const nick = (md.NICK || '').trim();
    if (!nick || /^random/i.test(nick)) continue;
    if (nd.IS_ONLINE !== 'yes') continue;
    const srv = m._server || '';
    const pim = String(md.IMEI || '');
    const raw = pim.indexOf(srv + '_') === 0 ? pim.slice(srv.length + 1) : pim;
    if (!raw) continue;
    const key = srv + '|' + raw;
    if (fleet.has(key)) fleet.get(key).online = true;
    else fleet.set(key, { srv, nick, online: true });
  }

  const out = { total: 0, online: 0, offline: 0, byServer: {}, offlineList: [] };
  for (const v of fleet.values()) {
    const b = out.byServer[v.srv] || (out.byServer[v.srv] = { total: 0, online: 0, offline: 0 });
    b.total++; out.total++;
    if (v.online) { b.online++; out.online++; }
    else {
      b.offline++; out.offline++;
      out.offlineList.push({ server: v.srv, nick: v.nick || '', lastOnline: v.lastOnline || 0 });
    }
  }
  out.offlineList.sort((a, b) => (b.lastOnline || 0) - (a.lastOnline || 0));   // most recently offline first
  return out;
}

module.exports = { computeFleet };
