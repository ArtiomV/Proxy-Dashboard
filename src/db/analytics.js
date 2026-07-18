'use strict';
// src/db/analytics.js — query layer for the analytics routes (WP6.1).
//
// Every SQL string of the Analytics tab lives here; routers only shape
// parameters and responses. Two forms:
//   - prepared statements via init(db) for fixed SQL (days are passed as
//     `? || ' days'` modifiers so statements stay reusable);
//   - builder functions returning { sql, params } for queries with dynamic
//     IN-lists / filter fragments. The builder owns the parameter ORDER —
//     append params only through the builder.
//
// Stage 18.16 note: UNBOUND_FILTER ("production traffic from real clients")
// is part of most read queries — kept here so every consumer shares it.

const UNBOUND_FILTER = " AND client_name != '' AND client_name IS NOT NULL";

let S = {};

function init(db) {
  // ── monthly_traffic ──────────────────────────────────────────────────
  S.monthlyTraffic = db.prepare(
    'SELECT substr(date,1,7) as month, SUM(bytes_in+bytes_out) as total_bytes ' +
    'FROM daily_traffic WHERE date >= ? GROUP BY month ORDER BY month');

  // ── modem_heatmap (per-client matrices for one modem) ────────────────
  S.modemHeatmap = (tzStr) => db.prepare(
    `SELECT CASE WHEN client_name IS NULL OR TRIM(client_name) = '' THEN '' ELSE client_name END as cn, strftime('%Y-%m-%d', datetime(hour_start, '${tzStr}')) as day, CAST(strftime('%H', datetime(hour_start, '${tzStr}')) AS INTEGER) as hour, SUM(bytes_in+bytes_out) as bytes FROM traffic_hourly WHERE nick = ? AND server_name = ? AND hour_start >= ? GROUP BY cn, day, hour`);

  // ── modem_health (days as `? || ' days`, always negative) ────────────
  S.healthActive = db.prepare(`
    WITH active AS (
      SELECT DISTINCT server_name, nick FROM proxy_checks
      WHERE checked_at >= datetime('now', ? || ' days')${UNBOUND_FILTER}
      UNION
      SELECT DISTINCT server_name, nick FROM traffic_hourly
      WHERE hour_start >= datetime('now', ? || ' days')${UNBOUND_FILTER}
    ),
    meta_latest AS (
      SELECT server_name, nick, imei, operator, sim_status, reboot_score,
             ROW_NUMBER() OVER (PARTITION BY server_name, nick ORDER BY updated_at DESC) as rn
      FROM modem_meta
    )
    SELECT a.server_name, a.nick, COALESCE(m.imei, '') as imei, COALESCE(m.operator, '') as operator,
           COALESCE(m.sim_status, '') as sim_status, m.reboot_score as reboot_score
    FROM active a
    LEFT JOIN meta_latest m
      ON m.server_name = a.server_name AND m.nick = a.nick AND m.rn = 1
    ORDER BY a.server_name, a.nick
  `);
  S.healthChecks = db.prepare(`
    SELECT server_name, nick,
           AVG(total_ms) FILTER (WHERE error IS NULL) as avg_latency,
           COUNT(*) as total_checks,
           SUM(CASE WHEN error IS NOT NULL THEN 1 ELSE 0 END) as err_checks
    FROM proxy_checks
    WHERE checked_at >= datetime('now', ? || ' days')${UNBOUND_FILTER}
    GROUP BY server_name, nick
  `);
  S.healthRotations = db.prepare(`
    SELECT server_name, nick,
           COUNT(*) as total,
           SUM(CASE WHEN old_ip = new_ip THEN 1 ELSE 0 END) as failed,
           AVG(took_sec) as avg_sec
    FROM rotation_log
    WHERE started_at >= datetime('now', ? || ' days') AND ended_at IS NOT NULL
    GROUP BY server_name, nick
  `);
  S.healthTraffic = db.prepare(`
    SELECT server_name, nick, SUM(bytes_in + bytes_out) as bytes
    FROM traffic_hourly
    WHERE hour_start >= datetime('now', ? || ' days')${UNBOUND_FILTER}
    GROUP BY server_name, nick
  `);

  // ── rotations (stale filter is dynamic — builder below) ──────────────
  S.rotationsTotals = (sinceExpr, staleFilter) => db.prepare(`
    SELECT COUNT(*) as total,
           SUM(CASE WHEN old_ip = new_ip THEN 1 ELSE 0 END) as failed,
           AVG(took_sec) as avg_sec,
           MAX(took_sec) as max_sec,
           MIN(took_sec) as min_sec
    FROM rotation_log
    WHERE started_at >= ${sinceExpr} AND ended_at IS NOT NULL${staleFilter}
  `);
  S.rotationsPerDay = (sinceExpr, staleFilter) => db.prepare(`
    SELECT substr(started_at, 1, 10) as date,
           COUNT(*) as total,
           SUM(CASE WHEN old_ip = new_ip THEN 1 ELSE 0 END) as failed,
           AVG(took_sec) as avg_sec
    FROM rotation_log
    WHERE started_at >= ${sinceExpr} AND ended_at IS NOT NULL${staleFilter}
    GROUP BY date
    ORDER BY date
  `);
  S.rotationsPerModem = (sinceExpr, staleFilter) => db.prepare(`
    SELECT r.server_name, r.nick, m.operator,
           COUNT(*) as total,
           SUM(CASE WHEN r.old_ip = r.new_ip THEN 1 ELSE 0 END) as failed,
           AVG(r.took_sec) as avg_sec,
           MAX(r.took_sec) as max_sec
    FROM rotation_log r
    LEFT JOIN modem_meta m ON m.nick = r.nick AND m.server_name = r.server_name
    WHERE r.started_at >= ${sinceExpr} AND r.ended_at IS NOT NULL${staleFilter}
    GROUP BY r.server_name, r.nick
    ORDER BY total DESC
    LIMIT 200
  `);
  S.rotationsPerOperator = (sinceExpr, staleFilter) => db.prepare(`
    SELECT COALESCE(m.operator, 'unknown') as operator,
           COUNT(*) as total,
           SUM(CASE WHEN r.old_ip = r.new_ip THEN 1 ELSE 0 END) as failed,
           AVG(r.took_sec) as avg_sec
    FROM rotation_log r
    LEFT JOIN modem_meta m ON m.nick = r.nick AND m.server_name = r.server_name
    WHERE r.started_at >= ${sinceExpr} AND r.ended_at IS NOT NULL${staleFilter}
    GROUP BY operator
    ORDER BY total DESC
  `);
  S.rotationsPerServer = (sinceExpr, staleFilter) => db.prepare(`
    SELECT server_name,
           COUNT(*) as total,
           SUM(CASE WHEN old_ip = new_ip THEN 1 ELSE 0 END) as failed,
           AVG(took_sec) as avg_sec,
           MAX(took_sec) as max_sec
    FROM rotation_log
    WHERE started_at >= ${sinceExpr} AND ended_at IS NOT NULL${staleFilter}
    GROUP BY server_name
    ORDER BY total DESC
  `);
  S.rotationsRecentFailed = (sinceExpr, staleFilter) => db.prepare(`
    SELECT server_name, nick, old_ip, new_ip, started_at, took_sec
    FROM rotation_log
    WHERE old_ip IS NOT NULL AND new_ip IS NOT NULL AND old_ip = new_ip
      AND started_at >= ${sinceExpr}${staleFilter}
    ORDER BY started_at DESC
    LIMIT 50
  `);

  // ── ip_stats (stale filter on key — dynamic, builder below) ──────────
  S.ipUnique = (sinceExpr, staleFilter) => db.prepare(`
    SELECT COUNT(DISTINCT ip) as c FROM ip_history
    WHERE started_at >= ${sinceExpr}${staleFilter}
  `);
  S.ipAssignments = (sinceExpr, staleFilter) => db.prepare(`
    SELECT COUNT(*) as c FROM ip_history WHERE started_at >= ${sinceExpr}${staleFilter}
  `);
  S.ipReused = (sinceExpr, staleFilter) => db.prepare(`
    SELECT ip, COUNT(*) as uses, COUNT(DISTINCT key) as modems,
           MIN(started_at) as first, MAX(started_at) as last
    FROM ip_history
    WHERE started_at >= ${sinceExpr}${staleFilter}
    GROUP BY ip
    HAVING modems > 1
    ORDER BY uses DESC
    LIMIT 100
  `);
  S.ipLifetime = (sinceExpr, staleFilter) => db.prepare(`
    SELECT AVG((julianday(ended_at) - julianday(started_at)) * 86400) as avg_sec
    FROM ip_history
    WHERE ended_at IS NOT NULL AND started_at >= ${sinceExpr}${staleFilter}
  `);
  S.ipPools = (sinceExpr, staleFilter) => db.prepare(`
    SELECT substr(key, 1, instr(key, '_') - 1) as server,
           COUNT(DISTINCT ip) as ip_count,
           COUNT(*) as total_assignments,
           AVG(CASE WHEN ended_at IS NOT NULL THEN (julianday(ended_at) - julianday(started_at)) * 86400 END) as avg_lifetime_sec
    FROM ip_history
    WHERE started_at >= ${sinceExpr} AND instr(key, '_') > 0${staleFilter}
    GROUP BY server
    ORDER BY ip_count DESC
  `);
  S.ipSubnets = (sinceExpr, staleFilter) => db.prepare(`
    SELECT key,
           COUNT(DISTINCT rtrim(rtrim(ip,'0123456789'),'.')) as subnets,
           COUNT(DISTINCT ip) as ips
      FROM ip_history
     WHERE started_at >= ${sinceExpr}${staleFilter}
     GROUP BY key
     ORDER BY subnets DESC
  `);
  S.modemNickByKey = db.prepare('SELECT server_name, imei, nick FROM modem_meta');

  // ── traffic_forecast ─────────────────────────────────────────────────
  S.forecastDailyTraffic = db.prepare(`
    SELECT port_name, date, SUM(bytes_in + bytes_out) as bytes
    FROM daily_traffic
    WHERE date >= substr(datetime('now', ? || ' days'), 1, 10)
    GROUP BY port_name, date
  `);

  // ── capacity (stale NOT IN fragments are dynamic — pass the clause in) ──
  S.capacityServers = (sinceExpr, staleFilter) => db.prepare(`
    SELECT server_name,
           COUNT(DISTINCT nick) as modem_count,
           SUM(bytes_in + bytes_out) as total_bytes,
           AVG(bytes_in + bytes_out) as avg_hour_bytes,
           MAX(bytes_in + bytes_out) as max_hour_bytes,
           COUNT(DISTINCT substr(hour_start, 1, 10)) as active_days
    FROM traffic_hourly
    WHERE hour_start >= ${sinceExpr}${staleFilter}
    GROUP BY server_name
    ORDER BY total_bytes DESC
  `);
  S.capacityModemGrowth = (imeiFilter) => db.prepare(`
    SELECT substr(updated_at, 1, 7) as month,
           COUNT(DISTINCT imei) as modems
    FROM modem_meta WHERE 1=1${imeiFilter}
    GROUP BY month
    ORDER BY month
  `);
  S.capacityTotals = (sinceExpr, staleFilter) => db.prepare(`
    SELECT SUM(bytes_in + bytes_out) as total_bytes,
           COUNT(DISTINCT nick) as total_modems,
           COUNT(DISTINCT server_name) as total_servers
    FROM traffic_hourly
    WHERE hour_start >= ${sinceExpr}${staleFilter}
  `);

  // ── latency_stats / latency_day (tz + shared filter clause) ──────────
  S.latencyDayVals = (tzStr, filter) => db.prepare(
    `SELECT strftime('%Y-%m-%d', datetime(checked_at, '${tzStr}')) as day, total_ms, connect_ms FROM proxy_checks WHERE checked_at >= ? AND total_ms IS NOT NULL AND error IS NULL${filter} ORDER BY day, total_ms`);
  S.latencyErrByDay = (tzStr, filter) => db.prepare(
    `SELECT strftime('%Y-%m-%d', datetime(checked_at, '${tzStr}')) as day, COUNT(*) as cnt FROM proxy_checks WHERE checked_at >= ? AND error IS NOT NULL${filter} GROUP BY day`);
  S.latencyTotalByDay = (tzStr, filter) => db.prepare(
    `SELECT strftime('%Y-%m-%d', datetime(checked_at, '${tzStr}')) as day, COUNT(*) as cnt FROM proxy_checks WHERE checked_at >= ?${filter} GROUP BY day`);
  S.latencyPriorVals = (filter) => db.prepare(
    `SELECT total_ms, connect_ms FROM proxy_checks WHERE checked_at >= ? AND checked_at < ? AND total_ms IS NOT NULL AND error IS NULL${filter}`);
  S.latencyPriorTotal = (filter) => db.prepare(
    `SELECT COUNT(*) as cnt FROM proxy_checks WHERE checked_at >= ? AND checked_at < ?${filter}`);
  S.latencyPriorErr = (filter) => db.prepare(
    `SELECT COUNT(*) as cnt FROM proxy_checks WHERE checked_at >= ? AND checked_at < ? AND error IS NOT NULL${filter}`);
  S.latencyDayRows = (filter) => db.prepare(
    `SELECT nick, server_name, operator, client_name, checked_at,
      connect_ms, total_ms, status_code, error
      FROM proxy_checks
      WHERE checked_at >= ? AND checked_at < ?${filter}
      ORDER BY checked_at ASC`);

  // ── logs_domains_full ────────────────────────────────────────────────
  S.topHostsRows = (whereSql, limit) => db.prepare(`
    SELECT server_name, port_id, nick, client_name, operator, country, host, count
    FROM top_hosts_detail
    ${whereSql}
    ORDER BY count DESC
    LIMIT ${limit}
  `);
  S.topHostsTotals = (whereSql) => db.prepare(`
    SELECT COUNT(*) as rows,
           SUM(count) as hits,
           COUNT(DISTINCT host) as unique_hosts,
           COUNT(DISTINCT client_name) as clients,
           COUNT(DISTINCT operator) as operators,
           COUNT(DISTINCT server_name) as servers,
           COUNT(DISTINCT nick) as modems
    FROM top_hosts_detail
    ${whereSql}
  `);
  S.topHostsTop = (whereSql) => db.prepare(`
    SELECT host, SUM(count) as hits, COUNT(DISTINCT nick) as modems, COUNT(DISTINCT client_name) as clients
    FROM top_hosts_detail ${whereSql}
    GROUP BY host ORDER BY hits DESC LIMIT 100`);
  S.topHostsByClient = (whereSql) => db.prepare(`
    SELECT client_name, SUM(count) as hits, COUNT(DISTINCT host) as unique_hosts
    FROM top_hosts_detail ${whereSql}
    GROUP BY client_name ORDER BY hits DESC`);
  S.topHostsByOperator = (whereSql) => db.prepare(`
    SELECT operator, SUM(count) as hits, COUNT(DISTINCT host) as unique_hosts
    FROM top_hosts_detail ${whereSql}
    GROUP BY operator ORDER BY hits DESC`);
  S.topHostsByServer = (whereSql) => db.prepare(`
    SELECT server_name, country, SUM(count) as hits, COUNT(DISTINCT host) as unique_hosts, COUNT(DISTINCT nick) as modems
    FROM top_hosts_detail ${whereSql}
    GROUP BY server_name ORDER BY hits DESC`);
  S.topHostsByModem = (whereSql) => db.prepare(`
    SELECT server_name, nick, operator, SUM(count) as hits, COUNT(DISTINCT host) as unique_hosts
    FROM top_hosts_detail ${whereSql}
    GROUP BY server_name, nick ORDER BY hits DESC LIMIT 100`);
  S.topHostsTldRows = (whereSql) => db.prepare(`
    SELECT host, SUM(count) as hits, COUNT(DISTINCT nick) as mods
    FROM top_hosts_detail ${whereSql}
    GROUP BY host
  `);
  S.topHostsSnapshotMeta = db.prepare('SELECT MIN(snapshot_at) as ts, COUNT(*) as total_rows FROM top_hosts_detail');
  S.topHostsFacetClients = db.prepare("SELECT DISTINCT client_name FROM top_hosts_detail WHERE client_name != '' ORDER BY client_name");
  S.topHostsFacetOperators = db.prepare("SELECT DISTINCT operator FROM top_hosts_detail WHERE operator != '' ORDER BY operator");
  S.topHostsFacetServers = db.prepare('SELECT DISTINCT server_name FROM top_hosts_detail ORDER BY server_name');
}

