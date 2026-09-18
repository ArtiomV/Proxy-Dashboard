'use strict';
//
// src/services/ping-freshness.js — единая политика свежести нативных пингов
// ProxySmart (FIX-05/06, FIX-SPEC §7, 2026-09-18). Все потребители
// (computeProxyIssues, auto-reboot, public-status, alive()/latest() пинг-джобы,
// ИИ-контекст) считают возраст и качество через этот модуль, а не своими
// константами — иначе один читатель считает данные свежими, а другой нет.
//
// Модель качества наблюдения (modem_ping_state.quality):
//   valid   — ping_stats разобран, замер пригоден;
//   missing — живой ответ бокса получен, но ping_stats пуст;
//   invalid — ping_stats есть, но не парсится;
//   stale   — НЕ хранится: вычисляется на каждом чтении из возраста и TTL,
//             иначе строка, записанная как valid, осталась бы «свежей»
//             навсегда после остановки опроса.
// Времена: observed_at — момент получения живого ответа дашбордом;
// measured_at — момент замера на ProxySmart (API его не отдаёт → NULL,
// возраст тогда считается от observed_at; выдумывать measured_at нельзя).

const DEFAULT_TTL_MIN = 10;    // как в публичном статусе; настройка ping_fresh_ttl_min
const FUTURE_SKEW_MS = 60000;  // допуск на рассинхрон часов; больше — «время из будущего»

// readSetting: (key, fallback) => value — getSetting джобы или обёртка над appSettings.
function ttlMs(readSetting) {
  const raw = typeof readSetting === 'function' ? readSetting('ping_fresh_ttl_min', DEFAULT_TTL_MIN) : DEFAULT_TTL_MIN;
  return Math.max(1, Number(raw) || DEFAULT_TTL_MIN) * 60000;
}

// Момент измерения строки: подтверждённый measured_at важнее времени получения.
function measurementMs(row) {
  if (!row) return null;
  const ms = Date.parse(row.measured_at || row.observed_at || row.ts);
  return Number.isFinite(ms) ? ms : null;
}

// Качество наблюдения на момент nowMs с учётом TTL.
function qualityAt(row, nowMs, ttl) {
  if (!row) return 'missing';
  const q = row.quality || 'valid';
  if (q !== 'valid') return q;
  const ms = measurementMs(row);
  if (ms == null) return 'invalid';                 // нет разбираемого времени
  if (ms - nowMs > FUTURE_SKEW_MS) return 'invalid'; // timestamp из будущего
  return (nowMs - ms) <= ttl ? 'valid' : 'stale';
}

function isFreshValid(row, nowMs, ttl) {
  return qualityAt(row, nowMs, ttl) === 'valid';
}

module.exports = { DEFAULT_TTL_MIN, FUTURE_SKEW_MS, ttlMs, measurementMs, qualityAt, isFreshValid };
