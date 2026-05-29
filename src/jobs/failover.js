'use strict';

/**
 * Modem failover engine (Stage 19).
 *
 * When a client's modem dies or glitches, re-point that client's port to a
 * healthy spare modem on the SAME server, so the client keeps service.
 *
 * Mechanism — Variant A («port teleport»): ProxySmart binds a proxy port to
 * a modem by IMEI. We GET the port's edit_port form, swap `IMEI` to the
 * spare's, POST it back, then `apply_port`. portID / TCP-port / login /
 * password are preserved → the client's connection string keeps working
 * (only the external IP changes — new modem = new SIM). This mirrors the
 * manual /api/admin/move_port route exactly.
 *
 * Triggers (periodic scan, every few minutes):
 *   - hard_offline: client modem offline ≥ failover_offline_min (this also
 *     captures the recovery_exhausted case — 3 USB-resets take ~9 min, so a
 *     still-dead modem crosses the 15-min default shortly after).
 *   - glitch_errors: client modem online but error% ≥ failover_error_pct
 *     across the last failover_error_window_min minutes.
 *
 * Safeguards: global enable flag (OFF by default), dry-run mode (ON by
 * default — logs «would move» without touching prod), per-modem cooldown,
 * per-server rate limit, spare-availability check. No auto-revert (a
 * recovered modem just becomes a spare again — avoids flapping).
 */

let deps = null;
const _lastFailoverByImei = {};   // imei → ts of last real failover off this modem
const _rateWindow = [];           // sliding window of recent real-move timestamps (per all servers)
let _interval = null;
let _scanning = false;            // P0-3: re-entrancy guard for scanAndFailover
const _movingImeis = new Set();   // P1-4: per-modem lock (serialize auto + manual)

// Spares we've JUST teleported a client port onto. The live snapshot is cached
// (fetchAllServersDataCached) and ProxySmart takes a moment to reflect a new
// binding, so a spare can still look "free" for the next scan/event — that's how
// two client ports landed on RO2_30 (events 3s apart both picked it). Exclude a
// spare from selection for a guard window after we use it, until the snapshot
// catches up. Keyed by RAW imei → ts.
const _recentlyAssignedSpares = {};
const SPARE_REUSE_GUARD_MS = 15 * 60 * 1000;   // 15 min ≫ cache TTL + propagation
function _markSpareUsed(rawImei) { if (rawImei) _recentlyAssignedSpares[rawImei] = Date.now(); }
function _isSpareGuarded(rawImei) {
  const t = _recentlyAssignedSpares[rawImei];
  if (!t) return false;
  if (Date.now() - t >= SPARE_REUSE_GUARD_MS) { delete _recentlyAssignedSpares[rawImei]; return false; }
  return true;
}

function init(d) {
  deps = d;
  // First scan 90s after boot (let live state settle), then every 3 min.
  setTimeout(scanAndFailover, 90 * 1000);
  _interval = setInterval(scanAndFailover, 3 * 60 * 1000);
  return { stop };
}
function stop() { if (_interval) { clearInterval(_interval); _interval = null; } }

// ── config helpers ──────────────────────────────────────────────
function _num(key, dflt) {
  const v = Number(deps.appSettings[key]);
  return (Number.isFinite(v) && v > 0) ? v : dflt;
}
function isEnabled() { return deps.appSettings.failover_enabled === true || deps.appSettings.failover_enabled === 1; }
// dry-run defaults ON: only an explicit false/0 turns it off.
function isDryRun()  { return !(deps.appSettings.failover_dry_run === false || deps.appSettings.failover_dry_run === 0); }

// ── modem enumeration per server ────────────────────────────────
// Returns [{ imei, nick, bound, online, clientPorts:[{portId,portName}], uptimeRatio }]
function _enumerate(serverName) {
  const km = deps.knownModems[serverName] || {};
  const byImei = {};
  for (const [portId, info] of Object.entries(km)) {
    if (!info || !info.imei) continue;
    const imei = info.imei;
    if (!byImei[imei]) byImei[imei] = { imei, nick: info.nick || imei, bound: false, clientPorts: [] };
    const pn = (info.portName || '').trim();
    if (pn) { byImei[imei].bound = true; byImei[imei].clientPorts.push({ portId, portName: pn }); }
  }
  const now = Date.now();
  for (const m of Object.values(byImei)) {
    const ut = deps.uptimeTracking[serverName + '_' + m.imei] || {};
    const lastMs = ut.last_online_check ? Date.parse(ut.last_online_check) : 0;
    m.lastOnlineMs = isNaN(lastMs) ? 0 : lastMs;
    m.online = m.lastOnlineMs > 0 && (now - m.lastOnlineMs) < 6 * 60 * 1000;  // seen within 2 tracking cycles
    m.uptimeRatio = ut.total_checks ? (ut.online_checks || 0) / ut.total_checks : 0;
  }
  return Object.values(byImei);
}

