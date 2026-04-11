'use strict';

const { parseBwToBytes, normalizeOperator } = require('../utils/traffic');

let db, logger, fetchAllServersDataCached, refreshPortKeyMapping, portKeyToPortNameRef;
let _htUpsert, _htCleanup, _metaOpGet, _snapUpsert, _snapGet, _snapGetAll;
let SERVER_COUNTRIES = {};

// In-memory cache of hourly_snapshots table (port_id → row)
const snapCache = new Map();

function init(deps) {
  db = deps.db;
  logger = deps.logger;
  fetchAllServersDataCached = deps.fetchAllServersDataCached;
  refreshPortKeyMapping = deps.refreshPortKeyMapping;
  portKeyToPortNameRef = deps.getPortKeyToPortName;
  _htUpsert = deps._htUpsert;
  _htCleanup = deps._htCleanup;
  _metaOpGet = deps._metaOpGet;
  _snapUpsert = deps._snapUpsert;
  _snapGet = deps._snapGet;
  _snapGetAll = deps._snapGetAll;
  SERVER_COUNTRIES = deps.SERVER_COUNTRIES || {};

  // Migrate old kv_store snapshots → hourly_snapshots table (one-time)
  migrateSnapshotsToTable();

  // Load all snapshots into memory
  loadSnapCache();
}

function loadSnapCache() {
  try {
    const rows = _snapGetAll.all();
    snapCache.clear();
    for (const r of rows) snapCache.set(r.port_id, r);
    logger.info(`[HourlyAgg] Loaded ${snapCache.size} snapshots from hourly_snapshots table`);
  } catch (e) {
    logger.error('[HourlyAgg] Failed to load snap cache:', e.message);
  }
}

function migrateSnapshotsToTable() {
  try {
    const existing = db.prepare('SELECT COUNT(*) as c FROM hourly_snapshots').get();
    if (existing.c > 0) return; // already migrated

    const row = db.prepare("SELECT value FROM kv_store WHERE key = 'hourly_day_snapshots'").get();
    if (!row) return;

    const old = JSON.parse(row.value);
    const stmt = db.prepare(`INSERT OR IGNORE INTO hourly_snapshots
      (port_id, day_in, day_out, month_in, month_out, pending, captured_at)
      VALUES (?, ?, ?, ?, ?, 0, datetime('now'))`);

    const tx = db.transaction(() => {
      for (const [portId, snap] of Object.entries(old)) {
        // Old snapshots stored month counters in 'in'/'out' fields
        // Use them as both day and month initial values
        stmt.run(portId, snap.in || 0, snap.out || 0, snap.in || 0, snap.out || 0);
      }
    });
    tx();
    logger.info(`[HourlyAgg] Migrated ${Object.keys(old).length} snapshots to hourly_snapshots table`);
  } catch (e) {
    logger.error('[HourlyAgg] Migration error:', e.message);
  }
}

function upsertSnap(portId, fields) {
  _snapUpsert.run(
    portId,
    fields.day_in || 0, fields.day_out || 0,
    fields.month_in || 0, fields.month_out || 0,
    fields.yesterday_in || 0, fields.yesterday_out || 0,
    fields.prev_month_in || 0, fields.prev_month_out || 0,
    fields.day_at_last_hour_start_in || 0, fields.day_at_last_hour_start_out || 0,
    fields.mon_at_last_hour_start_in || 0, fields.mon_at_last_hour_start_out || 0,
    fields.pending || 0
  );
  // Update in-memory cache
  snapCache.set(portId, { port_id: portId, ...fields });
}

