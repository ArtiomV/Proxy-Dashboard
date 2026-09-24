'use strict';

// Canonical read model for modem uptime.
//
// Every consumer uses the same one-minute counters written by modem-tracking:
//   uptime_daily        — all modem checks, including a missing modem/server;
//   client_uptime_daily — the same checks attributed to the client that owned
//                         the modem at that moment.
//
// Legacy client days (before client_uptime_daily existed) are attributed via
// traffic_hourly, but the availability numerator/denominator still comes from
// uptime_daily. This avoids the old modem_ping bias where missing checks simply
// disappeared and an offline modem could therefore show 100%.

function _pct(online, total) {
  return total > 0 ? Math.round(online / total * 10000) / 100 : null;
}

function _mskDate(ms) {
  return new Date(ms + 3 * 3600000).toISOString().slice(0, 10);
}

function rollingBounds(days, nowMs) {
  const n = Math.max(1, Math.min(35, Number(days) || 30));
  const now = nowMs == null ? Date.now() : Number(nowMs);
  const toDate = _mskDate(now + 86400000);
  const fromDate = _mskDate(now - (n - 1) * 86400000);
  return { fromDate, toDate, days: n };
}

// Shape compatible with the existing uptimeTracking payload, but totals are a
// rolling period instead of the persisted all-time counters.
function rollingTracking(db, baseTracking, days, nowMs) {
  const b = rollingBounds(days, nowMs);
  const out = {};
  for (const [key, value] of Object.entries(baseTracking || {})) {
    out[key] = {
      first_check: value.first_check || null,
      last_check: value.last_check || null,
      last_online_check: value.last_online_check || null,
      online_checks: 0,
      total_checks: 0,
      period_days: b.days,
    };
  }
  let rows = [];
  try {
    rows = db.prepare(`
      SELECT key, SUM(online) AS online_checks, SUM(total) AS total_checks,
             MIN(date) AS observed_from, MAX(date) AS observed_to
        FROM uptime_daily
       WHERE date >= ? AND date < ?
       GROUP BY key
    `).all(b.fromDate, b.toDate);
  } catch (_) { rows = []; }
  for (const row of rows) {
    const value = out[row.key] || (out[row.key] = { period_days: b.days });
    value.online_checks = Number(row.online_checks) || 0;
    value.total_checks = Number(row.total_checks) || 0;
    value.observed_from = row.observed_from || null;
    value.observed_to = row.observed_to || null;
    value.uptime_pct = _pct(value.online_checks, value.total_checks);
  }
  return out;
}

function modemRows(db, fromDate, toDate) {
  try {
    // 2026-09-24 · DEEP-68: LEFT JOIN + идентичность из ключа измерения.
    // INNER JOIN с ТЕКУЩЕЙ modem_meta терял историю после retention-удаления
    // карточки (строки исчезали) и подменял старые nick/operator текущими.
    // Измерения uptime_daily — первичны: при отсутствии актуальной карточки
    // nick деградирует до IMEI из ключа, operator — явно пустой (unknown),
    // а не «нет наблюдений».
    const rows = db.prepare(`
      SELECT ud.key AS ukey,
             mm.server_name AS meta_server, mm.imei AS meta_imei,
             mm.nick AS meta_nick, mm.operator AS meta_operator,
             SUM(ud.total) AS checks,
             SUM(ud.online) AS online_checks,
             MIN(ud.date) AS observed_from,
             MAX(ud.date) AS observed_to
        FROM uptime_daily ud
        LEFT JOIN modem_meta mm ON ud.key = mm.server_name || '_' || mm.imei
       WHERE ud.date >= ? AND ud.date < ?
       GROUP BY ud.key
       ORDER BY 1
    `).all(fromDate, toDate);
    return rows.map(r => {
      const cut = String(r.ukey).indexOf('_');
      const keyImei = cut >= 0 ? String(r.ukey).slice(cut + 1) : String(r.ukey);
      return {
        server: r.meta_server || (cut >= 0 ? String(r.ukey).slice(0, cut) : ''),
        imei: r.meta_imei || keyImei,
        nick: (r.meta_nick && String(r.meta_nick).trim()) || keyImei,
        operator: (r.meta_operator && String(r.meta_operator).trim()) || '',
        checks: r.checks,
        online_checks: r.online_checks,
        observed_from: r.observed_from,
        observed_to: r.observed_to,
      };
    });
  } catch (_) { return []; }
}