// ── spare selection ─────────────────────────────────────────────
// CRITICAL: spares must come from LIVE ProxySmart data, NOT known_modems.
// known_modems is the durable port→IMEI registry — it only contains modems
// that have a port created. A genuinely free modem (no port, or a port with
// empty portName) often isn't in known_modems at all, yet it's the ideal
// failover target. So we enumerate from the live status+ports snapshot
// (same source the Модемы table uses): a spare = a modem ProxySmart reports
// ONLINE that is NOT the IMEI of any client-bound port.
// Use the MERGED snapshot (mergeServerData) — the exact same data the Модемы
// table renders. Merged data: cleans «randomport*» placeholders to empty
// portName, includes every modem ProxySmart reports (not just ones with a
// real port row), and prefixes IMEIs as S<n>_<imei>. This is what the raw
// per-server fetch (fetchAllServersDataCached) does NOT give us — that's why
// the first cut saw 0 spares on S2 even though RO2_13 / RO2_30 were free.
async function _getMerged() {
  try {
    const all = await deps.fetchAllServersDataCached();
    return deps.mergeServerData(all, '*');
  } catch (_) { return { status: [], ports: {} }; }
}
// Spare list for one server from a pre-fetched MERGED snapshot.
function _sparesFromData(serverName, merged, excludeImeis) {
  const exclude = excludeImeis instanceof Set ? excludeImeis : new Set(excludeImeis || []);
  if (!merged) return [];
  const status = Array.isArray(merged.status) ? merged.status : [];
  const ports = merged.ports || {};
  const stale = (typeof deps.getStaleNicks === 'function') ? deps.getStaleNicks() : new Set();
  const prefix = serverName + '_';
  // Prefixed IMEIs currently serving a client (port with non-empty portName).
  const bound = new Set();
  for (const pImei of Object.keys(ports)) {
    if (!pImei.startsWith(prefix)) continue;
    (ports[pImei] || []).forEach(p => { if ((p.portName || '').trim()) bound.add(pImei); });
  }
  const out = [];
  for (const s of status) {
    if (s._server !== serverName) continue;
    const pImei = s.modem_details && s.modem_details.IMEI;   // prefixed
    if (!pImei || bound.has(pImei)) continue;
    const rawImei = pImei.slice(prefix.length);
    if (exclude.has(rawImei)) continue;
    if (_isSpareGuarded(rawImei)) continue;   // just used as a target — let the snapshot catch up
    const isOnline = s.net_details && s.net_details.IS_ONLINE === 'yes';
    if (!isOnline) continue;
    const nick = (s.modem_details.NICK || '').trim() || rawImei;
    if (stale.has(nick)) continue;
    const ut = deps.uptimeTracking[prefix + rawImei] || {};
    out.push({ imei: rawImei, nick, uptimeRatio: ut.total_checks ? (ut.online_checks || 0) / ut.total_checks : 1 });
  }
  out.sort((a, b) => b.uptimeRatio - a.uptimeRatio);  // most-stable first
  return out;
}
function findSpareFrom(serverName, merged, excludeImeis) {
  const s = _sparesFromData(serverName, merged, excludeImeis);
  return s.length ? s[0] : null;
}
// Async convenience wrapper (used by tests + ad-hoc callers).
async function findSpare(serverName, excludeImeis) {
  return findSpareFrom(serverName, await _getMerged(), excludeImeis);
}

