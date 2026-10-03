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
    ledgerDb, billingRunsDb,   // DEEP-23: durable runs/jobs (миграция 099; опционально — legacy-путь без него)
    clients,
    dailyTraffic, recordDailyTraffic,
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
    debtBlock,   // B3 (Р13): пост-биллинговый автоблок должников-физиков (опционально)
    tariffsDb,   // Р36: единый прайс — getClientPrice (override → tariff → legacy price)
    clientEventsLogin,   // SSE 03.10: publishTo(login, …) в ЛК (опционально)
  } = deps;

  // Р36/В.5: эффективная цена клиента. Приоритет:
  //   price_override (индивидуальная цена корпората) → tariffs.price (по tariff_id)
  //   → clients.price (legacy-совместимость).
  // Ни одного источника → 0 (клиент пропускается биллингом + алерт наверху).
  // DEEP-47 (2026-09-24): active=0 у тарифа закрывает НОВЫЕ продажи, а не
  // действующие назначения — цена клиента с архивным тарифом читается так же.
  // Пропавший tariffId — громкий warn один раз на клиента (не молчаливый
  // fallback на legacy/0, инцидент «3040 → 0 после деактивации»).
  function getClientPrice(client) {
    if (typeof client.priceOverride === 'number' && client.priceOverride > 0) return client.priceOverride;
    if (client.tariffId != null && tariffsDb) {
      const t = tariffsDb.byId(client.tariffId);
      if (t && t.price > 0) return t.price;
      if (!t) logger.warn(`[Billing] ${client.name}: tariffId=${client.tariffId} не найден — fallback на legacy price ${client.price || 0}`);
    }
    return client.price || 0;
  }

  let lastBillingRunSummary = null;
  let lastRunResults = null;   // server data последнего реального прогона (для debt-block)
  let lastRunExecuted = false;

  function runDailyBilling(retryClientIds, runOpts) {
    // Mutex: serialize billing vs saveClients to avoid reading stale client snapshots.
    return withClientsLock(() => _runDailyBillingImpl(retryClientIds, runOpts))
      .then(async r => {
        setLastBillingRunSummary(lastBillingRunSummary);
        // B3 (Р13): автоблок — ПОСЛЕ освобождения clients-lock (внутри сетевые
        // вызовы к ProxySmart, держать мьютекс минуты нельзя). Идемпотентно
        // (флаг debtBlocked + проверка уже истёкшей «дата до»), поэтому
        // запускается и на retry-прогонах.
        if (debtBlock && lastRunExecuted && lastRunResults) {
          try {
            await debtBlock.runAfterDailyBilling(clients, lastRunResults);
          } catch (e) {
            logger.error('[DebtBlock] post-billing pass failed:', e.message);
          }
        }
        return r;
      });
  }

