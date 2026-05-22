'use strict';
//
// src/jobs/crm-sync.js — periodic Crossroad CRM payment sync (DoD #1).
//
// Extracted from server.js. Connects to a PostgreSQL CRM workspace,
// pulls opportunity rows where the operator manually flipped
// `paymentConfirmed`, advances `lastPaymentDate` to now + clears the
// flag + sets `nextPaymentDate` to one month forward. Also logs a
// reminder for any deal whose next-payment date falls within
// `appSettings.crm_reminder_days` (default 3 days).
//
// The `pg` module is OPTIONAL — fresh deployments without it should
// not error out. A MODULE_NOT_FOUND from `require('pg')` is caught and
// the function silently no-ops.

function create(deps) {
  const {
    logger, logActivity,
    CRM_DB_URL, CRM_WS,
    getAppSettings,
  } = deps;

  async function checkCrmPaymentConfirmations() {
    let pgClient;
    try {
      const { Client } = require('pg');
      pgClient = new Client({ connectionString: CRM_DB_URL });
      await pgClient.connect();

      // Find deals where paymentConfirmed = true.
      const confirmed = await pgClient.query(
        `SELECT id, name, "nextPaymentDate", "companyId" FROM "${CRM_WS}".opportunity WHERE "paymentConfirmed" = true AND "deletedAt" IS NULL`
      );

      for (const deal of confirmed.rows) {
        const now = new Date();
        const nextPayment = new Date(now);
        nextPayment.setMonth(nextPayment.getMonth() + 1); // JS handles overflow: Jan 31 → Feb 28
        await pgClient.query(
          `UPDATE "${CRM_WS}".opportunity SET "lastPaymentDate" = $1, "nextPaymentDate" = $2, "paymentConfirmed" = false, "updatedAt" = $1 WHERE id = $3`,
          [now.toISOString(), nextPayment.toISOString(), deal.id]
        );
        logger.info(`[CRM] Payment confirmed for deal "${deal.name}": next payment ${nextPayment.toISOString().slice(0, 10)}`);
        logActivity('system', 'info', 'crm_payment_confirmed', deal.name, `Payment confirmed, next: ${nextPayment.toISOString().slice(0, 10)}`);
      }

      // Reminder log for deals due within crm_reminder_days.
      const settings = getAppSettings();
      const reminderDays = settings.crm_reminder_days || 3;
      const reminderDate = new Date(Date.now() + reminderDays * 86400000);
      const upcoming = await pgClient.query(
        `SELECT o.id, o.name, o."nextPaymentDate", o.amount, c.name as company_name
         FROM "${CRM_WS}".opportunity o
         LEFT JOIN "${CRM_WS}".company c ON o."companyId" = c.id
         WHERE o."nextPaymentDate" IS NOT NULL AND o."nextPaymentDate" <= $1 AND o."nextPaymentDate" >= NOW()
         AND o.stage = 'AKTIVNYY_KLIENT' AND o."deletedAt" IS NULL`,
        [reminderDate.toISOString()]
      );

      if (upcoming.rows.length > 0) {
        logger.info(`[CRM] Payment reminders (due within ${reminderDays} days):`);
        for (const deal of upcoming.rows) {
          const dueDate = new Date(deal.nextPaymentDate).toISOString().slice(0, 10);
          logger.info(`  - ${deal.company_name || deal.name}: ${deal.amount || '?'} RUB, due ${dueDate}`);
        }
      }

      await pgClient.end();
    } catch (e) {
      if (pgClient) try { await pgClient.end(); } catch (_) { /* best-effort */ }
      // pg module might not be installed — skip silently.
      if (e.code !== 'MODULE_NOT_FOUND') {
        logger.error('[CRM] Payment check error:', e.message);
      }
    }
  }

  return { checkCrmPaymentConfirmations };
}

module.exports = { create };
