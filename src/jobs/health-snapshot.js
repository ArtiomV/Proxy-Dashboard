'use strict';
//
// src/jobs/health-snapshot.js — daily snapshot writer for modem_health_daily.
//
// Two entry points:
//
//   runDailySnapshot()     — called by a cron every day at 23:55 MSK; writes
//                            ONE row per active modem for today's MSK date.
//
//   backfillIfEmpty(days)  — called once at boot; for any of the last `days`
//                            days that have no rows in modem_health_daily,
//                            computes a snapshot from ProxySmart modem_ping
//                            + uptime_tracking and writes it. This populates
//                            the timeline retroactively so the «Здоровье»
//                            tab has data on the very first deploy.
//
// Both compute the same `score` formula the live /api/analytics/modem_health
// endpoint uses, so the timeline and the current-day "big card" stay
// numerically consistent.

function create(deps) {
  const { db, logger, healthDb, uptimeTracking, getSetting } = deps;

  // Mirror of the score formula in src/routes/analytics.js (modem_health).
  // Kept inline so this module has no cross-dep on the route file.
  function computeScore(errPct, uptimePct) {
    const ERROR_NORMAL_PCT = 5;
    let score = 100;
    if (errPct != null && errPct > ERROR_NORMAL_PCT) {
      score -= Math.min(40, (errPct - ERROR_NORMAL_PCT) * 2);
    }
    if (uptimePct != null && uptimePct < 95) {
      score -= Math.min(30, (95 - uptimePct));
    }
    return Math.max(0, Math.min(100, Math.round(score)));
  }

  // Compute the [from, to) UTC ISO range that corresponds to a given MSK day.
  function mskDayRange(mskDate /* YYYY-MM-DD */) {
    const fromUtc = new Date(mskDate + 'T00:00:00Z'); fromUtc.setUTCHours(fromUtc.getUTCHours() - 3);
    const toUtc   = new Date(mskDate + 'T00:00:00Z'); toUtc.setUTCHours(toUtc.getUTCHours() + 21);
    return {
      fromIso: fromUtc.toISOString(),
      toIso:   toUtc.toISOString(),
      fromTs:  fromUtc.toISOString().slice(0, 19).replace('T', ' '),
      toTs:    toUtc.toISOString().slice(0, 19).replace('T', ' '),
    };
  }

  function todaysMskDate() {
    const now = new Date();
    const msk = new Date(now.getTime() + 3 * 3600 * 1000);
    return msk.toISOString().slice(0, 10);
  }

  // Compute and write snapshots for a single MSK day. Returns rows written.
  function snapshotDay(mskDate) {
    const r = mskDayRange(mskDate);
    // Active modems for this day: those with ProxySmart ping OR traffic.
    const modems = db.prepare(`
      WITH active AS (
        SELECT DISTINCT server AS server_name, nick FROM modem_ping
        WHERE ts >= ? AND ts < ?
        UNION
        SELECT DISTINCT server_name, nick FROM traffic_hourly
        WHERE hour_start >= ? AND hour_start < ?
      ),
      meta_latest AS (
        SELECT server_name, nick, imei,
               ROW_NUMBER() OVER (PARTITION BY server_name, nick ORDER BY updated_at DESC) as rn
        FROM modem_meta
      )
      SELECT a.server_name, a.nick, COALESCE(m.imei, '') as imei
      FROM active a
      LEFT JOIN meta_latest m ON m.server_name = a.server_name AND m.nick = a.nick AND m.rn = 1
    `).all(r.fromIso, r.toIso, r.fromTs, r.toTs);

    if (!modems.length) return 0;

    // Per-modem checks aggregate.
    const checks = db.prepare(`
      SELECT server AS server_name, nick,
             COUNT(*) as total,
             SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END) as err
      FROM modem_ping
      WHERE ts >= ? AND ts < ?
      GROUP BY server, nick
    `).all(r.fromIso, r.toIso);
    const checksByKey = {};
    for (const c of checks) checksByKey[c.server_name + '|' + c.nick] = c;

    let written = 0;
    const tx = db.transaction(() => {
      for (const m of modems) {
        if (!m.imei) continue;  // skip modems we have no IMEI for — can't join uptime
        const c = checksByKey[m.server_name + '|' + m.nick] || {};
        const errPct = c.total > 0 ? Math.round(c.err / c.total * 1000) / 10 : null;
        // Uptime ratio for THIS specific day from uptimeTracking.daily bucket.
        let uptimePct = null;
        const ut = uptimeTracking[m.server_name + '_' + m.imei];
        if (ut && ut.daily && ut.daily[mskDate]) {
          const d = ut.daily[mskDate];
          if (d.total > 0) uptimePct = Math.round(d.online / d.total * 1000) / 10;
        }
        const score = computeScore(errPct, uptimePct);
        healthDb.upsertSnapshot({
          date: mskDate,
          server_name: m.server_name,
          imei: m.imei,
          nick: m.nick,
          score: (errPct == null && uptimePct == null) ? null : score,
          error_pct: errPct,
          latency_ms: null,
          uptime_pct: uptimePct,
          total_checks: c.total || 0,
        });
        written++;
      }
    });
    tx();
    return written;
  }

  function runDailySnapshot() {
    try {
      // Take YESTERDAY's snapshot — today is incomplete until midnight.
      const yesterday = new Date(Date.now() - 86400000 + 3 * 3600 * 1000)
        .toISOString().slice(0, 10);
      const n = snapshotDay(yesterday);
      logger.info(`[HealthSnapshot] Wrote ${n} rows for ${yesterday}`);
      return { date: yesterday, rows: n };
    } catch (e) {
      logger.error('[HealthSnapshot] daily failed: ' + e.message);
      return { error: e.message };
    }
  }

  // Boot-time backfill: for each day in [today-days+1 .. today-1] check if
  // the table already has a row for that date; if not, compute one. Capped
  // at `days` (default 30) so it can't run amok.
  function backfillIfEmpty(days) {
    try {
      const N = Math.max(1, Math.min(60, Number(days) || 30));
      const today = todaysMskDate();
      const todayDate = new Date(today + 'T00:00:00Z');
      let filled = 0, skipped = 0;
      for (let i = N; i >= 1; i--) {
        const d = new Date(todayDate.getTime() - i * 86400000).toISOString().slice(0, 10);
        if (healthDb.hasRowForDate(d)) { skipped++; continue; }
        const n = snapshotDay(d);
        if (n > 0) filled += n;
      }
      if (filled || skipped) logger.info(`[HealthSnapshot] Backfill: wrote ${filled} rows across new days, ${skipped} days already populated`);
      return { filled, skipped, days: N };
    } catch (e) {
      logger.error('[HealthSnapshot] backfill failed: ' + e.message);
      return { error: e.message };
    }
  }

  return { runDailySnapshot, backfillIfEmpty, snapshotDay, computeScore };
}

module.exports = { create };