// ── glitch detection: N CONSECUTIVE failed checks ───────────────
// Why not error% over a time window? Proxy checks run only ~every 20 min, so any
// windowed percentage is a 2–4 sample reading — a single transient blip reads as
// 33–50% and tripped the old threshold. Backtesting the real log: 5 of 6 glitch
// moves (83%) were false positives. Instead we require the last N checks to ALL
// be failures (a sustained outage, not noise) and the most recent to be fresh.
// `total_ms > badMs` (unusably slow) counts as a failure too — a modem that
// answers but takes >badMs is effectively dead for the client. Returns
// { fails, latencyOnly } or null.
function _consecutiveFailGlitch(serverName, nick, needFails, badMs) {
  try {
    const n = Math.max(2, parseInt(needFails, 10) || 3);
    const rows = deps.db.prepare(
      `SELECT error, total_ms, checked_at FROM proxy_checks
       WHERE server_name = ? AND nick = ? ORDER BY checked_at DESC LIMIT ?`
    ).all(serverName, nick, n);
    if (rows.length < n) return null;                       // not enough samples yet
    const latestMs = Date.parse(rows[0].checked_at);
    if (isNaN(latestMs) || Date.now() - latestMs > 90 * 60 * 1000) return null;  // stale → ignore
    const isBad = r => (r.error != null) || (badMs > 0 && r.total_ms != null && r.total_ms > badMs);
    if (!rows.every(isBad)) return null;
    const hardErrors = rows.every(r => r.error != null);
    return { fails: n, latencyOnly: !hardErrors };
  } catch (_) { return null; }
}

// ── the actual port teleport (mirrors /api/admin/move_port) ─────
async function _movePort(server, portId, newImei) {
  const raw = await deps.fetchApiRaw(server, `/conf/edit_port/${portId}`);
  const html = raw && raw.buffer ? raw.buffer.toString('utf8') : '';
  const formData = deps.parseHtmlInputFields(html);
  if (!formData.proxy_password) {
    try {
      const portsData = await deps.fetchApi(server, '/apix/list_ports_json');
      for (const [, plist] of Object.entries(portsData)) {
        for (const port of plist) {
          if (port.portID === portId && port.PASSWORD) { formData.proxy_password = port.PASSWORD; break; }
        }
        if (formData.proxy_password) break;
      }
    } catch (_) { /* best-effort */ }
  }
  formData.IMEI = newImei;                       // ← the teleport
  await deps.postFormApi(server, `/conf/edit_port/${portId}`, formData);
  try { await deps.fetchApi(server, `/apix/apply_port?arg=${encodeURIComponent(portId)}`); }
  catch (e) { deps.logger.warn(`[Failover] apply_port ${portId}: ${e.message}`); }
}