function clientRows(db, fromDate, toDate, clientName, groupByDay) {
  const client = String(clientName || '').trim();
  if (!client) return [];
  const daySelect = groupByDay ? 'day,' : '';
  const dayGroup = groupByDay ? 'day, ' : '';
  try {
    return db.prepare(`
      WITH latest_meta AS (
        SELECT server_name, imei, nick, operator,
               ROW_NUMBER() OVER (
                 PARTITION BY server_name, nick
                 ORDER BY updated_at DESC, id DESC
               ) AS rn
          FROM modem_meta
      ),
      legacy_assignment AS (
        SELECT server_name, nick,
               strftime('%Y-%m-%d', datetime(hour_start, '+3 hours')) AS day
          FROM traffic_hourly
         WHERE client_name = ?
           AND strftime('%Y-%m-%d', datetime(hour_start, '+3 hours')) >= ?
           AND strftime('%Y-%m-%d', datetime(hour_start, '+3 hours')) < ?
           AND TRIM(COALESCE(nick, '')) <> ''
         GROUP BY server_name, nick, day
      ),
      direct AS (
        SELECT COALESCE(mm.server_name, substr(cu.key, 1, instr(cu.key, '_') - 1)) AS server,
               COALESCE(mm.imei, substr(cu.key, instr(cu.key, '_') + 1)) AS imei,
               COALESCE(NULLIF(TRIM(mm.nick), ''), substr(cu.key, instr(cu.key, '_') + 1)) AS nick,
               COALESCE(NULLIF(TRIM(mm.operator), ''), '') AS operator,
               cu.date AS day, cu.online, cu.total
          FROM client_uptime_daily cu
          LEFT JOIN modem_meta mm ON cu.key = mm.server_name || '_' || mm.imei
         WHERE cu.client_name = ? AND cu.date >= ? AND cu.date < ?
      ),
      legacy AS (
        SELECT lm.server_name AS server, lm.imei, lm.nick,
               COALESCE(NULLIF(TRIM(lm.operator), ''), '') AS operator,
               la.day, ud.online, ud.total
          FROM legacy_assignment la
          JOIN latest_meta lm
            ON lm.server_name = la.server_name AND lm.nick = la.nick AND lm.rn = 1
          JOIN uptime_daily ud
            ON ud.key = lm.server_name || '_' || lm.imei AND ud.date = la.day
         WHERE NOT EXISTS (
           SELECT 1 FROM client_uptime_daily cu
            WHERE cu.key = ud.key AND cu.date = ud.date
         )
      ),
      samples AS (
        SELECT * FROM direct
        UNION ALL
        SELECT * FROM legacy
      )
      SELECT ${daySelect} server, imei, nick, MAX(operator) AS operator,
             SUM(total) AS checks, SUM(online) AS online_checks,
             MIN(day) AS observed_from, MAX(day) AS observed_to
        FROM samples
       GROUP BY ${dayGroup}server, imei, nick
       ORDER BY ${dayGroup}server, nick
    `).all(client, fromDate, toDate, client, fromDate, toDate);
  } catch (_) { return []; }
}

function mapRow(row) {
  const checks = Number(row.checks) || 0;
  const onlineChecks = Number(row.online_checks) || 0;
  return {
    server: row.server,
    imei: row.imei,
    nick: row.nick,
    operator: row.operator || '',
    checks,
    online_checks: onlineChecks,
    failed_checks: Math.max(0, checks - onlineChecks),
    observed_from: row.observed_from ? row.observed_from + 'T00:00:00.000Z' : null,
    observed_to: row.observed_to ? row.observed_to + 'T23:59:59.999Z' : null,
    uptime_pct: _pct(onlineChecks, checks),
    day: row.day || undefined,
  };
}

module.exports = { rollingBounds, rollingTracking, modemRows, clientRows, mapRow };
