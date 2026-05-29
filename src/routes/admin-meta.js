'use strict';
//
// src/routes/admin-meta.js — admin-only metadata endpoints (Stage 17).
//
// Three families:
//
//   DELETE /api/admin/modems/:server_name/:port_id
//     Manual modem eviction. Replaces the deprecated auto-cleanup that used
//     to evict modems after `retention_stale_ports_days`. New policy:
//       "once a modem is in the DB, it stays until the admin removes it,
//        and only if it's currently OFFLINE."
//     Refuses (409) if the modem is currently visible in the live
//     ProxySmart cache for that server.
//
//   GET  /api/admin/operators
//     Lists all known operators with their country, source (auto/manual),
//     and how many modems currently carry that operator. Used by:
//       1. The new «Операторы и страны» card in Settings.
//       2. The replacement for the hardcoded operator list in admin.js
//          heatmap config (so digi and other newcomers show up automatically).
//
//   PUT  /api/admin/operators/:operator/country  body: { country }
//     Manual override. Sets source='manual'; subsequent auto detections
//     from the polling loop will NOT overwrite it.
//
//   DELETE /api/admin/operators/:operator
//     Drops the mapping entirely; next poll will re-create it as 'auto'.
//
// Routes mounted via the standard factory pattern (server.js boot).

const express = require('express');

