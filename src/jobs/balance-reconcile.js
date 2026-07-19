'use strict';
// src/jobs/balance-reconcile.js — daily balance-vs-ledger reconciliation (WP5,
// переработан 19.07: сверка по ПОСЛЕДНЕМУ снапшоту + контроль НОВЫХ разрывов).
//
// Контракт инкрементального баланса: client.balance должен совпадать с
// balance_after последней записи реестра (ledgerFinalBalance). Прежняя формула
// Σ(after−before) ложно алертила на исторические разрывы цепочки (ретро-вставки
// бэкфилла 01.04, майский инцидент ВАЙЛДБОКС, удалённые записи) — реестр их
// легитимно содержит, а реплей игнорирует.
//
// Два независимых сигнала:
//   1. drift  — client.balance ≠ финальное слово реестра (>0.01 ₽): деньги
//      в памяти разъехались с аудит-трейлом. Это настоящий «баланс сломался».
//   2. new chain break — в цепочке снапшотов появился разрыв, которого не было
//      в baseline: кто-то удалил/вставил запись мимо канонического пути.
//      Исторические разрывы фиксируются в kv_store при первом запуске и
//      больше не алертят.
//
// OBSERVATION ONLY — never auto-corrects money:
//   → logActivity('billing','critical','balance_drift') + TG alert
//     (rule 'balance_drift', 24h cooldown)
//   → lastResult exposed to /api/admin/health (balance_divergent_clients).
const { ledgerFinalBalance, findChainBreaks } = require('../billing/recalc');

const DRIFT_EPSILON = 0.01;
const KNOWN_BREAKS_KEY = 'reconcile_known_breaks';

function create(deps) {
  const { db, clients, logActivity, logger, alerts } = deps;
  let lastResult = { checkedAt: null, divergent: 0, total: 0, offenders: [], newBreaks: [] };

  const _kvGetStmt = db.prepare('SELECT value FROM kv_store WHERE key = ?');
  const _kvSetStmt = db.prepare(
    "INSERT INTO kv_store (key, value, updated_at) VALUES (?, ?, datetime('now')) " +
    "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')"
  );
  function loadKnownBreaks() {
    try { const r = _kvGetStmt.get(KNOWN_BREAKS_KEY); return r ? JSON.parse(r.value) : null; }
    catch (_) { return null; }
  }
  function saveKnownBreaks(map) {
    try { _kvSetStmt.run(KNOWN_BREAKS_KEY, JSON.stringify(map)); } catch (e) { logger.warn('[BalanceReconcile] baseline save failed: ' + e.message); }
  }

  function runOnce() {
    let divergent = 0, total = 0;
    const offenders = [];
    const newBreaks = [];

    // baseline известных разрывов: { clientId: ["prevId-nextId", …] }.
    // null = первый запуск → зафиксировать текущие разрывы молча.
    let known = loadKnownBreaks();
    const seeding = (known == null);
    if (seeding) known = {};

    for (const c of (clients || [])) {
      total++;
      // Сигнал 1: баланс vs финальное слово реестра.
      let expected;
      try { expected = ledgerFinalBalance(db, c.id); }
      catch (e) { logger.warn('[BalanceReconcile] recalc failed for ' + c.id + ': ' + e.message); continue; }
      const actual = typeof c.balance === 'number' ? c.balance : 0;
      const diff = Math.round((actual - expected) * 100) / 100;
      if (Math.abs(diff) > DRIFT_EPSILON) {
        divergent++;
        offenders.push({ id: c.id, name: c.name, actual, expected, diff });
      }
      // Сигнал 2: новые разрывы цепочки.
      let breaks = [];
      try { breaks = findChainBreaks(db, c.id); } catch (_) { /* таблица может быть пуста */ }
      const keys = breaks.map(b => b.prevId + '-' + b.nextId);
      if (seeding) {
        if (keys.length) known[c.id] = keys;
      } else {
        const knownSet = new Set(known[c.id] || []);
        for (let i = 0; i < breaks.length; i++) {
          if (!knownSet.has(keys[i])) newBreaks.push({ id: c.id, name: c.name, ...breaks[i] });
        }
      }
    }

    if (seeding) {
      saveKnownBreaks(known);
      const n = Object.values(known).reduce((s, a) => s + a.length, 0);
      logger.info(`[BalanceReconcile] baseline seeded: ${n} historical chain break(s) across ${Object.keys(known).length} client(s)`);
    }

    lastResult = {
      checkedAt: new Date().toISOString(), divergent, total,
      offenders: offenders.slice(0, 20), newBreaks: newBreaks.slice(0, 20),
    };

    if (divergent > 0 || newBreaks.length > 0) {
      logger.error(`[BalanceReconcile] drift: ${divergent}/${total}, new chain breaks: ${newBreaks.length}`);
      try {
        logActivity('billing', 'critical', 'balance_drift', null,
          `${divergent} клиент(ов) с дрейфом баланса, ${newBreaks.length} новых разрывов цепочки`,
          { divergent, total, offenders: offenders.slice(0, 10), newBreaks: newBreaks.slice(0, 10) });
      } catch (_) { /* best-effort */ }
      try {
        const lines = [];
        for (const o of offenders.slice(0, 5)) lines.push(`${o.name}: ${o.actual} ≠ ${o.expected} (${o.diff > 0 ? '+' : ''}${o.diff})`);
        for (const b of newBreaks.slice(0, 5)) lines.push(`${b.name}: НОВЫЙ разрыв цепочки #${b.prevId}→#${b.nextId} (скачок ${b.jump > 0 ? '+' : ''}${b.jump})`);
        alerts.trigger('balance_drift', { count: divergent + newBreaks.length, total, offenders: lines.join('\n') });
      } catch (_) { /* best-effort */ }
    } else {
      logger.info(`[BalanceReconcile] OK — ${total} client(s) match ledger, no new chain breaks`);
    }
    return lastResult;
  }

  return { runOnce, getLastResult: () => lastResult, DRIFT_EPSILON, KNOWN_BREAKS_KEY };
}

module.exports = { create };
