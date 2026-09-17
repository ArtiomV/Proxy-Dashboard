'use strict';
//
// src/billing/recurring-costs.js — плановые (повторяющиеся) расходы.
//
// Замена неявного «шаблона из последнего заполненного месяца»: повторение
// задаётся явными правилами recurring_costs с диапазоном [start_period,
// end_period||бессрочно]. monthly_costs хранит только разовые суммы и
// override на конкретный месяц — POST monthly_costs правила НИКОГДА не
// трогает, поэтому плановые операции не меняются при сохранении месяца.

const PERIOD_RE = /^\d{4}-\d{2}$/;
const VALID_CURRENCIES = new Set(['RUB', 'MDL', 'RON']);
// Открытый диапазон (end_period IS NULL) сравниваем как «до бесконечности».
const OPEN_END = '9999-12';

function currentPeriod() {
  return new Date().toISOString().slice(0, 7);
}

function _key(category, subkey) {
  return category + '|' + (subkey == null ? '' : String(subkey));
}

function _byKey(a, b) {
  const ka = _key(a.category, a.subkey), kb = _key(b.category, b.subkey);
  return ka < kb ? -1 : ka > kb ? 1 : 0;
}

// Эффективные расходы месяца: активные правила + разовые строки.
// Разовая строка с тем же (category, subkey) перезаписывает правило
// (source='override'); без совпадения — разовый расход (source='once').
function resolveMonthlyCosts(db, period) {
  const oneOffs = db.prepare(`SELECT id, period, category, subkey, amount, currency, qty, notes, updated_at
    FROM monthly_costs WHERE period = ? ORDER BY category, subkey`).all(period);
  const rules = db.prepare(`SELECT id AS rule_id, category, subkey, amount, currency, qty, notes, start_period, end_period
    FROM recurring_costs
    WHERE start_period <= ? AND (end_period IS NULL OR end_period >= ?)
    ORDER BY category, subkey`).all(period, period);
  const merged = new Map();
  for (const rule of rules) {
    merged.set(_key(rule.category, rule.subkey), {
      id: null, period, category: rule.category, subkey: rule.subkey,
      amount: rule.amount, currency: rule.currency, qty: rule.qty, notes: rule.notes,
      updated_at: null, source: 'rule', rule_id: rule.rule_id,
    });
  }
  for (const row of oneOffs) {
    const k = _key(row.category, row.subkey);
    const prev = merged.get(k);
    merged.set(k, Object.assign({}, row, {
      source: prev ? 'override' : 'once',
      rule_id: prev ? prev.rule_id : null,
    }));
  }
  const effective = [...merged.values()].sort(_byKey);
  return { oneOffs, rules, effective };
}

// Все правила (для управления в UI), включая завершённые и будущие.
function listAllRules(db) {
  return db.prepare(`SELECT id, category, subkey, amount, currency, qty, notes,
      start_period, end_period, created_at, updated_at
    FROM recurring_costs ORDER BY category, subkey, start_period`).all();
}

// Валидация тела POST/PUT. Возвращает { error } или { rule } с
// нормализованными полями. excludeId — правило, которое правим (его
// собственный диапазон не считается конфликтом).
function validateRuleInput(db, COST_CATEGORIES, body, { excludeId } = {}) {
  const b = body || {};
  const category = String(b.category || '');
  if (!COST_CATEGORIES[category]) return { error: 'category: допустимо ' + Object.keys(COST_CATEGORIES).join(' | ') };

  const subkey = (b.subkey == null || String(b.subkey).trim() === '') ? null : String(b.subkey).trim().slice(0, 200);

  const amount = Number(b.amount);
  if (!Number.isFinite(amount) || amount <= 0) return { error: 'amount: конечное число > 0' };

  const currency = String(b.currency || 'RUB');
  if (!VALID_CURRENCIES.has(currency)) return { error: 'currency: допустимо RUB | MDL | RON' };

  let qty = null;
  if (b.qty != null && b.qty !== '') {
    qty = Number(b.qty);
    if (!Number.isFinite(qty) || qty < 0) return { error: 'qty: число >= 0 или пусто' };
  }

  const start = String(b.start_period || '');
  if (!PERIOD_RE.test(start)) return { error: 'start_period: формат YYYY-MM' };

  let end = null;
  if (b.end_period != null && b.end_period !== '') {
    end = String(b.end_period);
    if (!PERIOD_RE.test(end)) return { error: 'end_period: формат YYYY-MM или пусто' };
    if (end < start) return { error: 'end_period не может быть раньше start_period' };
  }

  const notes = (b.notes || '').slice(0, 500);

  // Диапазоны правил одного (category, subkey) не должны пересекаться —
  // иначе месяц получил бы два «плановых» значения одной статьи.
  const others = db.prepare(`SELECT id, start_period, end_period FROM recurring_costs
    WHERE category = ? AND COALESCE(subkey, '') = ?`).all(category, subkey == null ? '' : subkey);
  const newEnd = end || OPEN_END;
  for (const o of others) {
    if (excludeId != null && o.id === excludeId) continue;
    const oEnd = o.end_period || OPEN_END;
    if (start <= oEnd && o.start_period <= newEnd) {
      return { error: `диапазон пересекается с правилом #${o.id} (${o.start_period} — ${o.end_period || 'бессрочно'})` };
    }
  }

  return { rule: { category, subkey, amount, currency, qty, notes, start_period: start, end_period: end } };
}

module.exports = { resolveMonthlyCosts, listAllRules, validateRuleInput, currentPeriod };