// ── Dynamic builders ───────────────────────────────────────────────────

// Shared stale-modem NOT IN fragment. Returns { clause, params }.
function notInClause(column, values) {
  const arr = Array.from(values || []);
  if (!arr.length) return { clause: '', params: [] };
  return { clause: ` AND ${column} NOT IN (${arr.map(() => '?').join(',')})`, params: arr };
}

// proxy_checks filter shared by latency_stats / latency_day (view-scoped
// + stale + unbound). Returns { clause, params } — appended after the
// time bounds, so params must be appended after the time params.
function proxyChecksFilter({ view, idKey, id, servers, staleNicks, unboundNicks, unboundFilter = true }) {
  let clause = '';
  const params = [];
  if (idKey !== 'all') {
    if (view === 'country' && servers && servers.length) {
      clause += ' AND server_name IN (' + servers.map(() => '?').join(',') + ')';
      params.push(...servers);
    } else if (view === 'operator') {
      clause += " AND LOWER(REPLACE(operator, ' ', '_')) LIKE ?";
      params.push('%' + idKey + '%');
    } else if (view === 'client') {
      clause += ' AND client_name = ?';
      params.push(id);
    }
  }
  for (const set of [staleNicks, unboundNicks]) {
    const { clause: c, params: p } = notInClause('nick', set);
    clause += c;
    params.push(...p);
  }
  if (unboundFilter) clause += UNBOUND_FILTER;
  return { clause, params };
}

