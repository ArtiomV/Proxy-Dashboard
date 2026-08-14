'use strict';
// src/services/fx.js — курсы MDL/RON → RUB для блока затрат (v2.10.8).
//
// Источник — ЦБ РФ (https://www.cbr-xml-daily.ru/daily_json.js), значение
// Valute.<CODE>.Value / Nominal = рублей за 1 единицу валюты. Кэш в kv_store
// (ключ 'fx_rates', JSON) на календарный день; при недоступности ЦБ отдаём
// последний кэш (source 'cache-stale'). Ручное переопределение — настройки
// fx_rate_mdl / fx_rate_ron (>0 = фикс, 0 = авто); при заданных ОБОИХ
// override сетевой вызов не выполняется вообще.
//
// init({ logger, kvGet, kvSet, getSetting }) — как у mailer.
// getRates() (async) → { date, MDL, RON, source }; последний результат
// кладётся в module-level переменную, поверх неё работает sync toRub().

const CBR_URL = 'https://www.cbr-xml-daily.ru/daily_json.js';
const KV_KEY = 'fx_rates';
const FETCH_TIMEOUT_MS = 5000;

let _deps = null;
let _lastRates = null; // { date, MDL, RON, source }

function init(deps) {
  _deps = deps; // { logger, kvGet, kvSet, getSetting }
}

function _today() {
  return new Date().toISOString().slice(0, 10);
}

function _readCache() {
  try {
    const row = _deps.kvGet(KV_KEY);
    if (!row || !row.value) return null;
    const j = JSON.parse(row.value);
    if (!j || typeof j.MDL !== 'number' || typeof j.RON !== 'number') return null;
    return j; // { date, MDL, RON }
  } catch (_) {
    return null;
  }
}

function _writeCache(rates) {
  try {
    _deps.kvSet(KV_KEY, JSON.stringify({ date: rates.date, MDL: rates.MDL, RON: rates.RON }));
  } catch (e) {
    _deps.logger.warn('[fx] cache write failed: ' + e.message);
  }
}

async function _fetchCbr() {
  // Тесты не ходят в сеть: курсы задаются override-настройками (fx_rate_*).
  if (process.env.NODE_ENV === 'test') throw new Error('fx: network disabled in tests');
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await globalThis.fetch(CBR_URL, { signal: ac.signal });
    if (!res.ok) throw new Error('CBR HTTP ' + res.status);
    const j = await res.json();
    const mdl = j && j.Valute && j.Valute.MDL;
    const ron = j && j.Valute && j.Valute.RON;
    if (!mdl || !ron) throw new Error('CBR payload without MDL/RON');
    return {
      date: String(j.Date || '').slice(0, 10) || _today(),
      MDL: mdl.Value / (mdl.Nominal || 1),
      RON: ron.Value / (ron.Nominal || 1),
    };
  } finally {
    clearTimeout(t);
  }
}

// getRates() → { date, MDL, RON, source } в RUB за 1 единицу валюты.
// source: 'override' | 'cbr' | 'cache' | 'cache-stale' | 'unavailable'
// (+ суффикс '+override', если переопределена только одна из валют).
// Никогда не бросает — худший случай 'unavailable' с MDL/RON = null.
async function getRates() {
  const oMdl = Number(_deps.getSetting('fx_rate_mdl', 0)) || 0;
  const oRon = Number(_deps.getSetting('fx_rate_ron', 0)) || 0;

  let base;
  if (oMdl > 0 && oRon > 0) {
    // Оба курса заданы вручную — ЦБ не дергаем вовсе.
    base = { date: _today(), MDL: oMdl, RON: oRon, source: 'override' };
  } else {
    const cache = _readCache();
    if (cache && cache.date === _today()) {
      base = { date: cache.date, MDL: cache.MDL, RON: cache.RON, source: 'cache' };
    } else {
      try {
        const fresh = await _fetchCbr();
        base = { date: fresh.date, MDL: fresh.MDL, RON: fresh.RON, source: 'cbr' };
        _writeCache(base);
      } catch (e) {
        _deps.logger.warn('[fx] CBR unavailable: ' + e.message);
        base = cache
          ? { date: cache.date, MDL: cache.MDL, RON: cache.RON, source: 'cache-stale' }
          : { date: _today(), MDL: null, RON: null, source: 'unavailable' };
      }
    }
    if (oMdl > 0 || oRon > 0) {
      if (oMdl > 0) base.MDL = oMdl;
      if (oRon > 0) base.RON = oRon;
      base.source += '+override';
    }
  }
  _lastRates = base;
  return base;
}

// Sync-конвертер поверх последних полученных getRates(). Курс неизвестен —
// возвращаем сумму как есть (лучше недоконвертировать, чем уронить дашборд).
function toRub(amount, currency) {
  const a = Number(amount) || 0;
  if (!currency || currency === 'RUB') return a;
  const rate = _lastRates ? _lastRates[currency] : null;
  if (!rate) return a;
  return Math.round(a * rate * 100) / 100;
}

module.exports = { init, getRates, toRub };
