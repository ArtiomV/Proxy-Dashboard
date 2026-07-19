'use strict';
//
// src/jobs/billing.js — the daily billing machine (WP6.4).
// Extracted VERBATIM from server.js: _runDailyBillingImpl — per-client
// charge computation, ledger writes via atomicDebit, idempotency guards,
// debt policy, retry scheduling, alert triggers. Every dependency arrives
// via the deps object; nothing global is captured. The clients-lock is
// SHARED with server.js's saveClients (passed in), preserving the mutex.
// lastBillingRunSummary is kept as a module-local let and synced to
// server.js after every run via setLastBillingRunSummary (health endpoint).
//
function create(deps) {
  const {
    db, logger, logActivity,
    fetchAllServersData,
    refreshPortKeyMapping,
    getMoscowYesterday, getMoscowNow,
    ledgerDb,
    clients,
    dailyTraffic, _dtUpsert,
    parseBwToBytes, trafficBytesToGb,
    getClientCachedServers,
    apiServers,
    getClientBytesForMskDate, computeClientYesterdayBytes, computeClientMonthBytes,
    atomicDebit,
    modemPlural,
    appSettings,
    alerts,
    saveClients, saveDailyTraffic,
    withClientsLock,
    setLastBillingRunSummary,
  } = deps;

  let lastBillingRunSummary = null;

  function runDailyBilling(retryClientIds) {
    // Mutex: serialize billing vs saveClients to avoid reading stale client snapshots.
    return withClientsLock(() => _runDailyBillingImpl(retryClientIds))
      .then(r => { setLastBillingRunSummary(lastBillingRunSummary); return r; });
  }

async function _runDailyBillingImpl(retryClientIds) {
  const isRetry = Array.isArray(retryClientIds) && retryClientIds.length > 0;
  // Guard: prevent double billing for same date (atomic check)
  const yesterdayCheck = getMoscowYesterday();
  const skipResult = db.transaction(() => {
    if (!isRetry) {
      const existingCharge = ledgerDb.existsChargeOnDate(yesterdayCheck);
      if (existingCharge) return { skip: true, reason: `Already billed for ${yesterdayCheck}` };
    } else {
      const chargedIds = ledgerDb.chargedClientIdsForDate(yesterdayCheck);
      if (chargedIds.length > 0) {
        retryClientIds = retryClientIds.filter(id => !chargedIds.includes(id));
        if (retryClientIds.length === 0) return { skip: true, reason: 'Retry: all clients already billed' };
      }
    }
    return { skip: false };
  })();
  if (skipResult.skip) {
    logger.warn(`[Billing] ${skipResult.reason}, skipping`);
    logActivity('billing', 'info', 'billing_skip', null, skipResult.reason);
    return;
  }
  logger.info(`[Billing] Starting ${isRetry ? 'RETRY' : 'daily'} billing run...`);
  logActivity('billing', 'info', 'billing_start', null, `Starting ${isRetry ? 'RETRY' : 'daily'} billing run`);

  let results;
  try {
    results = await fetchAllServersData();
  } catch (e) {
    logger.error('[Billing] Failed to fetch server data:', e.message);
    lastBillingRunSummary = { error: e.message, timestamp: new Date().toISOString() };
    return;
  }

  // Refresh global portKey mapping for reconciliation/analytics
  refreshPortKeyMapping(results);

  const yesterdayStr = getMoscowYesterday();
  const moscowYesterday = getMoscowNow();
  moscowYesterday.setDate(moscowYesterday.getDate() - 1);
  const yesterdayLabel = moscowYesterday.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' });

  let charged = 0, skipped = 0;
  const skippedClients = []; // for retry

  // 1. Save ALL ports' yesterday traffic to dailyTraffic (single source of truth)
  for (const data of results) {
    if (data._cached || typeof data.bw !== 'object') continue;
    const prefix = data.serverName + '_';
    for (const [portId, b] of Object.entries(data.bw)) {
      if (!b.portName) continue;
      const key = prefix + portId;
      if (!dailyTraffic[key]) dailyTraffic[key] = {};
      const yIn = parseBwToBytes(b.bandwidth_bytes_yesterday_in);
      const yOut = parseBwToBytes(b.bandwidth_bytes_yesterday_out);
      if (yIn > 0 || yOut > 0) {
        const existing = dailyTraffic[key][yesterdayStr];
        const newIn = Math.max(existing?.in || 0, yIn);
        const newOut = Math.max(existing?.out || 0, yOut);
        _dtUpsert.run(key, yesterdayStr, newIn, newOut);
        dailyTraffic[key][yesterdayStr] = { in: newIn, out: newOut, portName: b.portName };
      }
    }
  }

  // 2. Bill each client
  const clientsToBill = isRetry
    ? clients.filter(c => retryClientIds.includes(c.id))
    : clients;

  for (const client of clientsToBill) {
    if (!client.portName || !client.price || client.price <= 0 || client.billingPaused) {
      if (client.billingPaused) logger.info(`[Billing] Skipping ${client.name} — billing paused`);
      skipped++;
      continue;
    }

    // Check server availability for this client's ports
    const cachedServers = getClientCachedServers(results, client.portName);
    if (cachedServers.length > 0 || results.length < apiServers.length) {
      const reason = cachedServers.length > 0
        ? `cached data on [${cachedServers.join(', ')}]`
        : `only ${results.length}/${apiServers.length} servers`;
      logger.info(`[Billing] Skipping ${client.name}: ${reason}`);
      skippedClients.push(client.id);
      skipped++;
      continue;
    }

    try {
      // Primary source: durable traffic_hourly / daily_traffic. Survives ProxySmart restarts
      // that zero the bandwidth_bytes_yesterday_* counters (which has caused missed bills
      // when a server reboots across midnight).
      const deltaBytesDurable = getClientBytesForMskDate(client.portName, yesterdayStr);
      const deltaBytesLive = computeClientYesterdayBytes(results, client.portName);
      const deltaBytes = Math.max(deltaBytesDurable, deltaBytesLive);
      const deltaGb = trafficBytesToGb(deltaBytes);

      if (deltaBytesDurable > deltaBytesLive * 1.1 && deltaBytesLive > 0) {
        logger.warn(`[Billing] ${client.name}: durable source wins (${trafficBytesToGb(deltaBytesDurable)} GB) over live yesterday counter (${trafficBytesToGb(deltaBytesLive)} GB) — server likely restarted`);
      }

      // Update snapshot for diagnostics
      client.last_traffic_snapshot = {
        timestamp: new Date().toISOString(),
        month_bytes: computeClientMonthBytes(results, client.portName)
      };

      if (deltaBytes <= 0) {
        skipped++;
        continue;
      }

      // Compute cost
      let cost = 0;
      let modemCount = 0;
      const mn = getMoscowNow();
      // yesterdayStr is yesterday's MSK date — use that month for daysInMonth
      const _ystY = parseInt(yesterdayStr.slice(0,4));
      const _ystM = parseInt(yesterdayStr.slice(5,7));
      const daysInMonth = new Date(_ystY, _ystM, 0).getDate();
      if (client.billingType === 'per_modem') {
        for (const data of results) {
          if (typeof data.bw === 'object') {
            for (const [portId, b] of Object.entries(data.bw)) {
              if (b.portName === client.portName) modemCount++;
            }
          }
        }
        cost = (client.price * modemCount) / daysInMonth;
      } else {
        cost = client.price * deltaGb;
      }
      cost = Math.round(cost * 100) / 100;
      if (cost <= 0) { skipped++; continue; }

      // Debt policy: by default charges ALWAYS go through, even if balance
      // goes far negative — clients accumulate debt and admin reconciles
      // via top-up. Hard floor only applies if admin sets client.maxDebt
      // explicitly (e.g. to refuse charges past -100k).
      let minBalance = null;
      if (typeof client.maxDebt === 'number' && client.maxDebt > 0) {
        minBalance = -Math.abs(client.maxDebt);
      }

      let debitRes;
      try {
        debitRes = atomicDebit(client.id, cost, {
          type: 'charge',
          date: yesterdayStr,
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
            ? `Списание за аренду ${modemCount} ${modemPlural(modemCount)} (${yesterdayLabel})`
            : `Списание за трафик (${yesterdayLabel})`,
          traffic_source: 'daily_billing'
        }, { minBalance });
      } catch (e) {
        if (e && e.code === 'INSUFFICIENT_BALANCE') {
          logger.warn(`[Billing] ${client.name}: insufficient balance (${e.balanceBefore} → ${e.balanceAfter}, min=${e.minBalance}), charge blocked`);
          logActivity('billing', 'warn', 'insufficient_balance', client.name,
            `Insufficient balance: would go from ${e.balanceBefore} to ${e.balanceAfter} (limit ${e.minBalance})`,
            { client_id: client.id, cost, balance: e.balanceBefore, minBalance: e.minBalance });
          // Stage 18.13 — критическое: списание не прошло, клиент под угрозой отключения.
          try {
            alerts.trigger('client_charge_failed', {
              client: client.name, client_id: client.id,
              amount: cost, balance_before: e.balanceBefore,
            });
          } catch (_) {}
          skipped++;
          continue;
        }
        throw e;
      }
      // Stage 18.13 — клиент ушёл в минус впервые этим списанием
      if (debitRes && debitRes.balanceBefore >= 0 && debitRes.balanceAfter < 0) {
        try {
          alerts.trigger('client_balance_negative', {
            client: client.name, client_id: client.id, balance: debitRes.balanceAfter,
          });
        } catch (_) {}
      }

      if (debitRes && debitRes.duplicate) {
        logger.info(`[Billing] ${client.name}: charge for ${yesterdayStr} already posted (duplicate), skipping`);
        skipped++;
        continue;
      }

      charged++;
      logger.info(`[Billing] ${client.name}: ${deltaGb}GB, ${cost} ${client.currency || 'RUB'}, balance=${client.balance}`);
      logActivity('billing', 'info', 'daily_charge', client.name, `Charged ${cost} ${client.currency || 'RUB'} for ${deltaGb}GB`, { client_id: client.id, gb: deltaGb, cost, balance: client.balance });
    } catch (e) {
      logger.error(`[Billing] Error billing ${client.name}:`, e.message);
      logActivity('billing', 'error', 'billing_error', client.name, `Billing error: ${e.message}`, { client_id: client.id });
    }
  }

  saveClients(clients);
  saveDailyTraffic();

  lastBillingRunSummary = {
    timestamp: new Date().toISOString(),
    billed_date: yesterdayStr,
    charged,
    skipped,
    skipped_clients: skippedClients,
    is_retry: isRetry
  };

  logger.info(`[Billing] Complete: ${charged} charged, ${skipped} skipped`);
  logActivity('billing', charged > 0 ? 'info' : 'warn', 'billing_complete', null, `Billing complete: ${charged} charged, ${skipped} skipped`, { charged, skipped, date: yesterdayStr, is_retry: isRetry });

  // 3. Schedule retry if clients were skipped due to server issues (max 1 retry, not on retry runs)
  if (!isRetry && skippedClients.length > 0) {
    const _retryHours = appSettings.billing_retry_delay_hours || 1;
    logger.info(`[Billing] Scheduling retry in ${_retryHours}h for ${skippedClients.length} skipped client(s)...`);
    setTimeout(() => {
      runDailyBilling(skippedClients).catch(e => logger.error('[Billing] Retry error:', e.message));
    }, _retryHours * 3600000);
  }
}

  return { runDailyBilling };
}

module.exports = { create };