// heatmap day×hour matrix query (+ optional per-operator breakdown).
// servers: resolved server names for country view (already filtered).
function heatmapSql({ tzStr, start, view, idKey, id, servers }) {
  let sql = `SELECT strftime('%Y-%m-%d', datetime(hour_start, '${tzStr}')) as day, CAST(strftime('%H', datetime(hour_start, '${tzStr}')) AS INTEGER) as hour, SUM(bytes_in+bytes_out) as bytes, MAX(uncertain) as corrected FROM traffic_hourly WHERE hour_start >= ?`;
  const params = [start];
  if (idKey !== 'all') {
    if (view === 'country' && servers && servers.length) {
      sql += ' AND server_name IN (' + servers.map(() => '?').join(',') + ')';
      params.push(...servers);
    } else if (view === 'operator') {
      sql += " AND LOWER(REPLACE(operator, ' ', '_')) LIKE ?";
      params.push('%' + idKey + '%');
    } else if (view === 'client') {
      sql += ' AND client_name = ?';
      params.push(id);
    }
  }
  sql += UNBOUND_FILTER + ' GROUP BY day, hour ORDER BY day, hour';
  return { sql, params };
}

function heatmapOperatorSql({ tzStr, start, view, id, servers }) {
  let sql = `SELECT strftime('%Y-%m-%d', datetime(hour_start, '${tzStr}')) as day, CAST(strftime('%H', datetime(hour_start, '${tzStr}')) AS INTEGER) as hour, CASE WHEN operator IS NULL OR TRIM(operator) = '' THEN 'Неизвестный' ELSE operator END as op, SUM(bytes_in+bytes_out) as bytes, COUNT(DISTINCT nick) as modems FROM traffic_hourly WHERE hour_start >= ?`;
  const params = [start];
  if (view === 'client') {
    sql += ' AND client_name = ?';
    params.push(id);
  } else if (view === 'country' && servers && servers.length) {
    sql += ' AND server_name IN (' + servers.map(() => '?').join(',') + ')';
    params.push(...servers);
  }
  sql += UNBOUND_FILTER + ' GROUP BY day, hour, op ORDER BY day, hour, op';
  return { sql, params };
}