async function _runDailyBillingImpl(retryClientIds, runOpts) {
  lastRunExecuted = false;
  lastRunResults = null;
  const isRetry = Array.isArray(retryClientIds) && retryClientIds.length > 0;
  // 2026-09-18 · DEEP-23: расчётная дата — часть durable-контекста прогона.
  // Retry/catch-up передают исходную дату явно; «вчера» вычисляется только
  // для свежего планового прогона (раньше retry в setTimeout пересчитывал
  // «вчера» на момент запуска и биллил не ту дату).
  const billingDate = (runOpts && runOpts.billingDate) || getMoscowYesterday();
  const isCurrentDate = billingDate === getMoscowYesterday();
  // Guard: prevent double billing for same date (atomic check).
  // DEEP-23: при durable-учёте гвард — billing_runs + незакрытые задания, а
  // НЕ «хотя бы один charge за дату» (одна first_day-строка покупки или одно
  // частичное списание раньше останавливали расчёт всех клиентов, DEEP-20).
  const skipResult = db.transaction(() => {
    if (billingRunsDb) {
      if (!isRetry) {
        const runRow = billingRunsDb.runFor(billingDate);
        const openJobs = billingRunsDb.openJobsForDate(billingDate);
        if (runRow && runRow.status === 'completed' && openJobs.length === 0) {
          return { skip: true, reason: `Already billed for ${billingDate}` };
        }
      } else {
        const chargedIds = ledgerDb.chargedClientIdsForDate(billingDate);
        if (chargedIds.length > 0) {
          const filtered = retryClientIds.filter(id => !chargedIds.includes(id));
          // DEEP-23: уже пробиленные клиенты с ОТКРЫТЫМ заданием (крах между
          // debit и отметкой) сверяются здесь — задание закрывается 'done',
          // а не висит 'pending' вечно.
          for (const id of retryClientIds.filter(x => chargedIds.includes(x))) {
            try {
              const openJob = billingRunsDb.jobFor(billingDate, id);
              if (openJob && ['pending', 'failed', 'no_data'].includes(openJob.status)) {
                billingRunsDb.markJob(billingDate, id, 'done', {});
              }
            } catch (_) { /* best-effort */ }
          }
          retryClientIds = filtered;
          if (retryClientIds.length === 0) return { skip: true, reason: 'Retry: all clients already billed' };
        }
      }
      return { skip: false };
    }
    if (!isRetry) {
      const existingCharge = ledgerDb.existsChargeOnDate(billingDate);
      if (existingCharge) return { skip: true, reason: `Already billed for ${billingDate}` };
    } else {
      const chargedIds = ledgerDb.chargedClientIdsForDate(billingDate);
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
  if (billingRunsDb) billingRunsDb.beginRun(billingDate);
  logger.info(`[Billing] Starting ${isRetry ? 'RETRY' : 'daily'} billing run for ${billingDate}...`);
  logActivity('billing', 'info', 'billing_start', null, `Starting ${isRetry ? 'RETRY' : 'daily'} billing run for ${billingDate}`);

  let results;
  try {
    results = await fetchAllServersData();
  } catch (e) {
    logger.error('[Billing] Failed to fetch server data:', e.message);
    lastBillingRunSummary = { error: e.message, timestamp: new Date().toISOString() };
    // DEEP-23: прогон failed durable — задания остаются открытыми, recovery
    // (startup catch-up) доведёт их, а не потеряет вместе с процессом.
    if (billingRunsDb) { try { billingRunsDb.failRun(billingDate, e.message); } catch (_) { /* best-effort */ } }
    return;
  }

  // Refresh global portKey mapping for reconciliation/analytics
  refreshPortKeyMapping(results);
  lastRunExecuted = true;
  lastRunResults = results;   // B3: debt-block использует ports из этих же данных

  const yesterdayStr = billingDate;
  // Метка даты — из самой расчётной даты (retry старых дат не подставляет
  // «вчера» на момент запуска). UTC-полдень — без сдвигов локальной зоны.
  const [_by, _bm, _bd] = yesterdayStr.split('-').map(Number);
  const yesterdayLabel = new Date(Date.UTC(_by, _bm - 1, _bd, 12))
    .toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC' });

  let charged = 0, skipped = 0;
  const skippedClients = []; // for retry

  // 1. Save ALL ports' yesterday traffic to dailyTraffic (single source of truth).
  // DEEP-23: живые счётчики «bandwidth_bytes_yesterday_*» валидны ТОЛЬКО для
  // текущей расчётной даты; catch-up старых дат читает durable-историю
  // (traffic_hourly/daily_traffic), сегодняшними счётчиками прошлые дни не
  // подменяются.
  if (isCurrentDate) {
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
        recordDailyTraffic(key, yesterdayStr, newIn, newOut, b.portName);
      }
    }
  }
  }   // isCurrentDate

  // 2. Bill each client
  const clientsToBill = isRetry
    ? clients.filter(c => retryClientIds.includes(c.id))
    : clients;

  for (const client of clientsToBill) {
    // Р36: цена через getClientPrice (override → tariff → legacy price).
    // Клиент без portName или без цены пропускается (свежий физик до покупки — ок).
    // DEEP-23: при retry тарифный контекст — из durable-задания (цена на
    // момент первой попытки), а не текущая карточка клиента.
    let clientPrice = getClientPrice(client);
    if (isRetry && billingRunsDb) {
      try {
        const job = billingRunsDb.jobFor(yesterdayStr, client.id);
        const ctx = job && job.context ? JSON.parse(job.context) : null;
        if (ctx && typeof ctx.price === 'number' && ctx.price > 0) clientPrice = ctx.price;
      } catch (_) { /* битый контекст — живём с текущей ценой */ }
    }
    // 20.08: полностью заблокированный клиент (антифрод blocked или автоблок
    // по долгу debtBlocked — порты уже погашены) не тарифицируется: он не
    // может пользоваться прокси, накручивать минус на баланс бессмысленно.
    if (client.blocked || client.debtBlocked) {
      logger.info(`[Billing] Skipping ${client.name} — ${client.blocked ? 'blocked (antifraud)' : 'debt-blocked'}`);
      skipped++;
      continue;
    }
    if (!client.portName || !clientPrice || clientPrice <= 0 || client.billingPaused) {
      if (client.billingPaused) logger.info(`[Billing] Skipping ${client.name} — billing paused`);
      skipped++;
      continue;
    }

    // DEEP-23: durable-задание client/date с контекстом расчёта. ensureJob —
    // INSERT OR IGNORE: контекст первой попытки сохраняется при повторах.
    if (billingRunsDb) {
      try {
        billingRunsDb.ensureJob(yesterdayStr, client.id, {
          price: clientPrice, billing_type: client.billingType || 'per_gb',
          port_name: client.portName, billing_date: yesterdayStr,
        });
      } catch (_) { /* durable-учёт не должен ронять расчёт */ }
    }

    // Check server availability for this client's ports
    // 23.08: durable-fallback. Раньше клиент пропускался целиком, если его
    // бокс недоступен в момент биллинга — хотя traffic_hourly (часовая
    // агрегация, пишется весь день) уже содержит весь вчерашний трафик.
    // Теперь: если durable-данные за вчера есть (или клиент per_modem —
    // аренда не зависит от трафика) — биллим по ним сразу; расхождения
    // с живыми данными потом ловит ShadowBilling/сверка. Пропуск + retry
    // остаются только для случая, когда durable тоже пуст.
    let durableFallbackReason = null;
    const cachedServers = getClientCachedServers(results, client.portName);
    if (cachedServers.length > 0 || results.length < apiServers.length) {
      const reason = cachedServers.length > 0
        ? `cached data on [${cachedServers.join(', ')}]`
        : `only ${results.length}/${apiServers.length} servers`;
      const durableBytes = getClientBytesForMskDate(client.portName, yesterdayStr);
      if (durableBytes > 0 || client.billingType === 'per_modem') {
        logger.warn(`[Billing] ${client.name}: ${reason} — billing from durable/cached data (fallback), shadow-billing will reconcile`);
        durableFallbackReason = reason;
      } else {
        logger.info(`[Billing] Skipping ${client.name}: ${reason} (no durable data either)`);
        if (billingRunsDb) { try { billingRunsDb.markJob(yesterdayStr, client.id, 'no_data', { error: reason }); } catch (_) {} }
        skippedClients.push(client.id);
        skipped++;
        continue;
      }
    }

    try {
      // Primary source: durable traffic_hourly / daily_traffic. Survives ProxySmart restarts
      // that zero the bandwidth_bytes_yesterday_* counters (which has caused missed bills
      // when a server reboots across midnight).
      const deltaBytesDurable = getClientBytesForMskDate(client.portName, yesterdayStr);
      // DEEP-23: live-счётчики «за вчера» валидны только для текущей даты —
      // для catch-up старых дат они содержат ЧУЖОЙ день, берём 0.
      const deltaBytesLive = isCurrentDate ? computeClientYesterdayBytes(results, client.portName) : 0;
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

      // B6 (Р36/ТЗ B2C): traffic-гейт снят для individual + per_modem — аренда
      // платит за день всегда, даже при нулевом трафике. B2B-ветки не меняются.
      // 23.08: + durable-fallback per_modem — при лежащем боксе аренда
      // начисляется по durable-числу модемов, трафик для цены не нужен.
      const isRetailLease = (client.clientType === 'individual') && client.billingType === 'per_modem';
      const isFallbackLease = !!durableFallbackReason && client.billingType === 'per_modem';
      if (deltaBytes <= 0 && !isRetailLease && !isFallbackLease) {
        // DEEP-23: завершённое НУЛЕВОЕ списание — отдельный durable-статус
        // (не ошибка и не недостаток данных; retry ему не нужен).
        if (billingRunsDb) { try { billingRunsDb.markJob(yesterdayStr, client.id, 'zero', { amount: 0 }); } catch (_) {} }
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
        // 23.08: при durable-fallback (бокс недоступен) live-данные могут
        // не содержать порты клиента — считаем модемы из traffic_hourly
        // (distinct nick за вчера), как делает billing_rerun.
        if (modemCount === 0 && durableFallbackReason) {
          try {
            const r = db.prepare(`
              SELECT COUNT(DISTINCT nick) AS n FROM traffic_hourly
              WHERE client_name = ?
                AND substr(datetime(hour_start, '+3 hours'), 1, 10) = ?
            `).get(client.portName, yesterdayStr);
            modemCount = (r && r.n) || 0;
          } catch (_) { /* best-effort */ }
        }
        cost = (clientPrice * modemCount) / daysInMonth;
      } else {
        cost = clientPrice * deltaGb;
      }
      cost = Math.round(cost * 100) / 100;
      if (cost <= 0) {
        if (billingRunsDb) { try { billingRunsDb.markJob(yesterdayStr, client.id, 'zero', { amount: 0 }); } catch (_) {} }
        skipped++;
        continue;
      }

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
          // Эффективная цена списания (priceOverride → tariff → price), а НЕ
          // сырое client.price: иначе при расхождении источников деньги
          // считаются по одной ставке, а акт потом разбивается по другой
          // (инцидент 01.09: списание 31.08 по 23 ₽, но price_per_unit=29 —
          // акт распилился на «по 23 ₽» + «по 29 ₽»).
          price_per_unit: clientPrice,
          billing_type: client.billingType || 'per_gb',
          modem_count: modemCount || null,
          days_in_month: daysInMonth,
          cost,
          currency: client.currency || 'RUB',
          note: client.billingType === 'per_modem'
            ? `Списание за аренду ${modemCount} ${modemPlural(modemCount)} (${yesterdayLabel})`
            : `Списание за трафик (${yesterdayLabel})`,
          traffic_source: durableFallbackReason ? 'daily_billing_durable_fallback' : 'daily_billing',
          fallback_reason: durableFallbackReason || undefined,
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
          // DEEP-23: политика (не transient-ошибка) — retry не планируем,
          // но статус durable, чтобы дату не считать «потерянной».
          if (billingRunsDb) { try { billingRunsDb.markJob(yesterdayStr, client.id, 'skipped', { error: 'insufficient_balance' }); } catch (_) {} }
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
        // Уже списано (напр. крах прошлого прогона после debit, до отметки) —
        // задание ЗАВЕРШЕНО, а не открыто.
        if (billingRunsDb) { try { billingRunsDb.markJob(yesterdayStr, client.id, 'done', { amount: cost }); } catch (_) {} }
        skipped++;
        continue;
      }

      if (billingRunsDb) { try { billingRunsDb.markJob(yesterdayStr, client.id, 'done', { amount: cost }); } catch (_) {} }
      charged++;
      logger.info(`[Billing] ${client.name}: ${deltaGb}GB, ${cost} ${client.currency || 'RUB'}, balance=${client.balance}`);
      logActivity('billing', 'info', 'daily_charge', client.name, `Charged ${cost} ${client.currency || 'RUB'} for ${deltaGb}GB`, { client_id: client.id, gb: deltaGb, cost, balance: client.balance });
      // SSE 03.10: мгновенный пуш баланса в ЛК клиента
      if (clientEventsLogin && client.login) {
        try { clientEventsLogin(client.login, 'balance', { balance: debitRes ? debitRes.balanceAfter : client.balance, charged: cost, date: yesterdayStr }); } catch (_) {}
      }
    } catch (e) {
      logger.error(`[Billing] Error billing ${client.name}:`, e.message);
      logActivity('billing', 'error', 'billing_error', client.name, `Billing error: ${e.message}`, { client_id: client.id });
      // DEEP-23: ошибка списания — durable 'failed' + в retry-очередь (раньше
      // ошибки только логировались и в skippedClients не попадали — клиент
      // терялся до следующего дня).
      if (billingRunsDb) { try { billingRunsDb.markJob(yesterdayStr, client.id, 'failed', { error: e.message }); } catch (_) {} }
      skippedClients.push(client.id);
      skipped++;
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
  if (billingRunsDb) {
    try { billingRunsDb.completeRun(yesterdayStr, lastBillingRunSummary); } catch (_) { /* best-effort */ }
  }

  // 3. Schedule retry if clients were skipped due to server issues (max 1 retry, not on retry runs).
  // DEEP-23: retry сохраняет РАСЧЁТНУЮ дату и контекст (durable-задания), а не
  // пересчитывает «вчера» на момент запуска таймера.
  if (!isRetry && skippedClients.length > 0) {
    const _retryHours = appSettings.billing_retry_delay_hours || 1;
    logger.info(`[Billing] Scheduling retry in ${_retryHours}h for ${skippedClients.length} skipped client(s)...`);
    setTimeout(() => {
      runDailyBilling(skippedClients, { billingDate: yesterdayStr }).catch(e => logger.error('[Billing] Retry error:', e.message));
    }, _retryHours * 3600000);
  }
}

  return { runDailyBilling };
}

module.exports = { create };
