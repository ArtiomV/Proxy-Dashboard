'use strict';
//
// src/jobs/top-hosts.js — periodic top-domains aggregation across all
// ProxySmart servers (DoD #1).
//
// Extracted from server.js. The aggregator hits /apix/top_hosts on each
// modem port across every server, merges into a unified domain → count
// map (plus per-portName breakdown for the admin UI), and persists the
// detail rows into the `top_hosts_detail` table for the explorer.
//
// The result is stored both in the kv_store ('top_hosts_cache') and in
// server.js's `topHostsCache` let — we accept a setter so server.js sees
// the new snapshot on its next read.

function create(deps) {
  const {
    db, logger,
    apiServers, SERVER_COUNTRIES,
    fetchApi, normalizeOperator,
    _kvSet,
    logActivity,
    setTopHostsCache,
  } = deps;

  async function aggregateTopHosts() {
    logger.info('[TopHosts] Starting aggregation...');
    const merged = {};
    const perPort = {};
    const detailRows = []; // [server_name, port_id, nick, client_name, operator, country, host, count]
    let fetchedCount = 0;
    let errorCount = 0;

    for (const server of apiServers) {
      const srvCountry = (SERVER_COUNTRIES[server.name] || {}).country || '';
      const isRO = srvCountry === 'RO';
      try {
        const [portsResult, bwResult, statusResult] = await Promise.all([
          fetchApi(server, '/apix/list_ports_json'),
          fetchApi(server, '/apix/bandwidth_report_all'),
          fetchApi(server, '/apix/show_status_json').catch(() => null)
        ]);

        const portNameMap = {};
        if (bwResult && typeof bwResult === 'object') {
          for (const [portId, b] of Object.entries(bwResult)) {
            if (b.portName) portNameMap[portId] = b.portName;
          }
        }

        // portId → {nick, operator} from status
        const portIdInfo = {};
        const statusArr = Array.isArray(statusResult) ? statusResult : [];
        let portsMap = {};
        if (portsResult && typeof portsResult === 'object' && !portsResult.raw) portsMap = portsResult;
        else if (portsResult && portsResult.raw) { try { portsMap = JSON.parse(portsResult.raw); } catch (_) { /* best-effort: error intentionally swallowed */ } }

        for (const m of statusArr) {
          const md = m.modem_details || {};
          const imei = md.IMEI || '';
          const nick = md.NICK || imei;
          const rawOp = ((m.net_details || {}).CELLOP || md.OPERATOR || '').toLowerCase().trim();
          const op = normalizeOperator(rawOp, isRO);
          const ports = portsMap[imei] || [];
          for (const p of ports) if (p.portID) portIdInfo[p.portID] = { nick, operator: op };
        }

        const portIds = [];
        for (const imei in portsMap) {
          if (imei === 'raw' || imei === '_server') continue;
          const ports = portsMap[imei];
          if (Array.isArray(ports)) ports.forEach(p => { if (p.portID) portIds.push(p.portID); });
        }
        logger.info(`[TopHosts] ${server.name}: found ${portIds.length} ports to scan`);

        for (const portId of portIds) {
          try {
            const result = await fetchApi(server, `/apix/top_hosts?arg=${encodeURIComponent(portId)}`, 15000);
            if (result && typeof result === 'object') {
              let entries = [];
              if (Array.isArray(result)) entries = result;
              else {
                for (const k in result) {
                  if (k !== 'raw' && typeof result[k] !== 'object') entries.push({ host: k, count: parseInt(result[k]) || 0 });
                }
              }

              const portName = portNameMap[portId] || '';
              const info = portIdInfo[portId] || {};
              const nick = info.nick || portId;
              const op = info.operator || '';
              const fullPortId = server.name + '_' + portId;

              entries.forEach(e => {
                const h = e.host || e.domain || 'unknown';
                const count = e.count || e.requests || 1;
                merged[h] = (merged[h] || 0) + count;
                if (portName) {
                  if (!perPort[portName]) perPort[portName] = {};
                  perPort[portName][h] = (perPort[portName][h] || 0) + count;
                }
                detailRows.push([server.name, fullPortId, nick, portName || '', op, srvCountry, h, count]);
              });
              if (entries.length > 0) fetchedCount++;
            }
          } catch (_) { errorCount++; }
        }
      } catch (e) {
        logger.error(`[TopHosts] Error on server ${server.name}:`, e.message);
        errorCount++;
      }
    }

    // Persist detailed matrix — atomic replace so queries see a consistent snapshot.
    const snapshotAt = new Date().toISOString();
    try {
      const insertDetail = db.prepare(`INSERT INTO top_hosts_detail
        (snapshot_at, server_name, port_id, nick, client_name, operator, country, host, count)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      db.transaction(() => {
        db.prepare('DELETE FROM top_hosts_detail').run();
        for (const r of detailRows) insertDetail.run(snapshotAt, r[0], r[1], r[2], r[3], r[4], r[5], r[6], r[7]);
      })();
    } catch (e) {
      logger.error('[TopHosts] Failed to persist detail rows:', e.message);
    }

    const newCache = {
      data: merged,
      perPort,
      updatedAt: snapshotAt,
      stats: { domains: Object.keys(merged).length, portsScanned: fetchedCount, errors: errorCount, detailRows: detailRows.length }
    };
    setTopHostsCache(newCache);
    _kvSet.run('top_hosts_cache', JSON.stringify(newCache));
    logger.info(`[TopHosts] Aggregation complete: ${Object.keys(merged).length} domains, ${detailRows.length} detail rows from ${fetchedCount} ports (${errorCount} errors)`);
    logActivity('system', 'info', 'top_hosts_complete', null, `Top hosts: ${Object.keys(merged).length} domains, ${detailRows.length} detail rows`, { domains: Object.keys(merged).length, detail_rows: detailRows.length, ports_scanned: fetchedCount, errors: errorCount });
    return newCache;
  }

  return { aggregateTopHosts };
}

module.exports = { create };
