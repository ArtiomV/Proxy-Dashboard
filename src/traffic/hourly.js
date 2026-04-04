'use strict';

const { parseBwToBytes, normalizeOperator } = require('../utils/traffic');

// Mutable dependencies injected via init()
let db, logger, fetchAllServersDataCached, refreshPortKeyMapping, portKeyToPortNameRef;
let hourlyDaySnapshots = {};
let preResetSnapshots = {};
let _htUpsert, _htCleanup, _metaOpGet;

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
  loadPreResetSnapshots();
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

function loadPreResetSnapshots() {
  try {
    const row = db.prepare("SELECT value FROM kv_store WHERE key = 'pre_reset_snapshots'").get();
    if (row) { preResetSnapshots = JSON.parse(row.value); logger.info(`[HourlyAgg] Restored ${Object.keys(preResetSnapshots).length} pre-reset snapshots`); }
  } catch (e) {}
}

// Capture snapshot at 23:50 MSK (20:50 UTC) — before ProxySmart resets month counters at 00:00 MSK
async function capturePreResetSnapshot() {
  try {
    const results = await fetchAllServersDataCached();
    const pnMap = portKeyToPortNameRef();
    preResetSnapshots = {};
    for (const data of results) {
      const srv = data.serverName || '';
      if (typeof data.bw !== 'object') continue;
      for (const [portId, b] of Object.entries(data.bw)) {
        const fullPortId = srv + '_' + portId;
        const monIn  = parseBwToBytes(b.bandwidth_bytes_month_in);
        const monOut = parseBwToBytes(b.bandwidth_bytes_month_out);
        preResetSnapshots[fullPortId] = { in: monIn, out: monOut };
      }
    }
    try { db.prepare("INSERT OR REPLACE INTO kv_store (key, value, updated_at) VALUES ('pre_reset_snapshots', ?, datetime('now'))").run(JSON.stringify(preResetSnapshots)); } catch(e) {}
    logger.info(`[HourlyAgg] PreResetSnapshot captured: ${Object.keys(preResetSnapshots).length} ports`);
  } catch (e) {
    logger.error('[HourlyAgg] PreResetSnapshot error:', e.message);
  }
}

async function aggregateHourlyTraffic() {
  try {
    const results = await fetchAllServersDataCached();
    const pnMap = portKeyToPortNameRef();
    if (Object.keys(pnMap).length === 0) refreshPortKeyMapping(results);
    const now = new Date();
    // UTC-safe hour calculation (Bug 2 fix)
    const nowMs = now.getTime();
    const prevHourStart = nowMs - (nowMs % 3600000) - 3600000;
    const hourStart = new Date(prevHourStart).toISOString().slice(0, 13).replace('T', ' ') + ':00';
    const todayStr = new Date(prevHourStart).toISOString().slice(0, 10);

    let count = 0;
    const batch = db.transaction(() => {
      for (const data of results) {
        const srv = data.serverName || '';
        const statusArr = Array.isArray(data.status) ? data.status : [];
        const portsMap = data.ports || {};

        const portIdInfo = {};
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
          if (modemPorts.length === 0) {
            portIdInfo['_imei_' + imei] = { nick, operator, clientName: '' };
          }
        }

        if (typeof data.bw !== 'object') continue;
        for (const [portId, b] of Object.entries(data.bw)) {
          const info = portIdInfo[portId] || {};
          const nick = info.nick || pnMap[srv + '_' + portId] || portId;
          let rawOp = (info.operator || '').toLowerCase().trim();
          if (!rawOp && nick) {
            const meta = _metaOpGet.get(srv, nick);
            if (meta && meta.operator) rawOp = meta.operator.toLowerCase().trim();
          }
          const isRO = srv === 'S2' || srv.indexOf('S2') === 0;
          const operator = normalizeOperator(rawOp, isRO);
          const clientName = info.clientName || b.portName || '';
          const fullPortId = srv + '_' + portId;
          const snapKey = fullPortId;

          const monIn  = parseBwToBytes(b.bandwidth_bytes_month_in);
          const monOut = parseBwToBytes(b.bandwidth_bytes_month_out);
          const snap = hourlyDaySnapshots[snapKey];
          if (snap) {
            const monthReset = (snap.in > 0 && monIn < snap.in * 0.1);
            if (!monthReset) {
              // Normal increment
              const incIn  = Math.max(0, monIn  - snap.in);
              const incOut = Math.max(0, monOut - snap.out);
              if (incIn + incOut > 0) {
                _htUpsert.run(srv, fullPortId, nick, operator, clientName, hourStart, incIn, incOut);
                count++;
              }
            } else {
              // Month reset detected — use pre-reset snapshot for last hour delta
              const preSnap = preResetSnapshots[snapKey];
              if (preSnap && preSnap.in >= snap.in) {
                const incIn  = Math.max(0, preSnap.in  - snap.in);
                const incOut = Math.max(0, preSnap.out - snap.out);
                if (incIn + incOut > 0) {
                  _htUpsert.run(srv, fullPortId, nick, operator, clientName, hourStart, incIn, incOut);
                  count++;
                }
              }
              // After reset: also record post-reset traffic (monIn/monOut) for the NEW hour
              // This will be picked up by the next aggregation cycle
            }
          }
          hourlyDaySnapshots[snapKey] = { in: monIn, out: monOut, date: todayStr };
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

// Refresh snapshots only — NO writes to traffic_hourly. Safe for restarts.
async function refreshSnapshotsOnly() {
  try {
    const results = await fetchAllServersDataCached();
    const now = new Date();
    const todayStr = now.toISOString().slice(0, 10);
    let updated = 0;
    for (const data of results) {
      const srv = data.serverName || '';
      if (typeof data.bw !== 'object') continue;
      for (const [portId, b] of Object.entries(data.bw)) {
        const fullPortId = srv + '_' + portId;
        const monIn  = parseBwToBytes(b.bandwidth_bytes_month_in);
        const monOut = parseBwToBytes(b.bandwidth_bytes_month_out);
        hourlyDaySnapshots[fullPortId] = { in: monIn, out: monOut, date: todayStr };
        updated++;
      }
    }
    saveHourlySnapshots();
    logger.info(`[HourlyAgg] Snapshots refreshed (no DB write): ${updated} ports`);
  } catch (e) {
    logger.error('[HourlyAgg] refreshSnapshotsOnly error:', e.message);
  }
}

function getSnapshotCount() { return Object.keys(hourlyDaySnapshots).length; }

module.exports = { init, aggregateHourlyTraffic, capturePreResetSnapshot, refreshSnapshotsOnly, saveHourlySnapshots, loadHourlySnapshots, getSnapshotCount };
