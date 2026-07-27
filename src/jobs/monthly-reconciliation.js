'use strict';
//
// src/jobs/monthly-reconciliation.js — ежемесячная сверка биллинга (1-го числа,
// 03:00 UTC): сравнивает сохранённый трафик клиента за прошлый месяц с
// фактически выставленными списаниями и дебитует корректировку, если хранилище
// показывает больше. Extracted from server.js (Stage 9) — без изменения логики.
//
// Денежный путь (HIGH): маркер `last_reconciliation_month` пишется ДО любых
// дебитов — краш посреди цикла не должен привести к повторному прогону и
// дабл-биллингу корректировок.

function create(deps) {
  const {
    logger, logActivity,
    kvGet, kvSet,
    fetchAllServersDataCached, refreshPortKeyMapping,
    getClients, getClientStoredMonthBytes, trafficBytesToGb,
    ledgerDb, appSettings, atomicDebit, saveClients,
    getMoscowNow, getMoscowToday,
  } = deps;

  // Маркер «какой месяц уже сверили» — состояние переехало из server.js.
  let lastReconciliationMonth = (kvGet.get('last_reconciliation_month') || {}).value || '';

  // Runs on 1st of each month at 03:00 UTC (06:00 MSK), before acts generation
  async function runMonthlyReconciliation() {
    const mn = getMoscowNow();

    // Only run on 1st of month
    if (mn.getDate() !== 1) {
      logger.info('[MonthlyRecon] Not 1st of month, skipping');
      return;
    }

    // Guard: don't run twice for same month
    // Previous month is what we reconcile
    const prevMonth = new Date(mn.getFullYear(), mn.getMonth() - 1, 1);
    const prevMonthStr = prevMonth.toLocaleDateString('en-CA').slice(0, 7); // "YYYY-MM"
    if (lastReconciliationMonth === prevMonthStr) {
      logger.info(`[MonthlyRecon] Already reconciled ${prevMonthStr}, skipping`);
      return;
    }

    logger.info(`[MonthlyRecon] Starting reconciliation for ${prevMonthStr}...`);

    // CRITICAL: persist the marker BEFORE any debits, so a crash mid-loop won't
    // cause a re-run on next start (which would double-bill corrections).
    // We accept the small risk of "marked-but-skipped" in exchange for no double-billing.
    kvSet.run('last_reconciliation_month', prevMonthStr);
    lastReconciliationMonth = prevMonthStr;

    // Refresh port mapping (don't swallow — log the failure)
    try {
      const results = await fetchAllServersDataCached();
      refreshPortKeyMapping(results);
    } catch (e) {
      logger.warn('[MonthlyRecon] port mapping refresh failed (using cached):', e.message);
    }

    let corrections = 0;
    for (const client of getClients()) {
      if (!client.portName || !client.price || client.price <= 0) continue;

      // Per-modem clients — fixed rate, just log
      if (client.billingType === 'per_modem') {
        logger.info(`[MonthlyRecon] ${client.name}: per_modem — skipped (fixed rate)`);
        continue;
      }

      const storedBytes = getClientStoredMonthBytes(client.portName, prevMonthStr);
      const storedGb = trafficBytesToGb(storedBytes);

      const entries = ledgerDb.listByClient(client.id);
      const monthCharges = entries.filter(e =>
        (e.type === 'charge' || e.type === 'correction') && e.date && e.date.startsWith(prevMonthStr) &&
        (!e.traffic_source || e.traffic_source !== 'monthly_reconciliation')
      );
      const billedBytes = monthCharges.reduce((s, e) => s + (e.delta_bytes || 0), 0);
      const billedGb = trafficBytesToGb(billedBytes);

      const diffGb = Math.round((storedGb - billedGb) * 1000) / 1000;

      if (diffGb <= (appSettings.reconciliation_tolerance_gb || 0.01)) {
        logger.info(`[MonthlyRecon] ${client.name}: ok (stored=${storedGb}GB, billed=${billedGb}GB)`);
        continue;
      }

      // Correction needed
      const correctionCost = Math.round(diffGb * client.price * 100) / 100;
      if (correctionCost <= 0) continue;

      // Last day of previous month as billing date
      const lastDay = new Date(mn.getFullYear(), mn.getMonth(), 0);
      const lastDayStr = lastDay.toLocaleDateString('en-CA');
      const monthLabel = prevMonth.toLocaleDateString('ru-RU', { month: '2-digit', year: 'numeric' });

      atomicDebit(client.id, correctionCost, {
        type: 'charge',
        date: lastDayStr,
        timestamp: new Date().toISOString(),
        delta_bytes: Math.round((storedBytes - billedBytes)),
        delta_gb: diffGb,
        price_per_unit: client.price,
        billing_type: 'per_gb',
        cost: correctionCost,
        currency: client.currency || 'RUB',
        note: `Корректировка за месяц (${monthLabel})`,
        traffic_source: 'monthly_reconciliation'
      });

      corrections++;
      logger.info(`[MonthlyRecon] ${client.name}: +${diffGb}GB (+${correctionCost}₽)`);
    }

    // Marker already persisted at start; just save client balances and log.
    saveClients(getClients());
    logger.info(`[MonthlyRecon] Complete: ${corrections} correction(s)`);
    logActivity('billing', 'info', 'reconciliation_complete', null, `Monthly reconciliation for ${prevMonthStr}: ${corrections} correction(s)`, { period: prevMonthStr, corrections });
  }

  return {
    runMonthlyReconciliation,
    getLastReconciliationMonth: () => lastReconciliationMonth,
    // Только для тестов: сбросить маркер без записи в kv.
    _setLastReconciliationMonth: (v) => { lastReconciliationMonth = v; },
  };
}

module.exports = { create };
