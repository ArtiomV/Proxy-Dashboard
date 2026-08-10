#!/usr/bin/env node
'use strict';
//
// reconcile-payments.js — сверка legacy-таблицы `payments` с billing_ledger
// перед её дропом (ТЗ C5b). Запускается оператором НА ПРОДЕ до применения
// migrations/manual/056_drop_payments.sql.
//
// Для каждого клиента сравнивает:
//   legacy = Σ payments.amount
//   ledger = Σ (payment + bank_payment) − Σ payment_reversal   (billing_ledger)
// Расхождения — список для ручной доимпортации в billing_ledger
// (atomicCredit типа payment задатированный на дату legacy-платежа).
//
// Использование:
//   node scripts/reconcile-payments.js [--db <path>] [--out <report.json>]
//
// Без --db берёт DASHBOARD_DB_PATH или ./dashboard.db. Read-only, ничего не
// пишет в БД. Exit code: 0 — расхождений нет (можно дропать), 1 — есть
// расхождения (список в отчёте), 2 — ошибка запуска.

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const EPSILON = 0.01;   // копейки: float-сравнение сумм

// Чистая логика сравнения — покрыта unit-тестом
// (tests/reconcile-payments.test.js). Принимает открытый better-sqlite3
// инстанс, возвращает { clients, totals } — по строке на клиента, где
// legacy или ledger ненулевые.
function comparePayments(db) {
  const hasPayments = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='payments'"
  ).get();
  if (!hasPayments) {
    return { paymentsTableMissing: true, clients: [], totals: { legacy: 0, ledger: 0 } };
  }
  const rows = db.prepare(`
    SELECT client_id,
           SUM(legacy_amount) AS legacy,
           SUM(ledger_amount) AS ledger
    FROM (
      SELECT client_id, amount AS legacy_amount, 0 AS ledger_amount
        FROM payments
      UNION ALL
      SELECT client_id, 0,
             CASE WHEN type IN ('payment','bank_payment') THEN amount
                  WHEN type = 'payment_reversal' THEN -amount
                  ELSE 0 END
        FROM billing_ledger
    )
    GROUP BY client_id
    HAVING ABS(legacy) > 0 OR ABS(ledger) > 0
    ORDER BY client_id
  `).all();
  const clients = rows.map(r => ({
    client_id: r.client_id,
    legacy: Math.round((r.legacy || 0) * 100) / 100,
    ledger: Math.round((r.ledger || 0) * 100) / 100,
    diff: Math.round(((r.ledger || 0) - (r.legacy || 0)) * 100) / 100,
  }));
  for (const c of clients) c.match = Math.abs(c.diff) <= EPSILON;
  const totals = {
    legacy: Math.round(clients.reduce((s, c) => s + c.legacy, 0) * 100) / 100,
    ledger: Math.round(clients.reduce((s, c) => s + c.ledger, 0) * 100) / 100,
  };
  return { paymentsTableMissing: false, clients, totals };
}

function main(argv) {
  const args = argv.slice(2);
  const opt = (name, dflt) => {
    const i = args.indexOf(name);
    return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
  };
  const dbPath = opt('--db', process.env.DASHBOARD_DB_PATH || path.join(__dirname, '..', 'dashboard.db'));
  const outPath = opt('--out', null);

  if (!fs.existsSync(dbPath)) {
    console.error(`[reconcile] DB not found: ${dbPath}`);
    process.exit(2);
  }
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  let report;
  try {
    const clientNames = new Map(
      db.prepare('SELECT id, name FROM clients').all().map(r => [r.id, r.name])
    );
    report = comparePayments(db);
    for (const c of report.clients) c.client_name = clientNames.get(c.client_id) || null;
  } finally {
    db.close();
  }

  if (report.paymentsTableMissing) {
    console.log('[reconcile] Таблицы payments нет — сверка не нужна, дроп уже применён (или не требуется).');
    process.exit(0);
  }

  const mismatches = report.clients.filter(c => !c.match);
  report.generated_at = new Date().toISOString();
  report.db = dbPath;
  report.mismatches = mismatches.length;

  console.log(`[reconcile] Клиентов с платежами: ${report.clients.length}`);
  console.log(`[reconcile] Σ legacy payments: ${report.totals.legacy} ₽ · Σ ledger: ${report.totals.ledger} ₽`);
  if (mismatches.length === 0) {
    console.log('[reconcile] OK — расхождений нет. Можно применять migrations/manual/056_drop_payments.sql.');
  } else {
    console.log(`[reconcile] РАСХОЖДЕНИЯ: ${mismatches.length} клиент(ов) — доимпортировать в billing_ledger ДО дропа:`);
    for (const c of mismatches) {
      console.log(`  ${c.client_id}  ${c.client_name || '?'}\tlegacy=${c.legacy}  ledger=${c.ledger}  diff=${c.diff}`);
    }
  }
  if (outPath) {
    fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
    console.log(`[reconcile] Отчёт записан: ${outPath}`);
  }
  process.exit(mismatches.length === 0 ? 0 : 1);
}

if (require.main === module) {
  try {
    main(process.argv);
  } catch (e) {
    console.error('[reconcile] FAILED: ' + (e.stack || e.message));
    process.exit(2);
  }
}

module.exports = { comparePayments };
