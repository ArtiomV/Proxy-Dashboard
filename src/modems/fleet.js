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
// On top of the instantaneous offline set we expose a debounced one:
//   disconnected (отключён) — offline modems that have been unreachable for at
//                       least `disconnectedMs` (default 10 min). A brief blip
//                       (a single missed poll) is NOT "отключён" — only a modem
//                       that has stayed dark past the threshold lands in the
//                       «Модем отключен» card, which is also the moment the
//                       Telegram/bell alert fires. `disconnectedList` ⊆ `offlineList`.
//
// Inputs:
//   metaRows   [{ srv, imei, nick }]  — modem_meta rows (non-random, non-test).
//   uptime     { 'srv_imei': { last_online_check } }  — in-memory uptime_tracking.
//   liveStatus  merged.status array — live snapshot (IMEIs prefixed 'S<n>_…').
//   opts.now / opts.retentionMs / opts.disconnectedMs
function computeFleet(metaRows, uptime, liveStatus, opts) {
  opts = opts || {};
  const now = opts.now || Date.now();
  const retentionMs = opts.retentionMs || 48 * 3600 * 1000;   // 48h: online within 2 days = active fleet
  const disconnectedMs = opts.disconnectedMs != null ? opts.disconnectedMs : 10 * 60 * 1000;   // «отключён» only after 10 min dark
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

  // 2.5) Gather the two signals the glitched-to-random credit needs — WITHOUT
  //   adding randoms to the fleet map (so `total` stays random-free):
  //     upRandom[srv]    — physically-up re-enumerated modems (random nick,
  //                        IS_ONLINE=yes, real USB path present).
  //     liveUsbByKey[k]  — USB_ID of every real-nick live entry, keyed by real
  //                        imei ('srv|raw'), so an offline twin can be tested for
  //                        an empty slot ('') vs a held slot vs absent (undefined).
  const upRandom = {};
  const liveUsbByKey = {};
  for (const m of (liveStatus || [])) {
    if (!m || m._cached) continue;
    const md = m.modem_details || {}, nd = m.net_details || {};
    const srv = m._server || '';
    const nick = (md.NICK || '').trim();
    const usb = String(md.USB_ID || md.USB || '').trim();
    if (/^random/i.test(nick)) {
      if (nd.IS_ONLINE === 'yes' && usb) upRandom[srv] = (upRandom[srv] || 0) + 1;
      continue;
    }
    if (!nick) continue;
    const pim = String(md.IMEI || '');
    const raw = pim.indexOf(srv + '_') === 0 ? pim.slice(srv.length + 1) : pim;
    if (raw) liveUsbByKey[srv + '|' + raw] = usb;
  }

  const out = { total: 0, online: 0, offline: 0, byServer: {}, offlineList: [] };
  for (const [key, v] of fleet) {
    const b = out.byServer[v.srv] || (out.byServer[v.srv] = { total: 0, online: 0, offline: 0 });
    b.total++; out.total++;
    if (v.online) { b.online++; out.online++; }
    else {
      b.offline++; out.offline++;
      out.offlineList.push({ server: v.srv, key, nick: v.nick || '', lastOnline: v.lastOnline || 0 });
    }
  }
  out.offlineList.sort((a, b) => (b.lastOnline || 0) - (a.lastOnline || 0));   // most recently offline first
  // «Модем отключен»: only modems that have been dark ≥ disconnectedMs. This is
  // the list the dashboard card renders and the threshold the offline alert
  // fires at — a transient one-poll blip stays out of both.
  out.disconnectedList = out.offlineList.filter(o => o.lastOnline && (now - o.lastOnline) >= disconnectedMs);

  // ── Glitched-to-random credit ────────────────────────────────────────────
  // A modem that «сбоит» is re-enumerated by ProxySmart as a random#### port
  // (IMEI = USB path, IS_ONLINE=yes, physically UP), while its real identity
  // lingers offline with an EMPTY USB slot. That twin is not a real outage and
  // must not drop the headline count («82/83, хотя модемы стали рэндомпортами»).
  // We credit it back ONLY at the disconnected layer — total/online/offline are
  // never touched, so online+offline=total holds by construction. Three guards
  // keep a GENUINE outage from being hidden:
  //   • candidate = offline twin PRESENT in the live feed with EMPTY USB ('').
  //     A fully-dead dongle that dropped from the feed (USB undefined) is NOT a
  //     candidate → it stays counted as down and keeps alerting.
  //   • per-server gate: a server with 0 up-randoms credits nothing (the S1/S2
  //     genuinely-dead batches are untouched).
  //   • a random whose twin is only in a <10min blip is ALREADY counted working,
  //     so it must not also credit a disconnected twin. Effective randoms =
  //     max(0, upRandom − usbLessBlips); credit = min(effective, usbLessDisc).
  //   Credit the most-recently-dark disconnected twins first (a long-dead modem
  //   outranks a fresh glitch as "genuinely down").
  const usbLessBlip = {};   // srv -> count of usb-less offline twins still in <10min blip
  const usbLessDisc = {};   // srv -> [usb-less disconnected twins], most-recently-dark first
  for (const o of out.offlineList) {
    if (liveUsbByKey[o.key] !== '') continue;   // only twins present-in-feed with EMPTY usb
    if (o.lastOnline && (now - o.lastOnline) >= disconnectedMs) {
      (usbLessDisc[o.server] || (usbLessDisc[o.server] = [])).push(o);
    } else {
      usbLessBlip[o.server] = (usbLessBlip[o.server] || 0) + 1;
    }
  }
  const credited = new Set();
  for (const srv of Object.keys(usbLessDisc)) {
    const ups = upRandom[srv] || 0;
    if (!ups) continue;
    const effective = Math.max(0, ups - (usbLessBlip[srv] || 0));
    const credit = Math.min(effective, usbLessDisc[srv].length);
    for (let i = 0; i < credit; i++) credited.add(usbLessDisc[srv][i]);
  }
  if (credited.size) out.disconnectedList = out.disconnectedList.filter(o => !credited.has(o));
  out.disconnected = out.disconnectedList.length;

  // `working` is the headline «Online: X/Y» count: modems that are up OR in a
  // brief (<disconnectedMs) blip. It stays at `total` while the fleet is healthy
  // and only drops when a modem is genuinely dark >10 min — i.e. it moves in
  // lockstep with the «Модем отключен» card instead of flickering on every
  // rotation/missed-poll. `working = total − disconnected` (≥ online).
  for (const srv of Object.keys(out.byServer)) out.byServer[srv].disconnected = 0;
  for (const o of out.disconnectedList) {
    const b = out.byServer[o.server];
    if (b) b.disconnected++;
  }
  for (const srv of Object.keys(out.byServer)) {
    const b = out.byServer[srv];
    b.working = b.total - b.disconnected;
  }
  out.working = out.total - out.disconnected;
  return out;
}

// annotateTestPool(statusArr, poolKeySet) — flags live modem entries whose
// (server, nick) belongs to the simulator test pool (`is_test_pool=1` in
// modem_meta). computeFleet's roster excludes test modems from fleet totals,
// and the admin UI needs the same knowledge to (a) keep headline counters
// fleet-consistent and (b) badge test tiles so operators see WHY a tile
// isn't counted. Pure: mutates the passed entries, returns the array.
// Keys are 'server|nick' — same shape as simulatorDb.testPoolKeySet().
function annotateTestPool(statusArr, poolKeySet) {
  if (!Array.isArray(statusArr) || !poolKeySet || !poolKeySet.size) return statusArr;
  for (const m of statusArr) {
    if (!m) continue;
    const srv = m._server || '';
    const nick = ((m.modem_details && m.modem_details.NICK) || m.nick || '').trim();
    if (nick && poolKeySet.has(srv + '|' + nick)) m.isTestPool = true;
  }
  return statusArr;
}

module.exports = { computeFleet, annotateTestPool };
