'use strict';

const { parseBwToBytes, normalizeOperator } = require('../utils/traffic');

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

// Б3 fix: temp object + merge by max, never clear before fetch
async function capturePreResetSnapshot() {
  try {
    const results = await fetchAllServersDataCached();
    const newSnapshots = {};
    for (const data of results) {
      const srv = data.serverName || '';
      if (typeof data.bw !== 'object') continue;
      for (const [portId, b] of Object.entries(data.bw)) {
        const fullPortId = srv + '_' + portId;
        const monIn  = parseBwToBytes(b.bandwidth_bytes_month_in);
        const monOut = parseBwToBytes(b.bandwidth_bytes_month_out);
        if (monIn > 0 || monOut > 0) {
          newSnapshots[fullPortId] = { in: monIn, out: monOut, capturedAt: Date.now() };
        }
      }
    }
    // Merge: keep max per port (Б3)
    let merged = 0;
    for (const [key, val] of Object.entries(newSnapshots)) {
      if (!preResetSnapshots[key] || preResetSnapshots[key].in < val.in) {
        preResetSnapshots[key] = val;
        merged++;
      }
    }
    try { db.prepare("INSERT OR REPLACE INTO kv_store (key, value, updated_at) VALUES ('pre_reset_snapshots', ?, datetime('now'))").run(JSON.stringify(preResetSnapshots)); } catch(e) {}
    logger.info(`[HourlyAgg] PreResetSnapshot merged: ${merged} ports (total ${Object.keys(preResetSnapshots).length})`);
  } catch (e) {
    // Б3: preResetSnapshots NOT cleared on error
    logger.error('[HourlyAgg] PreResetSnapshot error:', e.message);
  }
}

// Б2 fix: don't overwrite snap with zero for offline modems
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
        if (monIn > 0 || monOut > 0) {
          hourlyDaySnapshots[fullPortId] = { in: monIn, out: monOut, date: todayStr };
          updated++;
        } else if (!hourlyDaySnapshots[fullPortId]) {
          // New port with no data yet — mark as pending baseline
          hourlyDaySnapshots[fullPortId] = { in: 0, out: 0, date: todayStr, pending: true };
        }
        // If snap exists and monIn=0 — keep old snap (Б2: don't overwrite with zero)
      }
    }
    saveHourlySnapshots();
    logger.info(`[HourlyAgg] Snapshots refreshed (no DB write): ${updated} ports`);
  } catch (e) {
    logger.error('[HourlyAgg] refreshSnapshotsOnly error:', e.message);
  }
}

async function aggregateHourlyTraffic() {
  try {
    const results = await fetchAllServersDataCached();
    const pnMap = portKeyToPortNameRef();
    if (Object.keys(pnMap).length === 0) refreshPortKeyMapping(results);
    const now = new Date();
    const nowMs = now.getTime();
    const prevHourStart = nowMs - (nowMs % 3600000) - 3600000;
    const hourStart = new Date(prevHourStart).toISOString().slice(0, 13).replace('T', ' ') + ':00';
    const todayStr = new Date(prevHourStart).toISOString().slice(0, 10);

    let count = 0;
    const MAX_HOURLY_BYTES = 2 * 1073741824; // 2 GB sanity cap per modem

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

          // Б2: skip pending baseline snaps (first seen, no real data yet)
          if (snap && snap.pending) {
            if (monIn > 0 || monOut > 0) {
              hourlyDaySnapshots[snapKey] = { in: monIn, out: monOut, date: todayStr };
            }
            continue;
          }

          if (snap) {
            const monthReset = (snap.in > 0 && monIn < snap.in * 0.1);
            if (!monthReset) {
              // Normal increment
              const incIn  = Math.max(0, monIn  - snap.in);
              const incOut = Math.max(0, monOut - snap.out);
              // Sanity cap (prevents stale snap anomalies)
              if (incIn + incOut > 0 && incIn + incOut < MAX_HOURLY_BYTES) {
                _htUpsert.run(srv, fullPortId, nick, operator, clientName, hourStart, incIn, incOut);
                count++;
              }
            } else {
              // Б5: monthReset — use preSnap for last hour delta
              const preSnap = preResetSnapshots[snapKey];
              const preSnapAge = preSnap && preSnap.capturedAt ? (Date.now() - preSnap.capturedAt) / 3600000 : Infinity;
              if (preSnap && preSnap.in > 0 && preSnapAge < 4) {
                const incIn  = Math.max(0, preSnap.in  - snap.in);
                const incOut = Math.max(0, preSnap.out - snap.out);
                if (incIn + incOut > 0 && incIn + incOut < MAX_HOURLY_BYTES) {
                  _htUpsert.run(srv, fullPortId, nick, operator, clientName, hourStart, incIn, incOut);
                  count++;
                }
              } else {
                logger.warn(`[HourlyAgg] monthReset: no valid preSnap for ${nick} (age=${preSnapAge.toFixed(1)}h)`);
              }
              // Б5: ALWAYS update snap to post-reset value, then continue
              hourlyDaySnapshots[snapKey] = { in: monIn, out: monOut, date: todayStr };
              continue; // skip default snap update below
            }
          }

          // Default snap update (only if monIn > 0, Б2)
          if (monIn > 0 || monOut > 0) {
            hourlyDaySnapshots[snapKey] = { in: monIn, out: monOut, date: todayStr };
          } else if (!snap) {
            hourlyDaySnapshots[snapKey] = { in: 0, out: 0, date: todayStr, pending: true };
          }
          // If snap exists and monIn=0 — keep old snap (Б2)
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

module.exports = { init, aggregateHourlyTraffic, capturePreResetSnapshot, refreshSnapshotsOnly, saveHourlySnapshots, loadHourlySnapshots, getSnapshotCount };
