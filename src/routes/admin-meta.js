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
//   GET  /api/admin/known_modems
//     Лёгкий список известных модемов {server, nick, operator, address} —
//     кормит чекбокс-пикеры админки (настройка speedtest_modems).
//
// Routes mounted via the standard factory pattern (server.js boot).

const express = require('express');

module.exports = function createAdminMetaRouter(deps) {
  const {
    db, logger, authMiddleware, adminMiddleware,
    operatorsDb, trackingDb, knownModems, saveKnownModems,
    logActivity, fetchAllServersDataCached, markModemDeleted, markModemRestored,
    apiServers,
  } = deps;

  const r = express.Router();

  // ── 1) Manual modem deletion ─────────────────────────────────────────────
  r.delete('/api/admin/modems/:server_name/:port_id', authMiddleware, adminMiddleware, async (req, res) => {
    const serverName = req.params.server_name;
    const portId = req.params.port_id;
    try {
      // Resolve the modem's identity from any available source:
      //   - a live known_modems entry (real port_id), OR
      //   - the synthetic meta_/recovered_<imei> port_id used for offline modems
      //     (the imei is encoded in the id even when no live binding exists), OR
      //   - the nick passed by the UI (?nick=...) — the robust fallback that lets
      //     us purge blank-imei `recovered_*` entries.
      // markModemDeleted() performs the FULL cross-layer purge (modem_meta flag +
      // in-memory set + known_modems eviction by imei/nick/synthetic-id + 10s
      // cache invalidation), so there is nothing left here that could re-surface
      // the modem on the next /api/admin/data.
      const km = knownModems[serverName] || {};
      const entry = km[portId] || null;
      let imei = entry ? (entry.imei || '') : '';
      if (!imei) {
        const m = portId.match(/^(?:meta_|recovered_)(.+)$/);
        if (m) imei = m[1];
      }
      const nick = (req.query && req.query.nick) ? String(req.query.nick) : (entry ? (entry.nick || '') : '');
      if (!imei && !nick) {
        return res.status(404).json({ error: 'Cannot identify modem (no imei/nick)', server_name: serverName, port_id: portId });
      }

      let metaDeleted = 0;
      try {
        if (typeof markModemDeleted === 'function') metaDeleted = markModemDeleted(serverName, imei, nick);
      } catch (e) {
        logger.warn('[admin-meta] modem purge failed: ' + e.message);
      }

      logActivity('admin', 'info', 'modem_deleted', `${serverName}/${portId}`,
        `Modem deleted by ${req.user && req.user.login}`,
        { server_name: serverName, port_id: portId, imei, nick, meta_deleted: metaDeleted });
      res.json({ ok: true, server_name: serverName, port_id: portId, imei, nick, meta_deleted: metaDeleted });
    } catch (e) {
      logger.error('[admin-meta] delete modem error: ' + e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // ── 1b) Restore a soft-deleted modem ─────────────────────────────────────
  // Manual INSTANT restore. Deleted modems also auto-restore after
  // modem_restore_online_polls consecutive online polls (_autoRestoreIfStable
  // in src/services/modems.js) — this route is for bringing one back without
  // waiting. Clears modem_meta.deleted AND drops the IMEI from the in-memory
  // _deletedModemSet (via markModemRestored), so the very next poll re-surfaces it.
  r.post('/api/admin/modems/:server_name/:imei/restore', authMiddleware, adminMiddleware, (req, res) => {
    const serverName = req.params.server_name;
    const imei = req.params.imei;
    try {
      const changes = (typeof markModemRestored === 'function') ? markModemRestored(serverName, imei, req.query && req.query.nick) : 0;
      logActivity('admin', 'info', 'modem_restored', `${serverName}/${imei}`,
        `Modem un-deleted by ${req.user && req.user.login}`, { server_name: serverName, imei, changes });
      res.json({ ok: true, server_name: serverName, imei, restored: changes });
    } catch (e) {
      logger.error('[admin-meta] restore modem error: ' + e.message);
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

  // ── 5) Список известных модемов для UI-выбора (speedtest_modems и т.п.) ───
  // Лёгкий GET: липкий ростер known_modems + последний оператор из modem_meta.
  // Soft-deleted (modem_meta.deleted=1) не отдаём — их оператор удалил явно.
  r.get('/api/admin/known_modems', authMiddleware, adminMiddleware, (req, res) => {
    try {
      const opByKey = {}, deleted = new Set();
      for (const row of db.prepare(
        "SELECT server_name, imei, operator, deleted FROM modem_meta WHERE imei IS NOT NULL AND imei != ''"
      ).all()) {
        const k = row.server_name + '|' + row.imei;
        if (row.deleted) { deleted.add(k); continue; }
        if (row.operator && String(row.operator).trim()) opByKey[k] = row.operator;
      }
      const addrBySrv = {};
      for (const s of (apiServers || [])) addrBySrv[s.name] = s.address || '';
      const items = [];
      const seenNick = new Set();   // 21.08: на S1 у части модемов по 2 порта
      // на один IMEI — пикер показывал ник дважды. Дедуп по сервер+ник:
      // предпочитаем запись с IMEI/оператором.
      for (const [srvName, km] of Object.entries(knownModems || {})) {
        for (const info of Object.values(km || {})) {
          if (!info || !info.nick) continue;
          const imei = info.imei || '';
          if (imei && deleted.has(srvName + '|' + imei)) continue;
          const nk = srvName + '|' + info.nick;
          if (seenNick.has(nk)) {
            const prev = items.find(x => x.server === srvName && x.nick === info.nick);
            if (prev && !prev.operator && imei && opByKey[srvName + '|' + imei]) prev.operator = opByKey[srvName + '|' + imei];
            continue;
          }
          seenNick.add(nk);
          items.push({
            server: srvName,
            nick: info.nick,
            operator: (imei && opByKey[srvName + '|' + imei]) || '',
            address: addrBySrv[srvName] || '',
          });
        }
      }
      items.sort((a, b) => a.server === b.server
        ? String(a.nick).localeCompare(String(b.nick), undefined, { numeric: true })
        : String(a.server).localeCompare(String(b.server)));
      res.json({ items });
    } catch (e) {
      logger.error('[admin-meta] known_modems: ' + e.message);
      res.status(500).json({ error: e.message });
    }
  });

  return r;
};
