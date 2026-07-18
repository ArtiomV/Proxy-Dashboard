'use strict';
// src/db/traffic.js — daily_traffic + traffic_hourly + hourly_snapshots
// + api_usage (Stage 2 finish).
//
// Hot path: every modem-polling cycle inserts a per-port snapshot
// + every billing-hour rollup upserts daily/hourly rows. We expose
// raw prepared statements rather than wrappers so the per-call
// overhead stays at ~0.

let S = {};

function init(db) {
  // daily_traffic: keyed by (port_name, date). MAX() merge so old
  // counters don't overwrite new ones if two pollers race.
  S.dailyUpsert = db.prepare(`INSERT INTO daily_traffic (port_name, date, bytes_in, bytes_out) VALUES (?, ?, ?, ?)
    ON CONFLICT(port_name, date) DO UPDATE SET
    bytes_in = MAX(bytes_in, excluded.bytes_in),
    bytes_out = MAX(bytes_out, excluded.bytes_out)`);

  // traffic_hourly: keyed by (port_id, hour_start). "If hour already
  // recorded, don't overwrite" — protects against double-counting if
  // the aggregator runs twice for the same hour.
  S.hourlyUpsert = db.prepare(`INSERT INTO traffic_hourly (server_name, port_id, nick, operator, client_name, hour_start, bytes_in, bytes_out, uncertain)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(port_id, hour_start) DO UPDATE SET
    bytes_in  = CASE WHEN bytes_in  = 0 THEN excluded.bytes_in  ELSE bytes_in  END,
    bytes_out = CASE WHEN bytes_out = 0 THEN excluded.bytes_out ELSE bytes_out END,
    uncertain = CASE WHEN excluded.uncertain > uncertain THEN excluded.uncertain ELSE uncertain END`);

  // hourly_snapshots: rolling view of "where were counters at hour boundary"
  // — used for cross-validation between live counters and computed deltas.
  S.snapshotUpsert = db.prepare(`INSERT INTO hourly_snapshots
    (port_id, day_in, day_out, month_in, month_out, yesterday_in, yesterday_out,
     prev_month_in, prev_month_out, day_at_last_hour_start_in, day_at_last_hour_start_out,
     mon_at_last_hour_start_in, mon_at_last_hour_start_out, pending, captured_at, last_updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'),datetime('now'))
    ON CONFLICT(port_id) DO UPDATE SET
    day_in=excluded.day_in, day_out=excluded.day_out,
    month_in=excluded.month_in, month_out=excluded.month_out,
    yesterday_in=excluded.yesterday_in, yesterday_out=excluded.yesterday_out,
    prev_month_in=excluded.prev_month_in, prev_month_out=excluded.prev_month_out,
    day_at_last_hour_start_in=excluded.day_at_last_hour_start_in,
    day_at_last_hour_start_out=excluded.day_at_last_hour_start_out,
    mon_at_last_hour_start_in=excluded.mon_at_last_hour_start_in,
    mon_at_last_hour_start_out=excluded.mon_at_last_hour_start_out,
    pending=excluded.pending, captured_at=excluded.captured_at,
    last_updated_at=datetime('now')`);

  S.snapshotGet = db.prepare('SELECT * FROM hourly_snapshots WHERE port_id = ?');
  S.snapshotGetAll = db.prepare('SELECT * FROM hourly_snapshots');

  // api_usage: every /api/v1/* hit gets one row (rate + error tracking).
  // key_via ('header'|'query') — migration 044, feeds the ?apiKey= sunset.
  S.apiUsageInsert = db.prepare(`INSERT INTO api_usage
    (client_id, client_name, api_key_prefix, endpoint, method, status_code,
     response_time_ms, user_agent, ip, error, key_via)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

  // Stage 8: scattered queries previously inlined in server.js.
  // 90-day retention purge + load (called once at startup in server.js).
  S.dailyPurge90d = db.prepare("DELETE FROM daily_traffic WHERE date < date('now', '-90 days')");
  S.dailyLast90d  = db.prepare("SELECT port_name, date, bytes_in, bytes_out FROM daily_traffic WHERE date >= date('now', '-90 days')");
  // Hourly aggregation cross-day reconcile: sum traffic for a client_name
  // within a given Moscow date. Hour rows are UTC; +3 hours converts to MSK
  // before slicing the YYYY-MM-DD.
  S.hourlyByClientDate = db.prepare(`
    SELECT COALESCE(SUM(bytes_in + bytes_out), 0) AS bytes
      FROM traffic_hourly
     WHERE client_name = ?
       AND substr(datetime(hour_start, '+3 hours'), 1, 10) = ?
  `);
  // Auto-smooth uncertain flag for rows that ended up tiny (<150 MB) — the
  // uncertainty flag was set during aggregation but the value is too small
  // to materially change billing, so we clear it after the fact.
  S.hourlyAutoSmoothUncertain = db.prepare(
    'UPDATE traffic_hourly SET uncertain = 0 ' +
    'WHERE uncertain > 0 AND (bytes_in + bytes_out) < ' + (150 * 1e6)
  );
  // Check whether a specific hour_start was recorded (idempotency in the
  // backfill job — skips hours already aggregated).
  S.hourlyExistsForHour = db.prepare(
    'SELECT COUNT(*) AS cnt FROM traffic_hourly WHERE hour_start = ?'
  );
}

// Retention on traffic_hourly takes the day-count as a query parameter so
// we don't have to re-prepare on every call. Cached on first use.
let _hourlyPurgeStmt = null;
function hourlyPurgeOlderThan(db, days) {
  if (!_hourlyPurgeStmt) {
    _hourlyPurgeStmt = db.prepare(
      "DELETE FROM traffic_hourly WHERE hour_start < datetime('now', '-' || ? || ' days')"
    );
  }
  return _hourlyPurgeStmt.run(String(days));
}

// daily_traffic IN(port_name_list) sum for a date — IN-list size varies,
// so we prepare per cardinality and cache.
const _dailySumByDateAndPortsCache = new Map();
function dailySumByDateAndPorts(db, date, portIds) {
  if (!portIds || portIds.length === 0) return 0;
  let stmt = _dailySumByDateAndPortsCache.get(portIds.length);
  if (!stmt) {
    const placeholders = portIds.map(() => '?').join(',');
    stmt = db.prepare(
      `SELECT COALESCE(SUM(bytes_in + bytes_out), 0) AS bytes
         FROM daily_traffic
        WHERE date = ? AND port_name IN (${placeholders})`
    );
    _dailySumByDateAndPortsCache.set(portIds.length, stmt);
  }
  return stmt.get(date, ...portIds).bytes || 0;
}

module.exports = {
  init,
  dailyUpsertStmt:    () => S.dailyUpsert,
  hourlyUpsertStmt:   () => S.hourlyUpsert,
  snapshotUpsertStmt: () => S.snapshotUpsert,
  snapshotGetStmt:    () => S.snapshotGet,
  snapshotGetAllStmt: () => S.snapshotGetAll,
  apiUsageInsertStmt: () => S.apiUsageInsert,
  // Stage 8 additions
  dailyPurge90dStmt:           () => S.dailyPurge90d,
  dailyLast90dStmt:            () => S.dailyLast90d,
  hourlyByClientDateStmt:      () => S.hourlyByClientDate,
  hourlyAutoSmoothUncertainStmt: () => S.hourlyAutoSmoothUncertain,
  hourlyExistsForHourStmt:     () => S.hourlyExistsForHour,
  hourlyPurgeOlderThan,
  dailySumByDateAndPorts,
};
