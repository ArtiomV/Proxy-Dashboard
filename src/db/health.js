'use strict';
// src/db/health.js — modem_health_daily repository (Stage 17).
//
// All writes go through `upsertSnapshot()` so the row shape is consistent
// regardless of whether the source is the nightly cron or the one-shot
// backfill.

let S = {};

function init(db) {
  S.upsert = db.prepare(`
    INSERT INTO modem_health_daily
      (date, server_name, imei, nick, score, error_pct, latency_ms, uptime_pct, total_checks)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(date, server_name, imei) DO UPDATE SET
      nick = excluded.nick,
      score = excluded.score,
      error_pct = excluded.error_pct,
      latency_ms = excluded.latency_ms,
      uptime_pct = excluded.uptime_pct,
      total_checks = excluded.total_checks
  `);
  S.historyByModem = db.prepare(`
    SELECT date, score, error_pct, latency_ms, uptime_pct, total_checks
    FROM modem_health_daily
    WHERE server_name = ? AND imei = ? AND date >= ?
    ORDER BY date ASC
  `);
  S.distinctDates = db.prepare(`
    SELECT DISTINCT date FROM modem_health_daily WHERE date >= ? ORDER BY date ASC
  `);
  S.hasRowForDate = db.prepare(`
    SELECT 1 FROM modem_health_daily WHERE date = ? LIMIT 1
  `);
}

function upsertSnapshot(row) {
  return S.upsert.run(
    row.date, row.server_name, row.imei, row.nick || '',
    row.score == null ? null : row.score,
    row.error_pct == null ? null : row.error_pct,
    row.latency_ms == null ? null : row.latency_ms,
    row.uptime_pct == null ? null : row.uptime_pct,
    row.total_checks || 0
  );
}

function historyByModem(server_name, imei, sinceDate) {
  return S.historyByModem.all(server_name, imei, sinceDate);
}

function hasRowForDate(date) {
  return !!S.hasRowForDate.get(date);
}

module.exports = { init, upsertSnapshot, historyByModem, hasRowForDate };
