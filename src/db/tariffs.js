'use strict';
// src/db/tariffs.js — repository for the `tariffs` table (единый прайс, Р36).
//
// tariffs — ЕДИНСТВЕННЫЙ источник базовых цен: розница видит public=1 на
// витрине, B2B AutoCreate берёт is_default. pricing_tiers (kv) мигрирует
// сюда строками при boot (seedFromPricingTiers) и выпиливается.
// Канон цены: ₽/мес (per_modem), ₽/ГБ (per_gb). flat нет (Р34).

let S = {};

function init(db) {
  S.all = db.prepare('SELECT * FROM tariffs ORDER BY sort, id');
  S.byId = db.prepare('SELECT * FROM tariffs WHERE id = ?');
  S.publicActive = db.prepare(
    'SELECT * FROM tariffs WHERE public = 1 AND active = 1 ORDER BY sort, id'
  );
  S.defaults = db.prepare(
    'SELECT * FROM tariffs WHERE is_default = 1 AND active = 1 ORDER BY min_proxies DESC'
  );
  S.insert = db.prepare(`INSERT INTO tariffs
    (name, type, geo, server, price, min_proxies, public, is_default,
     maxconn, bandlim_kbit, rotation_allowed, min_topup_days, duration_hours, active, sort)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  S.update = db.prepare(`UPDATE tariffs SET
    name=?, type=?, geo=?, server=?, price=?, min_proxies=?, public=?, is_default=?,
    maxconn=?, bandlim_kbit=?, rotation_allowed=?, min_topup_days=?, duration_hours=?, active=?, sort=?
    WHERE id=?`);
  S.remove = db.prepare('DELETE FROM tariffs WHERE id = ?');
  S.count = db.prepare('SELECT COUNT(*) AS cnt FROM tariffs');
}

function _params(t) {
  return [
    t.name, t.type || 'per_modem', t.geo || '', t.server || '',
    t.price, t.min_proxies != null ? t.min_proxies : 1,
    t.public ? 1 : 0, t.is_default ? 1 : 0,
    t.maxconn != null ? t.maxconn : null,
    t.bandlim_kbit != null ? t.bandlim_kbit : null,
    t.rotation_allowed !== false && t.rotation_allowed !== 0 ? 1 : 0,
    t.min_topup_days != null ? t.min_topup_days : 1,
    t.duration_hours != null ? t.duration_hours : null,
    t.active !== false && t.active !== 0 ? 1 : 0,
    t.sort != null ? t.sort : 0,
  ];
}

function all() { return S.all.all(); }
function byId(id) { return S.byId.get(id); }
function publicActive() { return S.publicActive.all(); }
// B2B AutoCreate: тир по количеству прокси — is_default строки, min_proxies DESC.
function defaultForCount(count) {
  const rows = S.defaults.all();
  for (const r of rows) { if (count >= r.min_proxies) return r; }
  return null;
}
function insert(t) { return S.insert.run(..._params(t)); }
function update(id, t) { return S.update.run(..._params(t), id); }
function remove(id) { return S.remove.run(id); }
function count() { return S.count.get().cnt; }

// Одноразовая data-миграция (Р36): appSettings.pricing_tiers → tariffs.
// Идемпотентно: сидим только в пустую таблицу. Тиры — B2B-дефолты:
// public=0, is_default=1, type='per_modem'. Возвращает число вставленных строк.
function seedFromPricingTiers(tiers) {
  if (!Array.isArray(tiers) || !tiers.length || count() > 0) return 0;
  let n = 0;
  for (const t of tiers) {
    insert({
      name: t.label || ('от ' + t.min_proxies + ' прокси'),
      type: 'per_modem', geo: 'RU', server: '',
      price: t.price, min_proxies: t.min_proxies || 1,
      public: 0, is_default: 1, sort: n,
    });
    n++;
  }
  return n;
}

module.exports = {
  init, all, byId, publicActive, defaultForCount,
  insert, update, remove, count, seedFromPricingTiers,
};
