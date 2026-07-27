'use strict';
//
// src/jobs/sla.js — SLA-метрики клиентов и ежедневная проверка нарушений.
// Extracted from server.js (Stage 9) — код перенесён без изменения логики.
//
// computeClientSlaMetrics(client): uptime за 30 дней (polling, тот же сигнал
// uptimeTracking, что и per-modem health) + latency/error за 24ч (proxy_checks).
// runSlaCheck(): сравнивает метрики с порогами клиента, пишет нарушения в
// sla_violations (идемпотентно по дню) и, при slaAutoCredit, начисляет кредит.

function create(deps) {
  const {
    trackingDb, uptimeTracking, getClients, getMoscowToday,
    atomicCredit, logger, logActivity,
  } = deps;

  // Uptime is measured over 30 days (contractual SLA horizon).
  // Latency and error_pct use last 24 h (current service quality).
  // Returns { uptime_pct, avg_latency_ms, error_pct, total_checks } or null if no data.
  function computeClientSlaMetrics(client) {
    if (!client.portName) return null;
    // Latency + error rate (24 h)
    const checks = trackingDb.slaClientChecks24hStmt().get(client.portName);

    // Uptime over 30 days — polling-based, aggregated across the client's modems.
    // Uses the same uptimeTracking source as the per-modem health score so all
    // dashboard uptime numbers are computed from one canonical signal (5-min
    // ping checks against ProxySmart). Replaces the old traffic-based formula
    // which inflated downtime whenever clients didn't transmit traffic.
    const UPTIME_DAYS = 30;
    const utCutoffDate = new Date(Date.now() - UPTIME_DAYS * 86400000).toISOString().slice(0, 10);

    // Find this client's modems (any that produced proxy_check rows in the window).
    // Includes the IMEI for the uptimeTracking lookup.
    const clientModems = trackingDb.slaClientModemsStmt().all(client.portName, `-${UPTIME_DAYS} days`);

    let upOnline = 0, upTotal = 0;
    for (const mm of clientModems) {
      if (!mm.imei) continue;
      const ut = uptimeTracking[mm.server_name + '_' + mm.imei];
      if (!ut || !ut.daily) continue;
      for (const d in ut.daily) {
        if (d >= utCutoffDate) {
          upOnline += ut.daily[d].online || 0;
          upTotal  += ut.daily[d].total  || 0;
        }
      }
    }

    if (checks.total === 0 && upTotal === 0) return null;
    const uptimePct = upTotal > 0 ? Math.round(upOnline / upTotal * 1000) / 10 : null;
    const errorPct = checks.total > 0 ? Math.round(checks.errors / checks.total * 1000) / 10 : 0;
    return {
      uptime_pct: uptimePct,
      uptime_window_days: UPTIME_DAYS,
      uptime_online_checks: upOnline,
      uptime_total_checks: upTotal,
      avg_latency_ms: checks.avg_ms != null ? Math.round(checks.avg_ms) : null,
      error_pct: errorPct,
      total_checks: checks.total
    };
  }

  // Evaluate SLA, write violations to DB. Optionally auto-credit.
  async function runSlaCheck() {
    try {
      const today = getMoscowToday();
      let violationsCount = 0, creditsCount = 0;
      const insertViolation = trackingDb.slaInsertViolationStmt();
      const existsStmt = trackingDb.slaExistsViolationStmt();

      for (const client of getClients()) {
        if (!client.portName || !client.price) continue;
        const m = computeClientSlaMetrics(client);
        if (!m) continue;
        const breaches = [];
        if (m.uptime_pct != null && client.slaUptimePct != null && m.uptime_pct < client.slaUptimePct) {
          breaches.push({ metric: 'uptime', expected: client.slaUptimePct, actual: m.uptime_pct });
        }
        if (m.avg_latency_ms != null && client.slaMaxLatencyMs != null && m.avg_latency_ms > client.slaMaxLatencyMs) {
          breaches.push({ metric: 'latency', expected: client.slaMaxLatencyMs, actual: m.avg_latency_ms });
        }
        if (m.error_pct != null && client.slaMaxErrorPct != null && m.error_pct > client.slaMaxErrorPct) {
          breaches.push({ metric: 'errors', expected: client.slaMaxErrorPct, actual: m.error_pct });
        }
        for (const b of breaches) {
          // Skip if already logged today
          if (existsStmt.get(client.id, today, b.metric)) continue;
          // Auto-credit: 1% of daily rate per breach (per_gb only, cap at 10%)
          let credit = 0;
          if (client.slaAutoCredit && client.price > 0 && client.billingType === 'per_gb') {
            credit = Math.min(client.price * 0.01, client.price * 0.1);
            credit = Math.round(credit * 100) / 100;
            if (credit > 0) {
              try {
                atomicCredit(client.id, credit, {
                  type: 'adjustment',
                  date: today,
                  timestamp: new Date().toISOString(),
                  amount: credit,
                  currency: client.currency || 'RUB',
                  note: `SLA кредит: ${b.metric} ${b.actual} (норма ${b.expected})`,
                  traffic_source: 'sla_auto'
                });
                creditsCount++;
              } catch (e) {
                logger.error(`[SLA] credit error for ${client.name}:`, e.message);
                credit = 0;
              }
            }
          }
          insertViolation.run(client.id, today, b.metric, b.expected, b.actual, credit);
          violationsCount++;
          logger.warn(`[SLA] ${client.name} breach: ${b.metric} actual=${b.actual} expected=${b.expected} credit=${credit}`);
        }
      }
      if (violationsCount > 0 || creditsCount > 0) {
        logActivity('system', 'warn', 'sla_check', null,
          `SLA check: ${violationsCount} breaches, ${creditsCount} credits applied`,
          { violations: violationsCount, credits: creditsCount, date: today });
      }
    } catch (e) {
      logger.error('[SLA]', e.message);
    }
  }

  return { computeClientSlaMetrics, runSlaCheck };
}

module.exports = { create };