module.exports = function createAdminMetaRouter(deps) {
  const {
    db, logger, authMiddleware, adminMiddleware,
    operatorsDb, trackingDb, knownModems, saveKnownModems,
    logActivity, fetchAllServersDataCached,
  } = deps;

  const r = express.Router();

  // ── 1) Manual modem deletion ─────────────────────────────────────────────
  r.delete('/api/admin/modems/:server_name/:port_id', authMiddleware, adminMiddleware, async (req, res) => {
    const serverName = req.params.server_name;
    const portId = req.params.port_id;
    try {
      const km = knownModems[serverName] || {};
      let entry = km[portId];
      let imei = entry ? (entry.imei || '') : '';

      // Stage 18.1: synthetic port_id (`meta_<imei>` / `recovered_<imei>`) means
      // the modem only lives in modem_meta — there's no real port-binding to look
      // up in known_modems. Extract the IMEI directly so we can purge modem_meta
      // and any stale known_modems entries for the same IMEI.
      if (!entry) {
        const m = portId.match(/^(?:meta_|recovered_)(.+)$/);
        if (m) {
          imei = m[1];
          // Synthesize a minimal entry so the rest of the flow works.
          entry = { imei, nick: '' };
        }
      }

      if (!entry) {
        return res.status(404).json({ error: 'Modem not found in known_modems', server_name: serverName, port_id: portId });
      }

      // Safety gate: refuse to delete a modem that ProxySmart is currently
      // reporting as alive on its server. The whole point of this endpoint
      // is to remove ghosts — never a working modem.
      let isLive = false;
      try {
        const allData = await fetchAllServersDataCached();
        const srvData = (allData || []).find(d => d.serverName === serverName);
        if (srvData) {
          const liveBwIds = new Set(Object.keys(srvData.bw || {}));
          if (liveBwIds.has(portId)) isLive = true;
          // Also check IMEI: maybe the port_id changed but the IMEI is still live.
          if (!isLive && imei && Array.isArray(srvData.status)) {
            for (const m of srvData.status) {
              if (m.modem_details && m.modem_details.IMEI === imei) {
                const online = m.net_details && m.net_details.IS_ONLINE === 'yes';
                if (online) { isLive = true; break; }
              }
            }
          }
        }
      } catch (e) {
        logger.warn('[admin-meta] delete: could not verify liveness — ' + e.message);
        // Fail closed: if we can't confirm offline, refuse rather than risk
        // removing a working modem.
        return res.status(503).json({ error: 'Could not verify modem status; try again', details: e.message });
      }
      if (isLive) {
        return res.status(409).json({
          error: 'modem_is_live',
          message: 'Этот модем сейчас на связи — удалить можно только отключенный.',
          server_name: serverName, port_id: portId, imei,
        });
      }

      // Stage 18: delete from BOTH known_modems AND modem_meta atomically.
      // Skipping modem_meta would let the Pass-2 fallback in injectOfflineModems
      // resurrect the modem on the very next render — defeating the whole UX
      // of the delete button.
      let metaDeleted = 0;
      try {
        const tx = db.transaction(() => {
          if (imei) {
            const r = trackingDb.metaDeleteByImeiStmt().run(serverName, imei);
            metaDeleted = r.changes;
          }
        });
        tx();
      } catch (e) {
        logger.warn('[admin-meta] modem_meta purge failed: ' + e.message);
      }
      // Delete only if the port_id really exists in known_modems (synthetic
      // ids like `meta_<imei>` won't be there — that's expected).
      if (km[portId]) delete km[portId];
      // Also evict every other portId in known_modems that points to the same
      // IMEI (defensive: if multiple bindings exist for one modem, removing
      // just one would let injectOfflineModems re-create the modem under the
      // other port_id on the next render).
      if (imei) {
        for (const [pid, info] of Object.entries(km)) {
          if (info && info.imei === imei) delete km[pid];
        }
      }
      saveKnownModems();

      logActivity('admin', 'info', 'modem_deleted', `${serverName}/${portId}`,
        `Modem manually deleted by ${req.user && req.user.login}`,
        { server_name: serverName, port_id: portId, imei, meta_deleted: metaDeleted });
      res.json({ ok: true, server_name: serverName, port_id: portId, imei, meta_deleted: metaDeleted });
    } catch (e) {
      logger.error('[admin-meta] delete modem error: ' + e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // ── 2) List operators (with usage counts) ────────────────────────────────
  r.get('/api/admin/operators', authMiddleware, adminMiddleware, (req, res) => {
    try {
      const mappings = operatorsDb.listAll();
      // Cross-join with modem_meta to expose live usage counts per operator.
      // Empty operator strings are excluded — those are unknowns, not real
      // operator entries.
      const usage = db.prepare(`
        SELECT LOWER(TRIM(operator)) as operator_norm, operator as operator_raw,
               COUNT(DISTINCT imei) as modem_count,
               GROUP_CONCAT(DISTINCT server_name) as servers
        FROM modem_meta
        WHERE operator IS NOT NULL AND TRIM(operator) != ''
        GROUP BY operator_norm
        ORDER BY modem_count DESC
      `).all();

      // Merge: every operator from modem_meta gets an entry; if it has no
      // mapping row, country/source are null so the FE can offer to set them.
      const mapByOp = {};
      for (const m of mappings) mapByOp[m.operator] = m;
      const merged = usage.map(u => {
        const m = mapByOp[u.operator_norm];
        return {
          operator: u.operator_raw,                    // display form (caller renders this)
          operator_normalized: u.operator_norm,        // join key for the PUT/DELETE endpoints
          country: m ? m.country : null,
          source: m ? m.source : null,
          modem_count: u.modem_count,
          servers: u.servers ? u.servers.split(',') : [],
          first_seen_on: m ? m.first_seen_on : null,
          updated_at: m ? m.updated_at : null,
        };
      });
      // Also surface any mapping rows that no longer have modems (so the
      // admin can clean them up).
      const orphans = mappings
        .filter(m => !merged.some(x => x.operator_normalized === m.operator))
        .map(m => ({
          operator: m.operator,
          operator_normalized: m.operator,
          country: m.country,
          source: m.source,
          modem_count: 0,
          servers: [],
          first_seen_on: m.first_seen_on,
          updated_at: m.updated_at,
        }));
      res.json({ operators: merged.concat(orphans) });
    } catch (e) {
      logger.error('[admin-meta] list operators: ' + e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // ── 3) Manual operator → country override ────────────────────────────────
  r.put('/api/admin/operators/:operator/country', authMiddleware, adminMiddleware, (req, res) => {
    try {
      const operator = req.params.operator;
      const country = String((req.body && req.body.country) || '').toUpperCase().trim();
      if (!country || !/^[A-Z]{2,3}$/.test(country)) {
        return res.status(400).json({ error: 'country must be 2-3 letter ISO code' });
      }
      operatorsDb.setManual(operator, country);
      logActivity('admin', 'info', 'operator_country_set', operator,
        `Operator → ${country} (manual) by ${req.user && req.user.login}`);
      res.json({ ok: true, operator, country, source: 'manual' });
    } catch (e) {
      logger.error('[admin-meta] set operator country: ' + e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // ── 4) Drop a mapping (next poll re-creates as 'auto') ───────────────────
  r.delete('/api/admin/operators/:operator', authMiddleware, adminMiddleware, (req, res) => {
    try {
      const operator = req.params.operator;
      operatorsDb.remove(operator);
      logActivity('admin', 'info', 'operator_country_removed', operator,
        `Operator mapping dropped by ${req.user && req.user.login}`);
      res.json({ ok: true, operator });
    } catch (e) {
      logger.error('[admin-meta] remove operator: ' + e.message);
      res.status(500).json({ error: e.message });
    }
  });

  return r;
};
