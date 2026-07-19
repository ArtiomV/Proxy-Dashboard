'use strict';
// Balance-vs-ledger helpers. Two DIFFERENT questions live here — do not mix:
//
//   ledgerFinalBalance()  — «какой баланс по мнению реестра СЕЙЧАС».
//     Контракт инкрементального баланса: последняя строка со снапшотами несёт
//     авторитетный balance_after. Это ЕДИНСТВЕННАЯ корректная величина для
//     сверки client.balance и для пересчёта после удаления записи.
//
//   recalcFromLedger()    — полный реплей Σ(after−before) поверх якоря.
//     НЕ пригоден для enforcement: реестр легитимно содержит межстрочные
//     разрывы цепочки (удалённые записи, ретро-вставки бэкфилла 01.04.2026,
//     ручные adjustments майского инцидента ВАЙЛДБОКС 21–24.05), а реплей
//     их игнорирует — на ВАЙЛДБОКС давал +3.3M вместо −138k. Оставлен как
//     диагностика «что было бы при непрерывной цепочке» и для теста P1-1.
//
//   findChainBreaks()     — где цепочка снапшотов рвётся (prev.after ≠ next.before).
//     Исторические разрывы — известная данность; НОВЫЙ разрыв = сигнал, что
//     запись удалили/вставили мимо канонического пути.
const DEBIT_TYPES = new Set(['charge', 'debit', 'traffic_charge', 'daily_charge', 'expense']);
// Типы, у которых знак НЕ выводится из type: amount хранится без знака, а
// направление живёт только в снапшотах (ledger sign convention).
const SIGN_AMBIGUOUS_TYPES = new Set(['correction', 'manual_charge', 'adjustment']);

const round2 = v => Math.round(v * 100) / 100;

// Дельта одной записи: авторитетно из снапшотов; для строк без снапшотов —
// догадка по типу; null, если знак неопределим (амбивалентный тип без снапшотов).
function entryDelta(row) {
  if (row.balance_before != null && row.balance_after != null) {
    return round2(row.balance_after - row.balance_before);
  }
  if (SIGN_AMBIGUOUS_TYPES.has(row.type)) return null;
  const a = row.amount || 0;
  return DEBIT_TYPES.has(row.type) ? -a : a;
}

// «Финальное слово реестра»: balance_after последней строки со снапшотами,
// плюс типизированные дельты хвостовых строк без снапшотов (на практике хвост
// пуст — все живые писатели давно пишут снапшоты). Пустой реестр → 0.
function ledgerFinalBalance(db, clientId) {
  const rows = db.prepare(`
    SELECT id, type, amount, balance_before, balance_after
    FROM billing_ledger WHERE client_id = ? ORDER BY id ASC
  `).all(clientId);
  if (!rows.length) return 0;
  let anchorIdx = -1;
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i].balance_before != null && rows[i].balance_after != null) { anchorIdx = i; break; }
  }
  if (anchorIdx === -1) {
    // Полностью легаси-реестр без единого снапшота: остаётся только реплей.
    return recalcFromLedger(db, clientId);
  }
  let bal = rows[anchorIdx].balance_after;
  for (let i = anchorIdx + 1; i < rows.length; i++) {
    const d = entryDelta(rows[i]);
    bal += (d == null ? 0 : d);   // неоднозначный хвост: 0 честнее, чем неверный знак
  }
  return round2(bal);
}

// Разрывы цепочки: соседние (по id) снапшотнутые строки, где prev.balance_after
// ≠ next.balance_before. Строки без снапшотов цепочку не рвут (не с чем стыковать).
function findChainBreaks(db, clientId) {
  const rows = db.prepare(`
    SELECT id, balance_before, balance_after
    FROM billing_ledger WHERE client_id = ? ORDER BY id ASC
  `).all(clientId);
  const breaks = [];
  let prev = null;   // { id, after }
  for (const r of rows) {
    if (r.balance_before == null || r.balance_after == null) continue;
    if (prev && Math.abs(r.balance_before - prev.after) > 0.01) {
      breaks.push({ prevId: prev.id, nextId: r.id, jump: round2(r.balance_before - prev.after) });
    }
    prev = { id: r.id, after: r.balance_after };
  }
  return breaks;
}

// Полный реплей (историческая формула Stage 18.8 / WP5). См. шапку файла:
// только диагностика, НЕ использовать для записи баланса.
function recalcFromLedger(db, clientId) {
  const rows = db.prepare(`
    SELECT type, amount, balance_before, balance_after
    FROM billing_ledger WHERE client_id = ? ORDER BY id ASC
  `).all(clientId);
  if (!rows.length) return 0;
  // P1-1: anchor on the FIRST entry's balance_before instead of assuming 0.
  // If a client had an opening balance set outside the ledger (import, manual
  // SQL, pre-ledger era), starting from 0 would silently wipe that remainder.
  let bal = (rows[0].balance_before != null) ? rows[0].balance_before : 0;
  for (const r of rows) {
    if (r.balance_before != null && r.balance_after != null) {
      bal += (r.balance_after - r.balance_before);   // authoritative snapshot delta
    } else {
      const a = r.amount || 0;
      if (DEBIT_TYPES.has(r.type)) bal -= a; else bal += a;
    }
  }
  return round2(bal);
}

module.exports = { ledgerFinalBalance, findChainBreaks, entryDelta, recalcFromLedger, DEBIT_TYPES, SIGN_AMBIGUOUS_TYPES };
