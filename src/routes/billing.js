'use strict';
//
// src/routes/billing.js — admin-driven billing operations (Stage 3).
//
// Two routes, both admin-only:
//   POST /api/admin/run_billing   — kick off daily billing job (sync=1 to wait)
//   POST /api/admin/billing_rerun — recompute a past day's charges
//
// monthly_costs / billing/reconciliation / finance_dashboard stay in
// server.js for now (each is 100-300 lines of bespoke logic; extraction
// is mechanical but high-noise — they'll move in a follow-up commit).

const express = require('express');

module.exports = function createBillingRouter(deps) {
  const {
    db, logger, authMiddleware, adminMiddleware,
    runDailyBilling, _startJob,
    getMoscowToday, getClientBytesForMskDate, trafficBytesToGb,
    atomicDebit, saveClients, modemPlural, logActivity, auditLog,
    getClients,
  } = deps;
  const r = express.Router();

  r.post('/api/admin/run_billing', authMiddleware, adminMiddleware, async (req, res) => {
    try {
      // sync=1 → wait for completion (preserves old behavior).
      // default async — returns immediately with job ID.
      if (req.query.sync === '1') {
        await runDailyBilling();
        return res.json({ ok: true });
      }
      const jobId = _startJob('run_billing', () => runDailyBilling());
      res.json({ ok: true, jobId, status_url: `/api/admin/jobs/${jobId}` });
    } catch (_e) { res.status(500).json({ error: 'Internal error' }); }
  });

  // Re-run billing for a specific past MSK date.
  // Use case: a ProxySmart server was offline at midnight, its yesterday counters
  // reset to 0, and the original daily billing produced empty / partial charges.
  // This recomputes from the durable traffic_hourly source.
  //
  // Body: { date: "YYYY-MM-DD", client_ids?: [string], dry_run?: bool }
  // - date is required and must be in the past (today is still active)
  // - client_ids optional; if omitted, processes all clients without an existing charge
  // - dry_run prints what would happen without writing
  r.post('/api/admin/billing_rerun', authMiddleware, adminMiddleware, async (req, res) => {
    try {
      const date = String((req.body && req.body.date) || '').trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'date YYYY-MM-DD required' });
      const today = getMoscowToday();
      if (date >= today) return res.status(400).json({ error: 'date must be strictly in the past' });

      const targetClientIds = Array.isArray(req.body && req.body.client_ids) ? new Set(req.body.client_ids) : null;
      const dryRun = !!(req.body && req.body.dry_run);

      // Already-charged client ids for that date
      const alreadyCharged = new Set(
        db.prepare("SELECT DISTINCT client_id FROM billing_ledger WHERE type='charge' AND date = ?").all(date).map(rr => rr.client_id)
      );

      const dt = new Date(date + 'T12:00:00Z');
      const dateLabel = dt.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' });
      const daysInMonth = new Date(dt.getUTCFullYear(), dt.getUTCMonth() + 1, 0).getDate();

      const report = [];
      let charged = 0, skipped = 0, totalCost = 0;

      const clients = getClients();
      for (const client of clients) {
        if (targetClientIds && !targetClientIds.has(client.id)) continue;
        if (!client.portName || !client.price || client.price <= 0 || client.billingPaused) {
          report.push({ client_id: client.id, name: client.name, status: 'skip', reason: 'no_billing' });
          skipped++; continue;
        }
        if (alreadyCharged.has(client.id)) {
          report.push({ client_id: client.id, name: client.name, status: 'skip', reason: 'already_billed' });
          skipped++; continue;
        }

        const deltaBytes = getClientBytesForMskDate(client.portName, date);
        const deltaGb = trafficBytesToGb(deltaBytes);

        if (deltaBytes <= 0) {
          report.push({ client_id: client.id, name: client.name, status: 'skip', reason: 'no_traffic' });
          skipped++; continue;
        }

        let cost = 0;
        let modemCount = 0;
        if (client.billingType === 'per_modem') {
          // Modem count from traffic_hourly distinct nicks for that day
          modemCount = db.prepare(`
            SELECT COUNT(DISTINCT nick) as n FROM traffic_hourly
            WHERE client_name = ?
              AND substr(datetime(hour_start, '+3 hours'), 1, 10) = ?
          `).get(client.portName, date).n || 0;
          cost = (client.price * modemCount) / daysInMonth;
        } else {
          cost = client.price * deltaGb;
        }
        cost = Math.round(cost * 100) / 100;
        if (cost <= 0) { skipped++; continue; }

        if (dryRun) {
          report.push({ client_id: client.id, name: client.name, status: 'would_charge', gb: deltaGb, cost });
          continue;
        }

        // Charges always proceed; only enforce admin-set hard floor if any.
        let minBalance = null;
        if (typeof client.maxDebt === 'number' && client.maxDebt > 0) {
          minBalance = -Math.abs(client.maxDebt);
        }

        try {
          const debitRes = atomicDebit(client.id, cost, {
            type: 'charge',
            date,
            timestamp: new Date().toISOString(),
            delta_bytes: Math.round(deltaBytes),
            delta_gb: deltaGb,
            price_per_unit: client.price,
            billing_type: client.billingType || 'per_gb',
            modem_count: modemCount || null,
            days_in_month: daysInMonth,
            cost,
            currency: client.currency || 'RUB',
            note: client.billingType === 'per_modem'
              ? `Списание за аренду ${modemCount} ${modemPlural(modemCount)} (${dateLabel}) — recomputed`
              : `Списание за трафик (${dateLabel}) — recomputed`,
            traffic_source: 'billing_rerun'
          }, { minBalance });

          if (debitRes && debitRes.duplicate) {
            report.push({ client_id: client.id, name: client.name, status: 'skip', reason: 'duplicate_at_db' });
            skipped++; continue;
          }
          report.push({ client_id: client.id, name: client.name, status: 'charged', gb: deltaGb, cost, balance_after: debitRes.balanceAfter });
          charged++; totalCost += cost;
          logActivity('billing', 'info', 'billing_rerun_charge', client.name,
            `Rerun charge ${cost} ${client.currency || 'RUB'} for ${deltaGb}GB on ${date}`,
            { client_id: client.id, gb: deltaGb, cost, date });
        } catch (e) {
          if (e && e.code === 'INSUFFICIENT_BALANCE') {
            report.push({ client_id: client.id, name: client.name, status: 'fail', reason: 'insufficient_balance', cost });
          } else {
            report.push({ client_id: client.id, name: client.name, status: 'error', error: e.message });
            logger.error(`[Billing rerun] ${client.name}:`, e.message);
          }
        }
      }

      if (!dryRun && charged > 0) saveClients(clients);

      logger.info(`[Billing rerun] date=${date} charged=${charged} skipped=${skipped} total=${totalCost.toFixed(2)} dry=${dryRun}`);
      auditLog(req.user.login, 'billing_rerun', { date, charged, skipped, total: totalCost, dry_run: dryRun });
      res.json({ ok: true, date, charged, skipped, total_cost: Math.round(totalCost * 100) / 100, dry_run: dryRun, report });
    } catch (e) {
      logger.error('[billing_rerun]', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  return r;
};