// ── audit log ───────────────────────────────────────────────────
let _insertLog = null;
function _record(o) {
  try {
    if (!_insertLog) {
      _insertLog = deps.db.prepare(`INSERT INTO failover_log
        (server_name, client_port_name, dead_imei, dead_nick, dead_port_id,
         spare_imei, spare_nick, mode, trigger_reason, result, error, dry_run)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
    }
    _insertLog.run(
      o.server || '', o.clientPortName || '', o.deadImei || '', o.deadNick || '',
      o.deadPortId || '', o.spareImei || '', o.spareNick || '', 'A',
      o.reason || '', o.result || '', o.error || '', o.dry ? 1 : 0
    );
  } catch (e) { deps.logger.warn('[Failover] record: ' + e.message); }
}

function _ratePrune() {
  const cutoff = Date.now() - 3600 * 1000;
  while (_rateWindow.length && _rateWindow[0] < cutoff) _rateWindow.shift();
}

// ── core: failover all client ports off a dead/glitchy modem ───
// manual=true bypasses enable/dry-run/cooldown/rate gates.
async function failoverModem(dead, reason, opts) {
  opts = opts || {};
  const manual = !!opts.manual;
  const server = deps.findServer(dead.server);
  if (!server) return { ok: false, error: 'server not found' };

  // What client ports does the dead modem currently carry?
  const km = deps.knownModems[dead.server] || {};
  const deadPorts = [];
  for (const [portId, info] of Object.entries(km)) {
    if (info && info.imei === dead.imei && (info.portName || '').trim()) {
      deadPorts.push({ portId, portName: info.portName.trim() });
    }
  }
  if (!deadPorts.length) return { ok: false, error: 'no client ports on this modem' };

  // P1-4: serialize auto + manual failover per modem. A manual trigger bypasses
  // the auto gates and could otherwise run concurrently with the periodic scan
  // on the same IMEI → the same port moved twice / a lost move.
  if (_movingImeis.has(dead.imei)) return { ok: false, error: 'already moving' };
  _movingImeis.add(dead.imei);
  try {
  if (!manual) {
    if (!isEnabled()) return { ok: false, error: 'failover disabled' };
    const cdMs = _num('failover_cooldown_h', 6) * 3600 * 1000;
    if (_lastFailoverByImei[dead.imei] && Date.now() - _lastFailoverByImei[dead.imei] < cdMs) {
      return { ok: false, error: 'cooldown' };
    }
    _ratePrune();
    if (_rateWindow.length >= _num('failover_max_per_hour', 5)) {
      _record({ server: dead.server, deadImei: dead.imei, deadNick: dead.nick, deadPortId: '*', reason, result: 'skipped_rate' });
      try { deps.alerts.trigger('failover_failed', { server: dead.server, client: deadPorts[0].portName, error: 'превышен лимит переносов в час' }); } catch (_) {}
      return { ok: false, error: 'rate limit' };
    }
  }

  const allData = opts.allData || await _getMerged();
  // usedSpares is shared across all dead modems in one scan pass (seeded by the
  // caller) so two dead modems can't grab the same spare from the same cached
  // snapshot. Always include this dead modem's own imei.
  const usedSpares = opts.usedSpares || new Set();
  usedSpares.add(dead.imei);
  const results = [];
  for (const dp of deadPorts) {
    const spare = findSpareFrom(dead.server, allData, usedSpares);
    if (!spare) {
      _record({ server: dead.server, clientPortName: dp.portName, deadImei: dead.imei, deadNick: dead.nick, deadPortId: dp.portId, reason, result: 'skipped_no_spare' });
      try { deps.alerts.trigger('failover_no_spare', { server: dead.server, client: dp.portName, nick: dead.nick }); } catch (_) {}
      results.push({ portId: dp.portId, client: dp.portName, result: 'no_spare' });
      continue;
    }
    // Dry-run (auto only): log intent, no mutation.
    if (!manual && isDryRun()) {
      _record({ server: dead.server, clientPortName: dp.portName, deadImei: dead.imei, deadNick: dead.nick, deadPortId: dp.portId, spareImei: spare.imei, spareNick: spare.nick, reason, result: 'dry_run', dry: 1 });
      deps.logger.info(`[Failover] DRY-RUN: would move ${dp.portName} (${dp.portId}) ${dead.nick}→${spare.nick} on ${dead.server} [${reason}]`);
      usedSpares.add(spare.imei);
      results.push({ portId: dp.portId, client: dp.portName, result: 'dry_run', spare: spare.nick });
      continue;
    }
    // Execute the teleport.
    try {
      await _movePort(server, dp.portId, spare.imei);
      _lastFailoverByImei[dead.imei] = Date.now();
      _rateWindow.push(Date.now());
      usedSpares.add(spare.imei);
      _markSpareUsed(spare.imei);   // cross-pass guard: don't reuse until snapshot reflects the binding
      _record({ server: dead.server, clientPortName: dp.portName, deadImei: dead.imei, deadNick: dead.nick, deadPortId: dp.portId, spareImei: spare.imei, spareNick: spare.nick, reason, result: 'ok' });
      deps.logActivity('recovery', 'warn', 'failover', dead.nick, `Порт ${dp.portName} перенесён ${dead.nick}→${spare.nick} (${reason})`, { server: dead.server, portId: dp.portId, spare: spare.nick, reason });
      try { deps.alerts.trigger('failover_done', { server: dead.server, client: dp.portName, deadNick: dead.nick, spareNick: spare.nick, reason }); } catch (_) {}
      results.push({ portId: dp.portId, client: dp.portName, result: 'ok', spare: spare.nick });
    } catch (e) {
      _record({ server: dead.server, clientPortName: dp.portName, deadImei: dead.imei, deadNick: dead.nick, deadPortId: dp.portId, spareImei: spare.imei, spareNick: spare.nick, reason, result: 'failed', error: e.message });
      try { deps.alerts.trigger('failover_failed', { server: dead.server, client: dp.portName, error: e.message }); } catch (_) {}
      results.push({ portId: dp.portId, client: dp.portName, result: 'failed', error: e.message });
    }
  }
  try { deps.proxySmart.invalidateCache(); } catch (_) {}
  return { ok: true, results };
  } finally {
    _movingImeis.delete(dead.imei);
  }
}

// ── periodic scan: evaluate every client modem against triggers ─
async function scanAndFailover() {
  if (!deps) return;
  if (!isEnabled()) return;   // master switch off → do nothing at all
  // P0-3: a scan does live API calls + sequential port moves and can run longer
  // than the 3-min tick. Without this guard the next tick would start a SECOND
  // concurrent scan — two passes could both pass a modem's cooldown check before
  // either updates it (check-then-act race) and move the same port twice.
  if (_scanning) { deps.logger.warn('[Failover] previous scan still running — skip tick'); return; }
  _scanning = true;
  try {
    const now = Date.now();
    const offlineMs   = _num('failover_offline_min', 15) * 60 * 1000;
    const glitchFails = _num('failover_glitch_fails', 3);
    const badMs       = _num('proxy_check_bad_ms', 3000);
    const stale     = (typeof deps.getStaleNicks === 'function') ? deps.getStaleNicks() : new Set();
    const allData   = await _getMerged();   // one live snapshot for the whole pass
    // ONE shared used-spares set for the whole pass — the cached snapshot won't
    // reflect a binding made earlier in the same pass, so without this two dead
    // modems would pick the same spare (this is how RO2_30 got two ports).
    const usedSpares = new Set();

    for (const server of (deps.apiServers || [])) {
      const mods = _enumerate(server.name).filter(m => m.bound);   // only client modems
      for (const m of mods) {
        // Trigger 1 — hard offline (and not yet stale-removed; stale = already
        // long-dead, operator-deletion territory, leave it).
        const downMs = m.lastOnlineMs ? (now - m.lastOnlineMs) : Infinity;
        const hardOffline = !m.online && m.lastOnlineMs > 0 && downMs >= offlineMs && !stale.has(m.nick);
        if (hardOffline) {
          await failoverModem({ server: server.name, imei: m.imei, nick: m.nick }, 'hard_offline', { allData, usedSpares });
          continue;
        }
        // Trigger 2 — glitch: N consecutive failed/too-slow checks (online).
        if (m.online) {
          const g = _consecutiveFailGlitch(server.name, m.nick, glitchFails, badMs);
          if (g) {
            await failoverModem({ server: server.name, imei: m.imei, nick: m.nick }, 'glitch_errors', { allData, usedSpares });
          }
        }
      }
    }
  } catch (e) {
    deps.logger.warn('[Failover] scan error: ' + e.message);
  } finally {
    _scanning = false;
  }
}

// ── manual trigger (route) ──────────────────────────────────────
// failover a specific modem now, bypassing the auto gates.
async function manualFailover(serverName, imei, nick) {
  return failoverModem({ server: serverName, imei, nick }, 'manual', { manual: true });
}

// ── dry preview for the UI — what the scan WOULD act on now ────
async function previewCandidates() {
  const out = [];
  const now = Date.now();
  const offlineMs   = _num('failover_offline_min', 15) * 60 * 1000;
  const glitchFails = _num('failover_glitch_fails', 3);
  const badMs       = _num('proxy_check_bad_ms', 3000);
  const stale     = (typeof deps.getStaleNicks === 'function') ? deps.getStaleNicks() : new Set();
  const allData   = await _getMerged();
  // Simulate the real scan: spares are consumed one-by-one, so a spare assigned
  // to an earlier candidate must NOT be offered to a later one — otherwise the
  // preview shows (and the buttons invite) two modems → one spare (double-book).
  const usedSpares = new Set();
  for (const server of (deps.apiServers || [])) {
    const mods = _enumerate(server.name).filter(m => m.bound);
    for (const m of mods) {
      let reason = null, detail = '';
      const downMs = m.lastOnlineMs ? (now - m.lastOnlineMs) : Infinity;
      if (!m.online && m.lastOnlineMs > 0 && downMs >= offlineMs && !stale.has(m.nick)) {
        reason = 'hard_offline'; detail = Math.round(downMs / 60000) + ' мин offline';
      } else if (m.online) {
        const g = _consecutiveFailGlitch(server.name, m.nick, glitchFails, badMs);
        if (g) { reason = 'glitch_errors'; detail = g.fails + (g.latencyOnly ? ' медленных проверок подряд' : ' ошибок подряд'); }
      }
      if (!reason) continue;
      const spare = findSpareFrom(server.name, allData, new Set([m.imei, ...usedSpares]));
      if (spare) usedSpares.add(spare.imei);
      out.push({
        server: server.name, nick: m.nick, imei: m.imei,
        clients: m.clientPorts.map(p => p.portName),
        reason, detail,
        spare: spare ? spare.nick : null,
      });
    }
  }
  return out;
}

// ── spare list for the UI ──────────────────────────────────────
async function listSpares(serverName) {
  const allData = await _getMerged();
  return _sparesFromData(serverName, allData, new Set())
    .map(m => ({ imei: m.imei, nick: m.nick, uptimePct: Math.round(m.uptimeRatio * 100) }));
}

module.exports = { init, scanAndFailover, failoverModem, manualFailover, findSpare, listSpares, previewCandidates, _consecutiveFailGlitch };
