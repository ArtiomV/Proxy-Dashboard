'use strict';

const { parseBwToBytes, normalizeOperator } = require('../utils/traffic');

// Mutable dependencies injected via init()
let db, logger, fetchAllServersDataCached, refreshPortKeyMapping, portKeyToPortNameRef;
let hourlyDaySnapshots = {};
let _htUpsert, _htCleanup, _metaOpGet;

/**
 * Inject mutable dependencies. Must be called once after DB + statements are ready.
 *
 * @param {Object} deps
 * @param {import('better-sqlite3').Database} deps.db
 * @param {Object} deps.logger
 * @param {Function} deps.fetchAllServersDataCached
 * @param {Function} deps.refreshPortKeyMapping
 * @param {Function} deps.getPortKeyToPortName  - returns current portKeyToPortName map
 * @param {import('better-sqlite3').Statement} deps._htUpsert
 * @param {import('better-sqlite3').Statement} deps._htCleanup
 * @param {import('better-sqlite3').Statement} deps._metaOpGet
 */
function init(deps) {
  db = deps.db;
  logger = deps.logger;
  fetchAllServersDataCached = deps.fetchAllServersDataCached;
  refreshPortKeyMapping = deps.refreshPortKeyMapping;
  portKeyToPortNameRef = deps.getPortKeyToPortName;
  _htUpsert = deps._htUpsert;
  _htCleanup = deps._htCleanup;
  _metaOpGet = deps._metaOpGet;

  loadHourlySnapshots();
}

// Persist snapshots to SQLite so they survive server restarts
function saveHourlySnapshots() {
  try { db.prepare("INSERT OR REPLACE INTO kv_store (key, value, updated_at) VALUES ('hourly_day_snapshots', ?, datetime('now'))").run(JSON.stringify(hourlyDaySnapshots)); } catch (e) {}
}

function loadHourlySnapshots() {
  try {
    const row = db.prepare("SELECT value FROM kv_store WHERE key = 'hourly_day_snapshots'").get();
    if (row) { hourlyDaySnapshots = JSON.parse(row.value); logger.info(`[HourlyAgg] Restored ${Object.keys(hourlyDaySnapshots).length} snapshots from DB`); }
  } catch (e) { logger.error('[HourlyAgg] Failed to load snapshots:', e.message); }
}

async function aggregateHourlyTraffic() {
  try {
    const results = await fetchAllServersDataCached();
    const pnMap = portKeyToPortNameRef();
    if (Object.keys(pnMap).length === 0) refreshPortKeyMapping(results);
    const now = new Date();
    const todayStr = now.toISOString().slice(0, 10);
    const prevH = new Date(now);
    prevH.setHours(prevH.getHours() - 1, 0, 0, 0);
    const hourStart = prevH.toISOString().slice(0, 13).replace('T', ' ') + ':00';

    let count = 0;
    const batch = db.transaction(() => {
      for (const data of results) {
        const srv = data.serverName || '';
        const statusArr = Array.isArray(data.status) ? data.status : [];
        const portsMap = data.ports || {}; // { IMEI: [{ portID, portName }] }

        // Build portID -> { nick, operator, clientName } from status + ports
        const portIdInfo = {}; // { portID: { nick, operator, clientName } }
        for (const m of statusArr) {
          const md = m.modem_details || {};
          const imei = md.IMEI || '';
          const nick = md.NICK || imei;
          const nd = m.net_details || {};
          const operator = nd.CELLOP || md.OPERATOR || '';
          if (!imei) continue;
          const modemPorts = portsMap[imei] || [];
          for (const p of modemPorts) {
            portIdInfo[p.portID] = { nick, operator, clientName: p.portName || '' };
          }
          // If no ports found, still track by IMEI
          if (modemPorts.length === 0) {
            portIdInfo['_imei_' + imei] = { nick, operator, clientName: '' };
          }
        }

        if (typeof data.bw !== 'object') continue;
        for (const [portId, b] of Object.entries(data.bw)) {
          // Look up nick/operator via portID -> status cross-reference
          const info = portIdInfo[portId] || {};
          const nick = info.nick || pnMap[srv + '_' + portId] || portId;
          // Normalize operator: lowercase CELLOP + server context -> canonical name
          let rawOp = (info.operator || '').toLowerCase().trim();
          // Fallback: if API returned no operator, check modem_meta DB
          if (!rawOp && nick) {
            const meta = _metaOpGet.get(srv, nick);
            if (meta && meta.operator) rawOp = meta.operator.toLowerCase().trim();
          }
          const isRO = srv === 'S2' || srv.indexOf('S2') === 0;
          const operator = normalizeOperator(rawOp, isRO);
          const clientName = info.clientName || b.portName || '';
          // Use srv_portId as snapshot and DB key (unique across servers)
          const fullPortId = srv + '_' + portId;
          const snapKey = fullPortId;

          const dayIn  = parseBwToBytes(b.bandwidth_bytes_day_in);
          const dayOut = parseBwToBytes(b.bandwidth_bytes_day_out);
          const snap = hourlyDaySnapshots[snapKey];
          // Record hourly increment if snapshot exists (snap.date check prevents cross-day bogus data)
          if (snap) {
            if (snap.date === todayStr) {
              const incIn  = Math.max(0, dayIn  - snap.in);
              const incOut = Math.max(0, dayOut - snap.out);
              if (incIn + incOut > 0) {
                _htUpsert.run(srv, fullPortId, nick, operator, clientName, hourStart, incIn, incOut);
                count++;
              }
            } else {
              if (dayIn + dayOut > 0) {
                _htUpsert.run(srv, fullPortId, nick, operator, clientName, hourStart, dayIn, dayOut);
                count++;
              }
            }
          }
          hourlyDaySnapshots[snapKey] = { in: dayIn, out: dayOut, date: todayStr };
        }
      }
      _htCleanup.run();
    });
    batch();
    saveHourlySnapshots();
    logger.info(`[HourlyAgg] Stored ${hourStart}, ${count} modem entries, ${Object.keys(hourlyDaySnapshots).length} tracked`);
  } catch (e) {
    logger.error('[HourlyAgg] Error:', e.message);
  }
}

function getSnapshotCount() { return Object.keys(hourlyDaySnapshots).length; }

module.exports = { init, aggregateHourlyTraffic, saveHourlySnapshots, loadHourlySnapshots, getSnapshotCount };
