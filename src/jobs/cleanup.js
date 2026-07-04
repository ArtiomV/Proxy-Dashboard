'use strict';
//
// src/jobs/cleanup.js — retention cleanup + stale port mapping cleanup.
//
// Extracted from server.js (Stage 4 finish / DoD #1 progress).
// Two functions:
//
//   runRetentionCleanup() — deletes old rows from time-bounded tables per
//     `appSettings.retention_*` overrides. Also prunes in-memory
//     ipTracking / uptimeTracking / modemRotationCache maps so they don't
//     grow unbounded as modems churn.
//
//   cleanupStalePortMappings() — removes daily_traffic rows + known_modems
//     entries for port_ids that disappeared from live ProxySmart >N days
//     ago. Was originally a manual fix on 2026-05-04 (WildBox-style ghost
//     port issue) — now automated so the issue can't recur silently.
//
// Both functions receive everything they need via a `deps` factory call;
// no module-level state escapes. The factory pattern matches the route
// extraction style (server.js owns let bindings, deps are passed by ref
// or via getters for the few rebound globals).

function create(deps) {
  const {
    db, logger, fs,
    SERVER_CACHE_FILE,
    appSettings,
    dailyTraffic, ipTracking, uptimeTracking, modemRotationCache,
    knownModems,
    saveKnownModems,
    logActivity,
  } = deps;

  function cleanupStalePortMappings() {
    try {
      const rawDays = appSettings.retention_stale_ports_days;
      // Default 3 days: a disconnected modem stays visible as offline for ~3
      // days, then its known_modems entry is dropped so the row disappears.
      // Minimum 1 day to allow tighter behavior if needed.
      const days = Number.isInteger(rawDays) && rawDays >= 1 ? rawDays : 3;
      const cutoffDate = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
      const cutoffMs   = Date.now() - days * 86400000;

      // Build set of CURRENTLY LIVE port_ids from server_cache.json.
      // Only trust servers whose cache is fresh (≤30 min old) — for unreachable
      // servers we have no authoritative info on what's still live, so skip them.
      let serverCache = {};
      try {
        serverCache = JSON.parse(fs.readFileSync(SERVER_CACHE_FILE, 'utf-8'));
      } catch (_) { return { skipped: 'no_cache' }; }

      const FRESHNESS_MS = 30 * 60 * 1000;
      const liveIds = new Set();
      const skippedSrv = [];
      for (const [srvName, entry] of Object.entries(serverCache)) {
        if (!entry || !entry.bw) continue;
        const age = Date.now() - (entry.cachedAt || 0);
        if (age > FRESHNESS_MS) { skippedSrv.push(srvName); continue; }
        for (const pid of Object.keys(entry.bw)) liveIds.add(srvName + '_' + pid);
      }
      if (liveIds.size === 0) {
        return { skipped: 'no_fresh_servers', skippedSrv };
      }

      // 1. daily_traffic table: stale port_ids whose latest activity < cutoff.
      const stale = db.prepare(`
        SELECT port_name FROM daily_traffic
        GROUP BY port_name HAVING MAX(date) < ?
      `).all(cutoffDate);
      let dtDeleted = 0;
      if (stale.length) {
        const stmt = db.prepare('DELETE FROM daily_traffic WHERE port_name = ?');
        const tx = db.transaction(() => {
          for (const r of stale) {
            if (liveIds.has(r.port_name)) continue;     // still live → keep
            dtDeleted += stmt.run(r.port_name).changes;
          }
        });
        tx();
      }

      // 2. In-memory dailyTraffic: drop matching keys.
      let dtMemKeys = 0;
      for (const k of Object.keys(dailyTraffic)) {
        if (liveIds.has(k)) continue;
        const dates = Object.keys(dailyTraffic[k]);
        const lastDate = dates.length ? dates.sort().slice(-1)[0] : '';
        if (lastDate && lastDate < cutoffDate) {
          delete dailyTraffic[k];
          dtMemKeys++;
        }
      }

      // 3. known_modems.json: remove entries with stale lastSeen, only on
      //    servers that ARE fresh (skipped servers untouched).
      //    Also handle "IMEI reassigned": if the same IMEI has multiple km
      //    entries (modem was moved between clients/ports), keep only the
      //    newest by lastSeen and remove older ones that are not in live bw.
      let kmRemoved = 0, kmChanged = false;

      // Build per-IMEI index globally across all (fresh) servers.
      const byImei = {};   // imei -> [{srv, pid, lastSeen}]
      for (const srvName of Object.keys(knownModems || {})) {
        if (skippedSrv.includes(srvName)) continue;
        const km = knownModems[srvName];
        for (const [pid, info] of Object.entries(km)) {
          if (!info.imei) continue;
          if (!byImei[info.imei]) byImei[info.imei] = [];
          byImei[info.imei].push({ srv: srvName, pid, lastSeen: info.lastSeen || 0 });
        }
      }
      // Build live-IMEI set per server (modem currently visible in ProxySmart status,
      // regardless of whether its port is in bw — could be a default/random port).
      const liveImeisByServer = {};
      for (const srvName of Object.keys(serverCache)) {
        if (skippedSrv.includes(srvName)) continue;
        liveImeisByServer[srvName] = new Set();
        const stArr = Array.isArray(serverCache[srvName].status) ? serverCache[srvName].status : [];
        for (const m of stArr) {
          const imei = m.modem_details && m.modem_details.IMEI;
          if (imei) liveImeisByServer[srvName].add(imei);
        }
      }
      // Pass A: IMEI-dedup — newer wins (modem reassigned to different port).
      for (const list of Object.values(byImei)) {
        if (list.length < 2) continue;
        list.sort((a, b) => b.lastSeen - a.lastSeen);
        for (let i = 1; i < list.length; i++) {
          const old = list[i];
          if (liveIds.has(old.srv + '_' + old.pid)) continue;
          delete knownModems[old.srv][old.pid];
          kmRemoved++; kmChanged = true;
        }
      }
      // Pass B was removed in Stage 17 by user policy:
      // "Если однажды модем попал в базу — он должен там быть, пока я его
      //  вручную не удалю. Удалить можно только отключенный модем."
      // The old logic auto-evicted modems whose lastSeen was older than
      // retention_stale_ports_days (default 3). That hid disconnected
      // modems without operator awareness — replaced by:
      //   - UI badge «потерян N мин назад» in the modem row
      //   - explicit DELETE /api/admin/modems/:server/:port_id endpoint
      //     (server-side guard ensures only offline modems are deletable)
      // `cutoffMs`/`cutoffDate` are still computed above because they're
      // used by daily_traffic retention (Pass A/C use their own predicates).
      void cutoffMs;
      // Pass C: port deleted but IMEI still online (modem moved to a different port,
      // typically an auto-generated "randomport*" default after we removed the named
      // port). The stale km entry would otherwise misattribute the modem to a former
      // client. Detect by: port not in live bw AND IMEI is currently online on the
      // same server — the bind is no longer authoritative.
      for (const srvName of Object.keys(knownModems || {})) {
        if (skippedSrv.includes(srvName)) continue;
        const liveImeis = liveImeisByServer[srvName] || new Set();
        const km = knownModems[srvName];
        for (const pid of Object.keys(km)) {
          if (liveIds.has(srvName + '_' + pid)) continue;        // port still live
          const imei = km[pid].imei;
          if (!imei) continue;
          if (!liveImeis.has(imei)) continue;                    // modem also offline → keep (will be injected as ghost)
          // Modem is online but on a different port → old assignment is stale
          delete km[pid];
          kmRemoved++; kmChanged = true;
        }
      }
      if (kmChanged) saveKnownModems();

      if (dtDeleted || dtMemKeys || kmRemoved) {
        logger.info(`[Retention] Stale port cleanup: daily_traffic=${dtDeleted} rows, dailyTraffic=${dtMemKeys} keys, known_modems=${kmRemoved} entries (threshold ${days}d)`);
        logActivity('system', 'info', 'stale_port_cleanup', null,
          `Cleaned ${dtDeleted} daily_traffic rows, ${dtMemKeys} memory keys, ${kmRemoved} known_modems entries`,
          { days, dtDeleted, dtMemKeys, kmRemoved, skippedSrv });
      }
      return { dtDeleted, dtMemKeys, kmRemoved, skippedSrv, days };
    } catch (e) {
      logger.error('[Retention] stale port cleanup error: ' + e.message);
      return { error: e.message };
    }
  }

  function runRetentionCleanup() {
    const retentions = {
      traffic_hourly: { col: 'hour_start', key: 'retention_traffic_hourly', def: 90 },
      modem_meta:     { col: 'updated_at', key: 'retention_modem_meta', def: 30 },
      rotation_log:   { col: 'started_at', key: 'retention_rotation_log', def: 30 }, // grows ~25k/day; 30d default keeps it manageable
      proxy_checks:   { col: 'checked_at', key: 'retention_proxy_checks', def: 30 },
      audit_log:      { col: 'timestamp',  key: 'retention_audit_log', def: 90 },
      system_log:     { col: 'timestamp',  key: 'retention_system_log', def: 30 },
      api_usage:      { col: 'timestamp',  key: 'retention_api_usage', def: 30 },
      api_access_log: { col: 'ts',         key: 'retention_api_access_log', def: 30 },
      // DB-level audit (triggers): keep 365 days by default — financial forensics
      db_audit:         { col: 'ts', key: 'retention_db_audit', def: 365 },
      db_audit_context: { col: 'ts', key: 'retention_db_audit', def: 365 },
      // Auto-reboot log — 90 days
      auto_reboot_log:  { col: 'rebooted_at', key: 'retention_auto_reboot', def: 90 },
      // Simulator runs — 30 days; CASCADE on simulator_samples handles the rest.
      simulator_runs:   { col: 'started_at', key: 'retention_simulator_runs', def: 30 },
    };
    const results = {};
    for (const [table, { col, key, def }] of Object.entries(retentions)) {
      const raw = appSettings[key];
      const days = Number.isInteger(raw) && raw >= 7 ? raw : def;
      // P2-4: `table` and `col` come ONLY from the hardcoded `retentions` map
      // above — never from user input — so identifier interpolation is safe
      // (SQLite can't bind identifiers). `days` is coerced to a positive int and
      // passed as a bound parameter (not interpolated) as defence-in-depth, so
      // this pattern stays safe if it's ever copied somewhere with a dynamic value.
      const safeDays = Math.max(1, Number(days) | 0);
      results[table] = db.prepare(
        `DELETE FROM ${table} WHERE ${col} < datetime('now', '-' || ? || ' days')`
      ).run(safeDays);
    }
    // In-memory dailyTraffic cleanup (mirrors daily_traffic table retention)
    try {
      const rawDt = appSettings.retention_daily_traffic;
      const dtDays = Number.isInteger(rawDt) && rawDt >= 7 ? rawDt : 90;
      const cutoff = new Date(Date.now() - dtDays * 86400000).toISOString().slice(0, 10);
      let removedDays = 0, removedKeys = 0;
      for (const [key, days] of Object.entries(dailyTraffic)) {
        for (const date of Object.keys(days)) {
          if (date < cutoff) { delete days[date]; removedDays++; }
        }
        if (!Object.keys(days).length) { delete dailyTraffic[key]; removedKeys++; }
      }
      // Also prune the daily_traffic table to stay in sync with memory
      const dbRes = db.prepare('DELETE FROM daily_traffic WHERE date < ?').run(cutoff);
      results.daily_traffic_memory = { changes: removedDays, removedKeys };
      results.daily_traffic = dbRes;
    } catch (e) {
      logger.error('[Retention] dailyTraffic cleanup error:', e.message);
    }
    // Stale port mapping cleanup (delegates to the other function in this module)
    results.stale_ports = cleanupStalePortMappings();
    // Prune in-memory tracking maps so they don't grow forever as modems churn.
    // ipTracking/uptimeTracking/modemRotationCache key on serverName+IMEI; entries
    // for IMEIs not seen in live data for >30 days are dead weight.
    try {
      const liveImeis = new Set();
      try {
        const cache = JSON.parse(fs.readFileSync(SERVER_CACHE_FILE, 'utf8'));
        for (const srv of Object.keys(cache || {})) {
          const status = Array.isArray(cache[srv].status) ? cache[srv].status : [];
          for (const m of status) {
            const imei = m.modem_details && m.modem_details.IMEI;
            if (imei) liveImeis.add(srv + '_' + imei);
          }
        }
      } catch (_) { /* best-effort: error intentionally swallowed */ }
      let ipPruned = 0, upPruned = 0, rotPruned = 0;
      if (liveImeis.size > 0) {
        for (const k of Object.keys(ipTracking)) if (!liveImeis.has(k)) { delete ipTracking[k]; ipPruned++; }
        for (const k of Object.keys(uptimeTracking)) if (!liveImeis.has(k)) { delete uptimeTracking[k]; upPruned++; }
        for (const k of Object.keys(modemRotationCache)) {
          // modemRotationCache keys are `serverName:imei` — different prefix style
          const [srv, imei] = k.split(':');
          if (srv && imei && !liveImeis.has(srv + '_' + imei)) { delete modemRotationCache[k]; rotPruned++; }
        }
      }
      results.tracking_pruned = { ipTracking: ipPruned, uptimeTracking: upPruned, modemRotationCache: rotPruned };
    } catch (e) {
      logger.warn('[Retention] tracking-map pruning error: ' + e.message);
    }
    return results;
  }

  return { runRetentionCleanup, cleanupStalePortMappings };
}

module.exports = { create };
