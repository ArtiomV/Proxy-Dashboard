'use strict';

/**
 * Get current UTC offset for a timezone name (handles DST automatically)
 * @param {string} tzName - e.g. 'Europe/Moscow'
 * @returns {number} offset in hours
 */
function getTzOffset(tzName) {
  try {
    const now = new Date();
    const fmt = new Intl.DateTimeFormat('en-US', { timeZone: tzName, timeZoneName: 'shortOffset' });
    const parts = fmt.formatToParts(now);
    const tzPart = parts.find(p => p.type === 'timeZoneName');
    if (tzPart) {
      const m = tzPart.value.match(/GMT([+-]\d{1,2})(?::(\d{2}))?/);
      if (m) return parseInt(m[1]) + (m[2] ? parseInt(m[2]) / 60 * (m[1].startsWith('-') ? -1 : 1) : 0);
    }
  } catch (_) { /* best-effort */ }
  return 3; // fallback to UTC+3 (MSK)
}

/**
 * Build a SQLite datetime() modifier string from an hour offset, e.g. 3 → "+3 hours".
 * Clamps to SQLite's valid [-12, 14] range. The value is numeric (never user input),
 * so it's safe to interpolate into SQL. (P2-3 — was copy-pasted ≥6× in analytics.js.)
 */
function tzModifier(offsetHours) {
  const h = Math.round(Math.max(-12, Math.min(14, Number(offsetHours) || 0)));
  return (h >= 0 ? '+' : '') + h + ' hours';
}

/** Convenience: the current MSK offset as a SQLite modifier (e.g. "+3 hours"). */
function sqliteMskTzModifier() {
  return tzModifier(getTzOffset('Europe/Moscow'));
}

function getMoscowNow() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Moscow' }));
}

function getMoscowToday() {
  return getMoscowNow().toLocaleDateString('en-CA'); // "YYYY-MM-DD"
}

function getMoscowYesterday() {
  const d = getMoscowNow();
  d.setDate(d.getDate() - 1);
  return d.toLocaleDateString('en-CA');
}

module.exports = { getTzOffset, tzModifier, sqliteMskTzModifier, getMoscowNow, getMoscowToday, getMoscowYesterday };
