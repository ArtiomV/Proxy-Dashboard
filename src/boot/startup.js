'use strict';
//
// src/boot/startup.js — стартовая последовательность приложения: расписания
// суточных джобов, периодики и инициализации ботов/движков, вызванные один
// раз при старте HTTP-сервера. Extracted from server.js (Stage 9, финал
// boot-хвоста) — тело колбэка app.listen перенесено без изменения логики;
// server.js лишь собирает зависимости и вызывает runStartup(deps).

function runStartup(d) {
  const {
    logger, db, fs, path,
    rescheduleSpeedtests, scheduleRepeating,
    aggregateTopHosts, runDomainGuard, balanceReconcile,
    healthDb, uptimeTracking, getSetting, setSetting,
    alerts, logActivity, fetchAllServersDataCached, appSettings,
    trackModems, _intervals, syncYesterdayTraffic, topHostsCache,
    autoCreateMissingClients, checkProxyLatency, proxyCheckRef,
    runAutoReboot, dbAudit, tochkaConfig, runTochkaSync,
    runRetentionCleanup, cleanupStalePortMappings,
    runDailyBilling, runMonthlyReconciliation,
    runShadowBilling, runShadowBillingWeekly,
    autoGenerateMonthlyActs, autoGenerateMonthlyBills, syncBillStatuses,
    aiInsights, simulator, tgSummary, tgBot, clientById,
    kvSetCritical, kvGet, kvSet, knownModems, clients, getStaleNicks,
    failoverEngine, fetchApi, fetchApiRaw, postFormApi, parseHtmlInputFields,
    proxySmart, apiServers, findServer, saveSettings,
    trafficDb, trackingDb, aggregateHourlyTraffic, hourlyTraffic, mergeServerData,
    setHourlyAggSched, runSpeedMonitor, runServerMetrics, runRetailGuard,
    runBlockedPortCleanup, runHttpCheck,
    saveClients, auditLog, authTokensDb,
  } = d;

  // Авто-спидтесты всего флота отключены 2026-08-13 (daily-schedule.js) —
  // вызов оставлен: rescheduleSpeedtests() теперь no-op, только чистит таймеры.
  rescheduleSpeedtests();

  // Schedule nightly TopHosts at 03:00
  scheduleRepeating(3, 0, 'TopHosts', aggregateTopHosts);

  // WP2: доменный контроль в 03:25 UTC — после TopHosts (03:00); если тот ещё
  // работает, джоба сама подождёт свежий снапшот (ретраи по свежести).
  scheduleRepeating(3, 25, 'DomainGuard', runDomainGuard);

  // WP5: daily balance-vs-ledger reconciliation at 04:00 UTC (after billing
  // settles). Observation only — drift logs critical + TG alert, no auto-fix.
  scheduleRepeating(4, 0, 'BalanceReconcile', () => balanceReconcile.runOnce());

  // Stage 17: nightly modem-health snapshot at 23:55 MSK (20:55 UTC) — captures
  // the score for the day that's about to end. Also runs a one-shot 30-day
  // backfill at boot so the «Здоровье» tab has historical data immediately
  // on first deploy (not only after 30 cron firings).
  const _healthSnap = require('../jobs/health-snapshot').create({
    db, logger, healthDb, uptimeTracking, getSetting,
  });
  try {
    const r = _healthSnap.backfillIfEmpty(30);
    if (r && r.filled) logger.info(`[HealthSnapshot] Backfill done: ${r.filled} rows`);
  } catch (e) { logger.warn('[HealthSnapshot] Backfill error: ' + e.message); }
  scheduleRepeating(20, 55, 'HealthSnapshot', () => _healthSnap.runDailySnapshot());

  // Stage 18.13: hourly health / capacity check — fires alerts for heap,
  // disk, and stuck cron jobs. Watchdogs живут в src/jobs/watchdogs.js.
  const _watchdogs = require('../jobs/watchdogs').create({ db, logger, alerts, logActivity, fs });
  _intervals.push(setInterval(_watchdogs.hourlyHealthCheck, 60 * 60 * 1000));

  // D2 (23.08): суточный контроль SSL-сертификата домена (≤14 дн — important,
  // ≤3 дн / ошибка TLS — critical). Разово при старте (с паузой, чтобы сеть
  // поднялась) + каждый день в 04:10 UTC (07:10 МСК).
  const _sslMon = require('../jobs/ssl-monitor').create({ logger, alerts, getSetting, logActivity });
  setTimeout(() => { _sslMon.checkOnce().catch(e => logger.warn('[SSLMonitor] initial: ' + e.message)); }, 3 * 60 * 1000);
  scheduleRepeating(4, 10, 'SSLMonitor', () => _sslMon.checkOnce());

  // Stage 18.13: daily proxy-expiry check at 09:30 МСК (06:30 UTC) — alert
  // for ports expiring within 3 days. Runs once per day; per-port cooldown
  // is 24h inside the alert rule.
  scheduleRepeating(6, 30, 'ProxyExpiryCheck', async () => {
    try {
      const allData = await fetchAllServersDataCached();
      const SOON_MS = 3 * 86400 * 1000;
      for (const data of allData) {
        const ports = data.ports || {};
        for (const [imei, list] of Object.entries(ports)) {
          for (const p of list) {
            const vb = p && p.PROXY_VALID_BEFORE;
            if (!vb) continue;
            const expMs = Date.parse(vb);
            if (isNaN(expMs)) continue;
            const left = expMs - Date.now();
            if (left > 0 && left < SOON_MS) {
              alerts.trigger('proxy_expiring_3d', {
                server: data.serverName, portId: p.portID, portName: p.portName || '',
                client: p.portName || '?',
                daysLeft: Math.ceil(left / 86400000),
                validBefore: vb.slice(0, 10),
              });
            }
          }
        }
      }
    } catch (e) { logger.warn('[ProxyExpiry] check failed: ' + e.message); }
  });

  // Start modem tracking (IP + uptime) — every tracking_interval_min (default 3)
  const TRACKING_INTERVAL_MS = (appSettings.tracking_interval_min || 3) * 60000;
  logger.info(`[Tracking] Starting IP & uptime tracking (every ${TRACKING_INTERVAL_MS / 60000} min)...`);
  trackModems().catch(e => logger.error('[Tracking] Initial error:', e.message));
  _intervals.push(setInterval(() => {
    trackModems().catch(e => logger.error('[Tracking] Error:', e.message));
  }, TRACKING_INTERVAL_MS));

  // Sync yesterday traffic — once at startup, then daily at 00:45 UTC (03:45 MSK)
  syncYesterdayTraffic().catch(e => logger.error('[DailySync] Initial error:', e.message));
  scheduleRepeating(0, 45, 'DailySync', syncYesterdayTraffic);
  scheduleRepeating(7, 0, 'DailySync-07:00', syncYesterdayTraffic);
  scheduleRepeating(15, 0, 'DailySync-15:00', syncYesterdayTraffic);

  // If no cached top_hosts data, do initial aggregation
  if (!topHostsCache.updatedAt) {
    logger.info('[TopHosts] No cached data, running initial aggregation...');
    aggregateTopHosts().catch(e => logger.error('[TopHosts] Initial error:', e.message));
  }

  // Auto-create client accounts for all portNames that don't have one
  autoCreateMissingClients().catch(e => logger.error('[AutoCreate] Error:', e.message));
  // Re-check periodically so new portNames get accounts without restart
  _intervals.push(setInterval(() => {
    autoCreateMissingClients().catch(e => logger.error('[AutoCreate] Error:', e.message));
  }, (appSettings.auto_create_interval_min || 10) * 60000));

  // Proxy latency monitoring
  const pcMin = appSettings.proxy_check_interval_min || 60;
  logger.info(`[ProxyCheck] Starting proxy latency monitoring (every ${pcMin} min)...`);
  setTimeout(() => {
    checkProxyLatency().catch(e => logger.error('[ProxyCheck] Initial error:', e.message));
  }, 30 * 1000);
  proxyCheckRef.iv = setInterval(() => {
    checkProxyLatency().catch(e => logger.error('[ProxyCheck] Error:', e.message));
  }, pcMin * 60 * 1000);

  // Auto-reboot flaky modems every 15 min.
  // The throttle inside (auto_reboot_min_interval_min, default 60) ensures the
  // same modem isn't rebooted more than once per hour even if checked every 15.
  // Disabled by default — admin enables in Settings.
  setTimeout(() => {
    dbAudit.runJobAsync('AutoReboot', 'initial', () => runAutoReboot())
      .catch(e => logger.error('[AutoReboot] Initial error:', e.message));
  }, 10 * 60 * 1000);
  _intervals.push(setInterval(() => {
    dbAudit.runJobAsync('AutoReboot', 'periodic', () => runAutoReboot())
      .catch(e => logger.error('[AutoReboot] Periodic error:', e.message));
  }, 15 * 60 * 1000));

  // Phase 6: Tochka bank statement sync every 4 hours.
  // Acts as a reliable backup to webhook delivery — webhooks can be lost during
  // Tochka key rotation, network blips, or our process restarts. Polling guarantees
  // payments eventually land in bank_payments and auto-credit by INN.
  // Skips silently if tochkaConfig is incomplete.
  // Window: last 14 days (idempotent — duplicates skipped via tochka_payment_id).
  function _scheduledTochkaSync(reason) {
    if (!tochkaConfig.jwt || !tochkaConfig.accountId) {
      logger.debug('[Tochka Sync:scheduled] skipped — config incomplete');
      return;
    }
    const today = new Date();
    const dateTo   = today.toISOString().slice(0, 10);
    const dateFrom = new Date(today.getTime() - 14 * 86400000).toISOString().slice(0, 10);
    dbAudit.runJobAsync('TochkaSync', reason, () =>
      runTochkaSync({ dateFrom, dateTo, source: reason })
    )
      .then(r => {
        if (!r.ok) logger.warn(`[Tochka Sync:${reason}] failed:`, r.error, r.details || '');
      })
      .catch(e => logger.error('[Tochka Sync:${reason}] exception:', e.message));
  }
  // Initial run 90s after start (after DB warm-up + cache populate)
  setTimeout(() => _scheduledTochkaSync('startup'), 90 * 1000);
  // Every 30 min (was 4 h). The scheduled sync only pulls a 14-day window and
  // is the auto-credit path (the webhook can't verify Tochka's signature), so a
  // tighter cadence means a payment is auto-credited within ≤30 min instead of
  // up to 4 h. Cheap: a 14-day statement + INN/name match, idempotent on re-run.
  _intervals.push(setInterval(() => _scheduledTochkaSync('periodic'), 30 * 60 * 1000));

  // SpeedMonitor: почасовой замер скорости выбранных модемов
  // (src/jobs/speed-monitor.js, ники из настройки speedtest_modems,
  // читается на каждый прогон). Первый прогон
  // через 4 минуты после старта (после прогрева кэша), далее каждый час.
  // Джоб сам резолвит ник → бокс, переезд симки на другой бокс переживает.
  // Данные: таблица speed_monitor, выдача — GET /api/admin/speed-monitor.
  setTimeout(() => dbAudit.runJobAsync('SpeedMonitor', 'startup', () => runSpeedMonitor())
    .catch(e => logger.error('[SpeedMonitor] startup run failed:', e.message)), 4 * 60 * 1000);
  _intervals.push(setInterval(() => dbAudit.runJobAsync('SpeedMonitor', 'hourly', () => runSpeedMonitor())
    .catch(e => logger.error('[SpeedMonitor] hourly run failed:', e.message)), 60 * 60 * 1000));

  // ServerMetrics: снимок загрузки боксов (SSH cpu/load/mem/swap/disk/temp/
  // uptime + HTTP-панель /system_status) в таблицу server_metrics — блок
  // «Загрузка серверов» на дашборде. SSH с дашборд-сервера закрыт файрволом
  // боксов — джоба молча переживает и пишет то, что собрала по HTTP.
  // Первый прогон через 2 мин после старта, далее каждые 10 мин.
  setTimeout(() => dbAudit.runJobAsync('ServerMetrics', 'startup', () => runServerMetrics())
    .catch(e => logger.error('[ServerMetrics] startup run failed:', e.message)), 2 * 60 * 1000);
  _intervals.push(setInterval(() => dbAudit.runJobAsync('ServerMetrics', 'periodic', () => runServerMetrics())
    .catch(e => logger.error('[ServerMetrics] periodic run failed:', e.message)), 10 * 60 * 1000));

  // B2C Э2: RetailGuard — конвейер автоблока розницы (grace → block+hold →
  // delete → restore + тест-день), цикл 10 минут. Тик планируется всегда,
  // но retail_enabled проверяется на КАЖДОМ тике (и внутри runOnce) —
  // включение настройки подхватывается без рестарта, при выключенном флаге
  // прогон пропускается и прод не затрагивается. Первый прогон через 6 мин
  // после старта (после прогрева кэша серверов).
  setTimeout(() => {
    if (!getSetting('retail_enabled', false)) return;
    dbAudit.runJobAsync('RetailGuard', 'startup', () => runRetailGuard())
      .catch(e => logger.error('[RetailGuard] startup run failed:', e.message));
  }, 6 * 60 * 1000);
  _intervals.push(setInterval(() => {
    if (!getSetting('retail_enabled', false)) return;
    dbAudit.runJobAsync('RetailGuard', 'periodic', () => runRetailGuard())
      .catch(e => logger.error('[RetailGuard] periodic run failed:', e.message));
  }, 10 * 60 * 1000));

  // A2 (23.08): HTTP-чек сайта через прокси-порты (scope = speedtest_list по
  // умолчанию). Интервал читается с КАЖДОГО тика — правка настройки
  // httpcheck_interval_min применяется без рестарта (тик 1 мин — это
  // планировщик; прогон запускается, когда пришло время).
  if (runHttpCheck) {
    let _hcLastRun = 0;
    setTimeout(() => {
      _hcLastRun = Date.now();
      dbAudit.runJobAsync('HttpCheck', 'startup', () => runHttpCheck())
        .catch(e => logger.error('[HttpCheck] startup run failed:', e.message));
    }, 5 * 60 * 1000);
    _intervals.push(setInterval(() => {
      const everyMs = Math.max(5, parseInt(getSetting('httpcheck_interval_min', 15)) || 15) * 60000;
      if (Date.now() - _hcLastRun < everyMs) return;
      _hcLastRun = Date.now();
      dbAudit.runJobAsync('HttpCheck', 'periodic', () => runHttpCheck())
        .catch(e => logger.error('[HttpCheck] periodic run failed:', e.message));
    }, 60 * 1000));
  }

  // 21.08: BlockedPortCleanup — удаление портов заблокированных клиентов
  // (ручной блок + долговой) после истечения hold (retail_hold_days дней от
  // blocked_since, миграция 073). Работает НЕЗАВИСИМО от retail_enabled —
  // иначе при выключенной рознице порты заблокированных висят вечно.
  // Цикл 30 мин, первый прогон через 8 мин после старта. Юрлиц не трогает.
  setTimeout(() => dbAudit.runJobAsync('BlockedPortCleanup', 'startup', () => runBlockedPortCleanup())
    .catch(e => logger.error('[BlockedPortCleanup] startup run failed:', e.message)), 8 * 60 * 1000);
  _intervals.push(setInterval(() => dbAudit.runJobAsync('BlockedPortCleanup', 'periodic', () => runBlockedPortCleanup())
    .catch(e => logger.error('[BlockedPortCleanup] periodic run failed:', e.message)), 30 * 60 * 1000));

  // Nightly DB cleanup at 00:30 UTC — remove old data using dynamic retention settings
  scheduleRepeating(0, 30, 'DbCleanup', () => {
    try {
      const res = runRetentionCleanup();
      const total = Object.values(res).reduce((s, r) => s + r.changes, 0);
      if (total > 0) logger.info(`[DbCleanup] Removed ${total} old rows (hourly:${res.traffic_hourly.changes} meta:${res.modem_meta.changes} rot:${res.rotation_log.changes} proxy:${res.proxy_checks.changes} audit:${res.audit_log.changes} syslog:${res.system_log.changes})`);
      logActivity('system', 'info', 'db_cleanup', null, `DB cleanup: ${total} rows removed`, { hourly: res.traffic_hourly.changes, meta: res.modem_meta.changes, rotation: res.rotation_log.changes, proxy_checks: res.proxy_checks.changes, audit: res.audit_log.changes, system_log: res.system_log.changes });
      // Refresh query-planner statistics after pruning so the covering indexes
      // stay chosen (the proxy_checks summary on /api/admin/data degrades to a
      // 4s full scan if stats go stale). PRAGMA optimize only re-analyzes tables
      // that changed materially, so it's cheap.
      try { db.pragma('optimize'); logger.info('[DbCleanup] PRAGMA optimize done'); } catch (_) { /* best-effort */ }
    } catch (e) {
      logger.error('[DbCleanup] Error:', e.message);
      logActivity('system', 'error', 'db_cleanup_error', null, `DB cleanup error: ${e.message}`);
    }
  });

  // Heap & disk watchdog — fires every 5 min, alerts on threshold crossings.
  _intervals.push(setInterval(_watchdogs.heapDiskWatchdog, 5 * 60 * 1000));
  // Nightly DB backup (02:00) + history pruning (02:30) — extracted to
  // src/jobs/backup.js (WP6.4). Scheduled here via the unified registry.
  const backupJobs = require('../jobs/backup').create({ db, logger, logActivity, fs, path });
  scheduleRepeating(2, 0, 'DbBackup', backupJobs.runDbBackup);
  scheduleRepeating(2, 30, 'HistoryPrune', backupJobs.runHistoryPrune);

  // Hourly: just the stale-port mapping cleanup (cheap, keeps the "modem
  // disconnected ≥ N days → vanish" window precise to the hour instead of
  // ±1 day from the nightly run).
  _intervals.push(setInterval(() => {
    try {
      const res = cleanupStalePortMappings();
      if (res && (res.dtDeleted || res.dtMemKeys || res.kmRemoved)) {
        logger.info(`[StalePortsHourly] dt=${res.dtDeleted} mem=${res.dtMemKeys} km=${res.kmRemoved}`);
      }
    } catch (e) { logger.error('[StalePortsHourly] ' + e.message); }
  }, 60 * 60 * 1000));

  // Schedule daily billing at 01:00 UTC (04:00 MSK, 4h after ProxySmart midnight reset)
  scheduleRepeating(1, 0, 'DailyBilling', () =>
    dbAudit.runJobAsync('DailyBilling', null, () => runDailyBilling()));

  // Фаза 0 (§2 ТЗ): теневой тест тарификации — 01:10 UTC, сразу за DailyBilling.
  // Ничего не списывает: пишет сравнение V1 (legacy) vs V2 (канон) в billing_shadow_log.
  scheduleRepeating(1, 10, 'ShadowBilling', () =>
    dbAudit.runJobAsync('ShadowBilling', null, () => runShadowBilling()));
  // Еженедельный отчёт по теневому тесту — понедельник 09:00 МСК (06:00 UTC);
  // день недели проверяется внутри джобы (scheduleRepeating его не поддерживает).
  scheduleRepeating(6, 0, 'ShadowBillingWeekly', () =>
    dbAudit.runJobAsync('ShadowBillingWeekly', null, () => runShadowBillingWeekly()));

  // Monthly reconciliation at 03:30 UTC (06:30 MSK) on 1st of month — after TopHosts, before acts
  scheduleRepeating(3, 30, 'MonthlyReconciliation', () =>
    dbAudit.runJobAsync('MonthlyReconciliation', null, () => runMonthlyReconciliation()));

  // Auto-generate closing documents (acts) on 1st of each month at 08:05 Moscow (05:05 UTC)
  scheduleRepeating(5, 5, 'MonthlyActs', autoGenerateMonthlyActs);

  // Auto-generate bills on 1st of each month at 08:10 Moscow (05:10 UTC)
  scheduleRepeating(5, 10, 'MonthlyBills', autoGenerateMonthlyBills);

  // Сверка статуса счетов с Точкой — ежедневно в 08:20 МСК (05:20 UTC), после
  // выставления счетов. Ловит оплаты, которые матчинг платежей не связал со счётом.
  scheduleRepeating(5, 20, 'BillStatusSync', () =>
    dbAudit.runJobAsync('BillStatusSync', null, () => syncBillStatuses()));

  // ---------------------------------------------------------------------------
  // Telegram bot — daily summary + /start auto-registration
  // ---------------------------------------------------------------------------
  aiInsights.init({
    db, logger,
    getSetting,
  });
  // Load-simulator engine. Only init here — proxy-URL resolution happens in
  // the per-request endpoint (Day 2), which calls fetchAllServersDataCached()
  // and builds full proxyUrls for the chosen target modems before passing
  // them to simulator.start().
  simulator.init({
    db, logger,
    getSetting,
  });
  tgSummary.init({
    db, logger,
    clientById,
    getSetting,
    aiInsights,
    // D3: дайджест «Лежат >12 ч» в сводке — тот же источник, что у колокольчика.
    listDisconnectedModems: require('../jobs/notify-collect').scanDisconnected,
  });
  tgBot.init({
    logger,
    getSetting,
    setSetting,
    buildDailySummary: tgSummary.buildDailySummary,
    // B2C Э3 (WP5): привязка аккаунта по /start link_<code> + кэш username бота.
    authTokensDb,
    getClients: () => clients,
    saveClients, auditLog,
    kvGet: (k) => kvGet.get(k),
    kvSet: (k, v) => kvSet.run(k, v),
  });
  // Stage 18.13: alerts framework wires into the same bot/chat.
  alerts.init({ logger, getSetting, appSettings, kvSetCritical, kvGet, db, tgBot });
  // Stage 18.15: notification collector — periodic scan that pushes
  // offline-modem / client-debt events into the same bell.
  require('../jobs/notify-collect').init({
    logger, db, alerts, uptimeTracking, knownModems, clients, getStaleNicks, getSetting,
    // WP4.2: the bell's offline set must equal the card's disconnectedList —
    // give the job the same inputs computeFleet uses on /api/admin/data.
    trackingDb, fetchAllServersDataCached, mergeServerData,
  });
  // Stage 19: failover engine — periodic scan that re-points dead/glitchy
  // client modems to healthy spares (OFF + dry-run by default; see settings).
  failoverEngine.init({
    logger, db, appSettings, alerts, logActivity,
    apiServers, findServer, knownModems, uptimeTracking, getStaleNicks,
    fetchApi, fetchApiRaw, postFormApi, parseHtmlInputFields, proxySmart,
    fetchAllServersDataCached, mergeServerData,   // Stage 19.1 — spares from MERGED live data (same as Модемы table)
  });
  // Start the long-poll loop (handles /start, /today, /yesterday, /status)
  tgBot.start();

  // Stage 18.13: "dashboard restarted" alert — fires once 30s after boot so
  // we don't spam if pm2 is bouncing the process. Boot-grace inside alerts.js
  // (5min) would block this; we explicitly trigger AFTER grace would expire,
  // BUT we want it sooner — so we set a one-shot timer that calls the rule's
  // sendMessage directly via tgBot, bypassing alerts.trigger().
  setTimeout(() => {
    try {
      // Токен в kv лежит зашифрованным (enc1:, SENSITIVE_SETTINGS) — читаем
      // через getSetting, прямое appSettings.telegram_bot_token вернёт шифртекст.
      const token = getSetting('telegram_bot_token', '');
      const chatId = appSettings.telegram_chat_id;
      if (!token || !chatId) return;
      if (appSettings.alert_dashboard_restarted_enabled === false) return;
      const txt = '🔄 <b>Дашборд стартовал</b>\n\nПроцесс перезапущен. Если это не плановый деплой — стоит посмотреть, не упал ли он.';
      tgBot.sendMessage(token, chatId, txt).catch(e => logger.warn('[Alerts] boot msg: ' + e.message));
    } catch (e) { logger.warn('[Alerts] boot trigger: ' + e.message); }
  }, 30000);

  // Daily summary scheduler — модуль src/telegram/summary-loop.js.
  const _summaryLoop = require('../telegram/summary-loop').create({
    appSettings, tgSummary, tgBot, saveSettings, logger, logActivity,
    getSetting,   // WP5: токен — enc1: в kv, читаем через getSetting
  });
  _intervals.push(setInterval(_summaryLoop.tick, 60 * 1000));

  // Resilient hourly traffic aggregation — модуль src/jobs/hourly-agg-schedule.js.
  const _sched = require('../jobs/hourly-agg-schedule').create({
    kvGet, kvSet, logger, logActivity, trafficDb, aggregateHourlyTraffic,
  });
  _sched.start();
  if (setHourlyAggSched) setHourlyAggSched(_sched);   // для gracefulShutdown в server.js
  // Mid-hour snapshot removed (FIX-13): 5 retry attempts at :00-:04 are sufficient.

  // Startup: refresh snapshots only (NO DB writes) — prevents restart-induced data loss
  const snapshotCount = hourlyTraffic.getSnapshotCount();
  logger.info(`[HourlyAgg] ${snapshotCount} snapshots loaded, refreshing in 15s (no DB write)`);
  setTimeout(() => hourlyTraffic.refreshSnapshotsOnly().catch(e => logger.error('[HourlyAgg:startup]', e.message)), 15000);

  // Billing catch-up: if last snapshot is older than 26 hours, run now
  (async () => {
    try {
      const now = Date.now();
      let needsCatchup = false;
      for (const c of clients) {
        if (c.billingPaused) continue;
        if (c.last_traffic_snapshot && c.last_traffic_snapshot.timestamp) {
          const lastRun = new Date(c.last_traffic_snapshot.timestamp).getTime();
          if (now - lastRun > 26 * 60 * 60 * 1000) {
            needsCatchup = true;
            break;
          }
        }
      }
      if (needsCatchup) {
        logger.info('[Billing] Catch-up: missed billing detected, running now...');
        logActivity('billing', 'warn', 'billing_catchup', null, 'Missed billing detected, running catch-up');
        await runDailyBilling();
      }
    } catch (e) {
      logger.error('[Billing] Catch-up error:', e.message);
    }
  })();
}

module.exports = { runStartup };