// Startup: refresh snapshots from live data WITHOUT writing to traffic_hourly
async function refreshSnapshotsOnly() {
  try {
    const results = await fetchAllServersDataCached();
    let updated = 0;
    const tx = db.transaction(() => {
      for (const data of results) {
        const srv = data.serverName || '';
        if (typeof data.bw !== 'object') continue;
        for (const [portId, b] of Object.entries(data.bw)) {
          const fullPortId = srv + '_' + portId;
          const dayIn  = parseBwToBytes(b.bandwidth_bytes_day_in);
          const dayOut = parseBwToBytes(b.bandwidth_bytes_day_out);
          const monIn  = parseBwToBytes(b.bandwidth_bytes_month_in);
          const monOut = parseBwToBytes(b.bandwidth_bytes_month_out);
          const yesIn  = parseBwToBytes(b.bandwidth_bytes_yesterday_in);
          const yesOut = parseBwToBytes(b.bandwidth_bytes_yesterday_out);
          const pmIn   = parseBwToBytes(b.bandwidth_bytes_prev_month_in);
          const pmOut  = parseBwToBytes(b.bandwidth_bytes_prev_month_out);

          const snap = snapCache.get(fullPortId);

          if (dayIn > 0 || dayOut > 0 || monIn > 0 || monOut > 0) {
            // BUG-FIX: preserve day_in/month_in baseline from previous snapshot
            // so the next aggregation computes delta from where it left off.
            // Previously day_in was overwritten with live counter, losing traffic
            // between last aggregation and restart.
            upsertSnap(fullPortId, {
              day_in: snap ? snap.day_in : dayIn,
              day_out: snap ? snap.day_out : dayOut,
              month_in: snap ? snap.month_in : monIn,
              month_out: snap ? snap.month_out : monOut,
              yesterday_in: yesIn, yesterday_out: yesOut,
              prev_month_in: pmIn, prev_month_out: pmOut,
              day_at_last_hour_start_in: snap ? snap.day_at_last_hour_start_in : dayIn,
              day_at_last_hour_start_out: snap ? snap.day_at_last_hour_start_out : dayOut,
              mon_at_last_hour_start_in: snap ? snap.mon_at_last_hour_start_in : monIn,
              mon_at_last_hour_start_out: snap ? snap.mon_at_last_hour_start_out : monOut,
              pending: 0,
            });
            updated++;
          } else if (!snap) {
            upsertSnap(fullPortId, {
              day_in: 0, day_out: 0, month_in: 0, month_out: 0,
              yesterday_in: 0, yesterday_out: 0, prev_month_in: 0, prev_month_out: 0,
              day_at_last_hour_start_in: 0, day_at_last_hour_start_out: 0,
              mon_at_last_hour_start_in: 0, mon_at_last_hour_start_out: 0,
              pending: 1,
            });
          }
          // If snap exists and all counters = 0 → keep old snap (offline modem)
        }
      }
    });
    tx();
    logger.info(`[HourlyAgg] Snapshots refreshed (no traffic_hourly write): ${updated} ports`);
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

    let count = 0;
    let uncertainCount = 0;
    const MAX_HOURLY_BYTES = 2 * 1073741824; // 2 GB sanity cap per modem
    const UNCERTAIN_THRESHOLD = 50 * 1048576; // 50 MB minimum for uncertain flag

    const batch = db.transaction(() => {
      for (const data of results) {
        const srv = data.serverName || '';
        const srvCountry = (SERVER_COUNTRIES[srv] || {}).country || '';
        const isRO = srvCountry === 'RO';

        // Build portId → modem info map
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
          const operator = normalizeOperator(rawOp, isRO);
          const clientName = info.clientName || b.portName || '';
          const fullPortId = srv + '_' + portId;

          // Read all 8 counters
          const dayIn   = parseBwToBytes(b.bandwidth_bytes_day_in);
          const dayOut  = parseBwToBytes(b.bandwidth_bytes_day_out);
          const monIn   = parseBwToBytes(b.bandwidth_bytes_month_in);
          const monOut  = parseBwToBytes(b.bandwidth_bytes_month_out);
          const yesIn   = parseBwToBytes(b.bandwidth_bytes_yesterday_in);
          const yesOut  = parseBwToBytes(b.bandwidth_bytes_yesterday_out);
          const pmIn    = parseBwToBytes(b.bandwidth_bytes_prev_month_in);
          const pmOut   = parseBwToBytes(b.bandwidth_bytes_prev_month_out);

          const snap = snapCache.get(fullPortId);

          // --- 1. No snapshot → baseline ---
          if (!snap) {
            upsertSnap(fullPortId, {
              day_in: dayIn, day_out: dayOut,
              month_in: monIn, month_out: monOut,
              yesterday_in: yesIn, yesterday_out: yesOut,
              prev_month_in: pmIn, prev_month_out: pmOut,
              day_at_last_hour_start_in: dayIn, day_at_last_hour_start_out: dayOut,
              mon_at_last_hour_start_in: monIn, mon_at_last_hour_start_out: monOut,
              pending: (dayIn > 0 || monIn > 0) ? 0 : 1,
            });
            continue;
          }

          // --- 2. Pending baseline → wait for real data ---
          if (snap.pending) {
            if (dayIn > 0 || dayOut > 0 || monIn > 0 || monOut > 0) {
              upsertSnap(fullPortId, {
                ...snap,
                day_in: dayIn, day_out: dayOut,
                month_in: monIn, month_out: monOut,
                yesterday_in: yesIn, yesterday_out: yesOut,
                prev_month_in: pmIn, prev_month_out: pmOut,
                day_at_last_hour_start_in: dayIn, day_at_last_hour_start_out: dayOut,
                mon_at_last_hour_start_in: monIn, mon_at_last_hour_start_out: monOut,
                pending: 0,
              });
            }
            continue;
          }

          // --- 3. Day reset detection ---
          // Primary: day counter dropped significantly below day_at_last_hour_start (counter reset)
          // Secondary: yesterday changed (classic detector)
          const dayDropped = snap.day_at_last_hour_start_in > 0
                          && dayIn < snap.day_at_last_hour_start_in * 0.5
                          && yesIn > 0;
          const yesterdayChanged = yesIn > snap.day_in
                                && yesIn !== snap.yesterday_in;
          const dayReset = dayDropped || yesterdayChanged;

          if (dayReset) {
            // Last hour of the day: yesterday_total - day_at_last_hour_start
            const incIn  = Math.max(0, yesIn  - snap.day_at_last_hour_start_in);
            const incOut = Math.max(0, yesOut - snap.day_at_last_hour_start_out);
            if (incIn + incOut > 0 && incIn + incOut < MAX_HOURLY_BYTES) {
              _htUpsert.run(srv, fullPortId, nick, operator, clientName, hourStart, incIn, incOut, 0);
              count++;
            }
            // BUG-FIX: set day baseline to 0 so next aggregation captures ALL
            // post-midnight traffic via delta (dayIn - 0 = dayIn).
            // Previously day_in was set to dayIn, making that traffic invisible.
            upsertSnap(fullPortId, {
              day_in: 0, day_out: 0,
              month_in: monIn, month_out: monOut,
              yesterday_in: yesIn, yesterday_out: yesOut,
              prev_month_in: pmIn, prev_month_out: pmOut,
              day_at_last_hour_start_in: 0, day_at_last_hour_start_out: 0,
              mon_at_last_hour_start_in: monIn, mon_at_last_hour_start_out: monOut,
              pending: 0,
            });
            continue;
          }

          // --- 4. Month reset detection ---
          const monthReset = pmIn > snap.month_in
                          && monIn < snap.month_in * 0.1;

          if (monthReset) {
            const incIn  = Math.max(0, pmIn  - snap.mon_at_last_hour_start_in);
            const incOut = Math.max(0, pmOut - snap.mon_at_last_hour_start_out);
            if (incIn + incOut > 0 && incIn + incOut < MAX_HOURLY_BYTES) {
              _htUpsert.run(srv, fullPortId, nick, operator, clientName, hourStart, incIn, incOut, 0);
              count++;
            }
            // BUG-FIX: set month baseline to 0 so next cross-validation
            // captures all post-reset month traffic
            upsertSnap(fullPortId, {
              day_in: dayIn, day_out: dayOut,
              month_in: 0, month_out: 0,
              yesterday_in: yesIn, yesterday_out: yesOut,
              prev_month_in: pmIn, prev_month_out: pmOut,
              day_at_last_hour_start_in: dayIn, day_at_last_hour_start_out: dayOut,
              mon_at_last_hour_start_in: 0, mon_at_last_hour_start_out: 0,
              pending: 0,
            });
            continue;
          }

          // --- 5. Normal hour: day-delta with month cross-validation ---
          const incInDay  = Math.max(0, dayIn  - snap.day_in);
          const incOutDay = Math.max(0, dayOut - snap.day_out);
          const deltaDay  = incInDay + incOutDay;

          const incInMon  = Math.max(0, monIn  - snap.month_in);
          const incOutMon = Math.max(0, monOut - snap.month_out);
          const deltaMon  = incInMon + incOutMon;

          // Cross-validation
          let uncertain = 0;
          let finalIncIn  = incInDay;
          let finalIncOut = incOutDay;

          if (deltaDay > 0 && deltaMon > 0) {
            const maxDelta = Math.max(deltaDay, deltaMon);
            const discrepancy = Math.abs(deltaDay - deltaMon) / maxDelta;
            if (discrepancy > 0.05 && maxDelta > UNCERTAIN_THRESHOLD) {
              uncertain = 2;
              uncertainCount++;
              logger.warn(`[HourlyAgg] uncertain: nick=${nick} day_delta=${(deltaDay/1048576).toFixed(1)}MB month_delta=${(deltaMon/1048576).toFixed(1)}MB discrepancy=${(discrepancy*100).toFixed(1)}%`);
              // Day counter is primary — always use day delta, just flag as uncertain
            }
          }

          // Sanity cap
          const totalInc = finalIncIn + finalIncOut;
          if (totalInc > 0 && totalInc < MAX_HOURLY_BYTES) {
            _htUpsert.run(srv, fullPortId, nick, operator, clientName, hourStart, finalIncIn, finalIncOut, uncertain);
            count++;
          }

          // Update snap (only if counters are non-zero — protect against offline modems)
          if (dayIn > 0 || dayOut > 0 || monIn > 0 || monOut > 0) {
            upsertSnap(fullPortId, {
              day_in: dayIn, day_out: dayOut,
              month_in: monIn, month_out: monOut,
              yesterday_in: yesIn, yesterday_out: yesOut,
              prev_month_in: pmIn, prev_month_out: pmOut,
              day_at_last_hour_start_in: dayIn, day_at_last_hour_start_out: dayOut,
              mon_at_last_hour_start_in: monIn, mon_at_last_hour_start_out: monOut,
              pending: 0,
            });
          }
        }
      }
      _htCleanup.run();
    });
    batch();
    const extra = uncertainCount > 0 ? `, ${uncertainCount} uncertain` : '';
    logger.info(`[HourlyAgg] Stored ${hourStart}, ${count} modem entries, ${snapCache.size} tracked${extra}`);
  } catch (e) {
    logger.error('[HourlyAgg] Error:', e.message);
  }
}

function getSnapshotCount() { return snapCache.size; }

module.exports = { init, aggregateHourlyTraffic, refreshSnapshotsOnly, getSnapshotCount };