// logs_domains_full: WHERE from request filters (shared by every query
// of the endpoint — the builder owns the param order).
function topHostsWhere({ host, client, operator, server, nick, minCount }) {
  const where = ['count >= ?'];
  const params = [minCount];
  if (host)     { where.push('LOWER(host) LIKE ?'); params.push('%' + String(host).toLowerCase() + '%'); }
  if (client)   { where.push('client_name = ?');    params.push(client); }
  if (operator) { where.push('operator = ?');       params.push(operator); }
  if (server)   { where.push('server_name = ?');    params.push(server); }
  if (nick)     { where.push('nick = ?');           params.push(nick); }
  return { whereSql: 'WHERE ' + where.join(' AND '), params };
}

module.exports = {
  init, UNBOUND_FILTER,
  notInClause, proxyChecksFilter, heatmapSql, heatmapOperatorSql, topHostsWhere,
  // modem_health accessors (days is a negative int)
  healthActive:   (days) => S.healthActive.all(days, days),
  healthChecks:   (days) => S.healthChecks.all(days),
  healthRotations:(days) => S.healthRotations.all(days),
  healthTraffic:  (days) => S.healthTraffic.all(days),
  // monthly_traffic
  monthlyTraffic: (startDate) => S.monthlyTraffic.all(startDate),
  // modem_heatmap
  modemHeatmap: (tzStr, nick, serverName, utcStart) => S.modemHeatmap(tzStr).all(nick, serverName, utcStart),
  // rotations (sinceExpr is a datetime() fragment; staleFilter is a SQL clause,
  // staleArgs its bound params — caller may rewrite 'nick' → 'r.nick' for the
  // joined variants)
  rotationsTotals:      (sinceExpr, staleArgs, staleFilter = '') => S.rotationsTotals(sinceExpr, staleFilter).get(...staleArgs),
  rotationsPerDay:      (sinceExpr, staleArgs, staleFilter = '') => S.rotationsPerDay(sinceExpr, staleFilter).all(...staleArgs),
  rotationsPerModem:    (sinceExpr, staleArgs, staleFilter = '') => S.rotationsPerModem(sinceExpr, staleFilter).all(...staleArgs),
  rotationsPerOperator: (sinceExpr, staleArgs, staleFilter = '') => S.rotationsPerOperator(sinceExpr, staleFilter).all(...staleArgs),
  rotationsPerServer:   (sinceExpr, staleArgs, staleFilter = '') => S.rotationsPerServer(sinceExpr, staleFilter).all(...staleArgs),
  rotationsRecentFailed:(sinceExpr, staleArgs, staleFilter = '') => S.rotationsRecentFailed(sinceExpr, staleFilter).all(...staleArgs),
  // ip_stats
  ipUnique:      (sinceExpr, staleArgs, staleFilter = '') => S.ipUnique(sinceExpr, staleFilter).get(...staleArgs),
  ipAssignments: (sinceExpr, staleArgs, staleFilter = '') => S.ipAssignments(sinceExpr, staleFilter).get(...staleArgs),
  ipReused:      (sinceExpr, staleArgs, staleFilter = '') => S.ipReused(sinceExpr, staleFilter).all(...staleArgs),
  ipLifetime:    (sinceExpr, staleArgs, staleFilter = '') => S.ipLifetime(sinceExpr, staleFilter).get(...staleArgs),
  ipPools:       (sinceExpr, staleArgs, staleFilter = '') => S.ipPools(sinceExpr, staleFilter).all(...staleArgs),
  ipSubnets:     (sinceExpr, staleArgs, staleFilter = '') => S.ipSubnets(sinceExpr, staleFilter).all(...staleArgs),
  modemNickByKey: () => S.modemNickByKey.all(),
  // forecast
  forecastDailyTraffic: (days) => S.forecastDailyTraffic.all(days),
  // capacity
  capacityServers:     (sinceExpr, staleFilter) => S.capacityServers(sinceExpr, staleFilter),
  capacityModemGrowth: (imeiFilter) => S.capacityModemGrowth(imeiFilter),
  capacityTotals:      (sinceExpr, staleFilter) => S.capacityTotals(sinceExpr, staleFilter),
  // top_hosts
  topHostsSnapshotMeta: () => S.topHostsSnapshotMeta.get(),
  topHostsRows:    (whereSql, params, limit) => S.topHostsRows(whereSql, limit).all(...params),
  topHostsTotals:  (whereSql, params) => S.topHostsTotals(whereSql).get(...params),
  topHostsTop:     (whereSql, params) => S.topHostsTop(whereSql).all(...params),
  topHostsByClient:(whereSql, params) => S.topHostsByClient(whereSql).all(...params),
  topHostsByOperator:(whereSql, params) => S.topHostsByOperator(whereSql).all(...params),
  topHostsByServer:(whereSql, params) => S.topHostsByServer(whereSql).all(...params),
  topHostsByModem: (whereSql, params) => S.topHostsByModem(whereSql).all(...params),
  topHostsTldRows: (whereSql, params) => S.topHostsTldRows(whereSql).all(...params),
  topHostsFacets: () => ({
    clients: S.topHostsFacetClients.all().map(r => r.client_name),
    operators: S.topHostsFacetOperators.all().map(r => r.operator),
    servers: S.topHostsFacetServers.all().map(r => r.server_name),
  }),
  // latency
  latencyDayVals:    (tzStr, filter, since, params) => S.latencyDayVals(tzStr, filter).all(since, ...params),
  latencyErrByDay:   (tzStr, filter, since, params) => S.latencyErrByDay(tzStr, filter).all(since, ...params),
  latencyTotalByDay: (tzStr, filter, since, params) => S.latencyTotalByDay(tzStr, filter).all(since, ...params),
  latencyPriorVals:  (filter, since, until, params) => S.latencyPriorVals(filter).all(since, until, ...params),
  latencyPriorTotal: (filter, since, until, params) => S.latencyPriorTotal(filter).get(since, until, ...params),
  latencyPriorErr:   (filter, since, until, params) => S.latencyPriorErr(filter).get(since, until, ...params),
  latencyDayRows:    (filter, params) => S.latencyDayRows(filter).all(...params),
};
