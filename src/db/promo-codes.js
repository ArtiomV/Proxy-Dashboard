'use strict';
// src/db/promo-codes.js — repository for `promo_codes` (WP6, Этап 7).
//
// Семантика типов (деньги остаются единой моделью — бонус всегда зачисление
// на баланс через atomicCredit type='promo_bonus'):
//   percent    — +value% к сумме пополнения (topup)
//   fixed      — +value ₽ к пополнению (topup)
//   bonus_days — +value дней при покупке (buy_proxy): зачисляется эквивалент
//                tariff.price/30.4 × value на баланс после выдачи порта
//
// consume() атомарен: UPDATE ... WHERE used < max_uses — гонка двух
// одновременных применений не уйдёт за лимит (SQLite — один писатель, §Г.5).

let S = {};

function init(db) {
  S.list = db.prepare('SELECT * FROM promo_codes ORDER BY id DESC');
  S.byCode = db.prepare('SELECT * FROM promo_codes WHERE code = ? COLLATE NOCASE');
  S.insert = db.prepare('INSERT INTO promo_codes (code, type, value, max_uses, expires_at, active) VALUES (?, ?, ?, ?, ?, ?)');
  S.setActive = db.prepare('UPDATE promo_codes SET active = ? WHERE id = ?');
  S.remove = db.prepare('DELETE FROM promo_codes WHERE id = ?');
  S.consume = db.prepare(`UPDATE promo_codes SET used = used + 1
    WHERE id = ? AND active = 1 AND (max_uses IS NULL OR used < max_uses)`);
}

// Находит код и проверяет применимость. Возвращает { promo } или { error }.
function findValid(code) {
  const promo = S.byCode.get(String(code || '').trim());
  if (!promo) return { error: 'Промокод не найден' };
  if (!promo.active) return { error: 'Промокод отключён' };
  if (promo.expires_at && promo.expires_at < new Date().toISOString()) return { error: 'Промокод истёк' };
  if (promo.max_uses != null && promo.used >= promo.max_uses) return { error: 'Промокод исчерпан' };
  return { promo };
}

// Атомарно списывает одно применение. false → лимит исчерпан/отключён.
function consume(promoId) {
  return S.consume.run(promoId).changes > 0;
}

function create({ code, type, value, max_uses = null, expires_at = null }) {
  return S.insert.run(String(code).trim(), type, value, max_uses, expires_at, 1).lastInsertRowid;
}

module.exports = { init, list: () => S.list.all(), findValid, consume, create,
  setActive: (id, on) => S.setActive.run(on ? 1 : 0, id), remove: (id) => S.remove.run(id) };
