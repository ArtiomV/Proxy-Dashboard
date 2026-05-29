'use strict';
// src/db/operators.js — operator_country_map repository (Stage 17).
//
// Manual rows always win over auto; the rule is enforced in
// `upsertAuto()` — we never overwrite a 'manual' row from the auto path.
// Manual writes use `setManual()` which is unconditional.

let S = {};

function init(db) {
  S.upsertAuto = db.prepare(`
    INSERT INTO operator_country_map (operator, country, source, first_seen_on, updated_at)
    VALUES (?, ?, 'auto', ?, datetime('now'))
    ON CONFLICT(operator) DO UPDATE SET
      country = CASE WHEN operator_country_map.source = 'manual'
                     THEN operator_country_map.country
                     ELSE excluded.country END,
      updated_at = CASE WHEN operator_country_map.source = 'manual'
                        THEN operator_country_map.updated_at
                        ELSE excluded.updated_at END
  `);
  S.setManual = db.prepare(`
    INSERT INTO operator_country_map (operator, country, source, updated_at)
    VALUES (?, ?, 'manual', datetime('now'))
    ON CONFLICT(operator) DO UPDATE SET
      country = excluded.country,
      source = 'manual',
      updated_at = excluded.updated_at
  `);
  S.delete = db.prepare(`DELETE FROM operator_country_map WHERE operator = ?`);
  S.all = db.prepare(`SELECT operator, country, source, updated_at, first_seen_on FROM operator_country_map ORDER BY country, operator`);
  S.get = db.prepare(`SELECT operator, country, source FROM operator_country_map WHERE operator = ?`);
}

function upsertAuto(operator, country, firstSeenOn) {
  if (!operator || !country) return;
  return S.upsertAuto.run(operator.toLowerCase().trim(), country, firstSeenOn || '');
}

function setManual(operator, country) {
  if (!operator || !country) return;
  return S.setManual.run(operator.toLowerCase().trim(), country);
}

function remove(operator) {
  if (!operator) return;
  return S.delete.run(operator.toLowerCase().trim());
}

function listAll() { return S.all.all(); }
function getOne(operator) { return S.get.get(operator.toLowerCase().trim()); }

module.exports = { init, upsertAuto, setManual, remove, listAll, getOne };
