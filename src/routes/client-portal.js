'use strict';
//
// src/routes/client-portal.js — client-facing endpoints (Stage 3).
//
// 18 routes used by the client SPA (public/index.html):
//   /api/dashboard_data, /api/billing_history,
//   /api/client/{reset_ip, reset_ip_by_token, set_rotation,
//                 api_key/regenerate, credentials_export, referral, documents,
//                 documents/:docId/download, closing_documents,
//                 closing_documents/:docId/pdf, bills, bills/:billId/pdf,
//                 email}
//
// Most require authMiddleware (session token). reset_ip_by_token uses
// the resetTokenLimiter (separate rate limit + token-based auth instead
// of session) and is also exposed as GET for convenience.

const express = require('express');
const fs = require('fs');
const path = require('path');
const net = require('net');
const crypto = require('crypto');
const { tochkaRequest } = require('../tochka/api');
const { isModemOwned } = require('../modems/ownership');
const { sha256hex } = require('../utils/secrets');
const { rotateApiKey } = require('../services/api-keys');   // v2.10.68: grace-ротация
const sla = require('../sla');
const uptimePeriod = require('../uptime-period');

module.exports = function createClientPortalRouter(deps) {
  const {
    db, logger, authMiddleware, dashboardLimiter, resetTokenLimiter,
    fetchAllServersDataCached, mergeServerData, fetchApi, postApi, findServer,
    extractServerName,
    getMoscowToday, getMoscowNow, trafficBytesToGb, parseBwToBytes, parseTrafficValue,
    ledgerExpense,
    SERVER_COUNTRIES,
    apiServers,
    clients, clientById, clientByLogin, clientByApiKey, clientByResetToken,
    dailyTraffic, ledgerDb, ipTracking, uptimeTracking,
    knownModems,
    getSpeedtestLatest,
    auditLog, logActivity, getClientIp,
    saveClients, atomicCredit,
    // v2.10.68: self-serve перевыпуск API-ключа (grace-ротация) + статистика
    // ключа из api_usage. rebuildClientMaps обязателен после ротации — карты
    // ключей иначе перестроятся только на рестарте.
    trafficDb, rebuildClientMaps, notifyClient,
    validate, ClientEmailSchema,
    getSetting, mailer, authTokensDb,
    proxyConf, modemRotationCache, proxySmart,
    retailPoolDb,
    DOCUMENTS_DIR,
    getTochkaConfig,
  } = deps;
  const r = express.Router();

  // B3 (Р13): портал-баннер блокировки/предупреждения. Критерий «за 3 дня» —
  // баланс ≤ 3 × среднесуточное списание за 7 дн (тот же, что в джобе
  // debt-block; юрлица и allow_debt=1 баннера не получают никогда).
  function _avgDailyCharge7d(entries) {
    const today = getMoscowToday(); // "YYYY-MM-DD"
    const d7 = getMoscowNow();
    d7.setDate(d7.getDate() - 7);
    const sevenDaysAgoStr = d7.toLocaleDateString('en-CA'); // exclusive lower bound
    const last7dTotal = (entries || [])
      .filter(e => (e.type === 'charge' || e.type === 'correction') && e.date && e.date > sevenDaysAgoStr && e.date < today)
      .reduce((sum, e) => sum + ledgerExpense(e), 0);
    return Math.round((last7dTotal / 7) * 100) / 100;
  }
  function _debtStatus(clientInfo, avgDailyCharge7d, hasPorts) {
    if (!clientInfo || clientInfo.clientType === 'legal' || clientInfo.allowDebt) return null;
    // Нет живых портов — продлевать нечего, блокировать нечего: баннер
    // «Отрицательный баланс… пополните» не показываем (20.08). portName тут
    // не гейт: это имя привязки (= логин), оно остаётся и без портов.
    if (hasPorts === false) return null;
    const balance = clientInfo.balance || 0;
    if (balance <= 0) return { state: clientInfo.debtBlocked ? 'blocked' : 'debt', balance };
    if (avgDailyCharge7d > 0 && balance <= 3 * avgDailyCharge7d) {
      return { state: 'warning', balance, daysLeft: Math.floor(balance / avgDailyCharge7d) };
    }
    return null;
  }

  // Single ownership-check deps (WP2) — every "client owns modem" gate below
  // goes through src/modems/ownership.js with one priority chain.
  const _ownershipDeps = { fetchAllServersDataCached, mergeServerData, knownModems, db };
  // Closing-documents/bills routes need the live tochkaConfig — call the
  // getter on every request since saveTochkaConfig() rebinds the global.
  const tochkaConfig = new Proxy({}, { get: (_t, k) => getTochkaConfig()[k] });

r.get('/api/client/sla_report', authMiddleware, (req, res) => {
  const month = String(req.query.month || '');
  const day = req.query.day != null && req.query.day !== '' ? String(req.query.day) : null;
  const clientInfo = clientByLogin.get(req.user.login);
  if (!clientInfo) return res.status(404).json({ error: 'Клиент не найден' });
  try {
    return res.json(sla.buildClientReport(db, month, clientInfo.portName || clientInfo.login, day));
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
});

r.get('/api/dashboard_data', dashboardLimiter, authMiddleware, async (req, res) => {
  try {
    const results = await fetchAllServersDataCached();
    const merged = mergeServerData(results, req.user.portNameFilter);
    const clientInfo = clientByLogin.get(req.user.login);
    if (clientInfo) {
      // Current month expense from billing ledger
      const ledgerEntries = ledgerDb.listByClient(clientInfo.id);
      // C5: total payments come from billing_ledger (payment + bank_payment −
      // payment_reversal). The legacy client.payments[] in-memory snapshot
      // (boot-loaded from the read-only `payments` table) is gone — it never
      // saw fresh payments.
      const totalPayments = ledgerDb.paymentsTotal(ledgerEntries);
      const currentMonthPrefix = getMoscowToday().slice(0, 7);
      const monthExpense = ledgerEntries
        .filter(e => (e.type === 'charge' || e.type === 'correction') && e.date && e.date.startsWith(currentMonthPrefix))
        .reduce((sum, e) => sum + ledgerExpense(e), 0);

      // Live month traffic from ProxySmart
      let liveMonthBytes = 0;
      for (const [bwKey, bwData] of Object.entries(merged.bandwidth || {})) {
        liveMonthBytes += parseBwToBytes(bwData.bandwidth_bytes_month_in);
        liveMonthBytes += parseBwToBytes(bwData.bandwidth_bytes_month_out);
      }
      // Пол от собственного учёта (23.08): счётчики бокса обнуляются при
      // рестарте панели ProxySmart — тогда месяц добираем из traffic_hourly.
      let ownMonthBytes = 0;
      try {
        const row = db.prepare(
          `SELECT SUM(bytes_in + bytes_out) AS t FROM traffic_hourly
            WHERE client_name = ? AND strftime('%Y-%m', datetime(hour_start, '+3 hours')) = ?`
        ).get(clientInfo.portName || '', getMoscowToday().slice(0, 7));
        ownMonthBytes = (row && row.t) || 0;
      } catch (_) { /* best-effort */ }
      const liveMonthGb = trafficBytesToGb(Math.max(liveMonthBytes, ownMonthBytes));

      // Billed month GB from ledger (for comparison)
      const billedMonthGb = ledgerEntries
        .filter(e => (e.type === 'charge' || e.type === 'correction') && e.date && e.date.startsWith(currentMonthPrefix))
        .reduce((sum, e) => sum + (e.delta_gb || 0), 0);

      // Last hour traffic from traffic_hourly for this client's portName —
      // single bulk query with scalar subquery to compute max hour once.
      let lastHourGb = 0;
      if (clientInfo.portName) {
        const lhRow = db.prepare(`
          SELECT SUM(bytes_in + bytes_out) as total
          FROM traffic_hourly
          WHERE client_name = ?
            AND hour_start = (SELECT MAX(hour_start) FROM traffic_hourly WHERE client_name = ?)
        `).get(clientInfo.portName, clientInfo.portName);
        if (lhRow && lhRow.total) lastHourGb = trafficBytesToGb(lhRow.total);
      }

      // B3 (Р13): портал-баннер — статус долга/блокировки + ближайшая «дата до»
      // по портам (истекающая аренда — клиентский контур ProxyExpiryCheck).
      let earliestExpiry = null;
      let portCount = 0;
      for (const list of Object.values(merged.ports || {})) {
        for (const p of list || []) {
          portCount++;
          const vb = p && p.PROXY_VALID_BEFORE;
          if (!vb) continue;
          const t = Date.parse(vb);
          if (!isNaN(t) && (earliestExpiry === null || t < earliestExpiry)) earliestExpiry = t;
        }
      }

      merged.billing = {
        billingType: clientInfo.billingType || 'per_gb',
        price: clientInfo.price || 0,
        currency: clientInfo.currency || 'RUB',
        totalPayments,
        balance: clientInfo.balance !== undefined ? clientInfo.balance : totalPayments,
        monthExpense: Math.round(monthExpense * 100) / 100,
        liveMonthGb,
        billedMonthGb: Math.round(billedMonthGb * 1000) / 1000,
        lastHourGb,
        debtStatus: _debtStatus(clientInfo, _avgDailyCharge7d(ledgerEntries), portCount > 0),
        expiresAt: earliestExpiry !== null ? new Date(earliestExpiry).toISOString().slice(0, 10) : null,
        // Masked: only the prefix is shown (keys are hashed at rest since
        // migration 043). Полный ключ клиент получает один раз — в момент
        // (пере)выпуска; self-serve перевыпуск — POST /api/client/api_key/regenerate.
        apiKey: clientInfo.apiKeyPrefix ? clientInfo.apiKeyPrefix + '••••••••' : '',
        // v2.10.68: карточка ключа в ЛК — когда выдан, активный grace прежнего
        // ключа, последнее использование и запросы за 24 ч (api_usage, UTC→ISO).
        apiKeyInfo: (() => {
          let lastUsedAt = null, requests24h = 0;
          try {
            const lu = trafficDb.apiUsageLastByClientStmt().get(clientInfo.id);
            if (lu && lu.last_used_at) lastUsedAt = lu.last_used_at.replace(' ', 'T') + 'Z';
            const c24 = trafficDb.apiUsageCount24hByClientStmt().get(clientInfo.id);
            requests24h = (c24 && c24.n) || 0;
          } catch (_) { /* best-effort */ }
          const prevExp = clientInfo.apiKeyPrevExpiresAt;
          return {
            prefix: clientInfo.apiKeyPrefix || '',
            createdAt: clientInfo.apiKeyCreatedAt || null,
            prevExpiresAt: (prevExp && Date.parse(prevExp) > Date.now()) ? prevExp : null,
            lastUsedAt,
            requests24h
          };
        })()
      };

      // B2C Э2: конвейер автоблока (grace → блок → hold → удаление). Поле
      // появляется ТОЛЬКО при retail_enabled — payload B2B не меняется.
      // graceHours нужен ЛК, чтобы посчитать дедлайн grace (balanceNegativeSince + Nч).
      if (getSetting('retail_enabled', false)) {
        merged.retail = {
          balanceNegativeSince: clientInfo.balanceNegativeSince || null,
          graceHours: Number(getSetting('retail_grace_hours', 24)) || 24,
          ports: retailPoolDb.byClient(clientInfo.id).map(row => ({
            server: row.server,
            portId: row.port_id,
            status: row.status,
            holdUntil: row.hold_until || null,
            testExpiresAt: row.test_expires_at || null
          }))
        };
      }
    }

    // Include tracking data filtered for this user's modems
    if (req.user.portNameFilter !== '*') {
      const filteredIpTracking = {};
      const filteredUptimeTracking = {};
      const filteredSpeedtest = {};
      const speedLatest = getSpeedtestLatest();

      const clientImeis = new Set();
      for (const imei of Object.keys(merged.ports)) {
        clientImeis.add(imei);
      }

      // Единый аптайм: сумма минутных online/total-проверок за 30 дней.
      // Клиентские строки атрибутируются владельцу в момент каждого опроса;
      // для истории до внедрения используется подтверждённая дневная привязка.
      const periodicUptimeByImei = {};
      const periodicUptimeSummary = {
        period_days: 30,
        checks: 0,
        online_checks: 0,
        failed_checks: 0,
        uptime_pct: null,
      };
      try {
        const bounds = uptimePeriod.rollingBounds(30);
        const rows = uptimePeriod.clientRows(
          db, bounds.fromDate, bounds.toDate,
          clientInfo ? (clientInfo.portName || clientInfo.login) : req.user.portNameFilter,
          false
        );
        const fullByCanonical = {};
        for (const full of clientImeis) {
          const value = String(full);
          // Префикс — ИМЯ сервера (S1_, RO1-MF289_…), а не только S\d+_:
          // матчим по хвосту из цифр IMEI, иначе аптайм модемов с не-S
          // серверов молча не находился (27.08).
          const match = /^(.*)_(\d{14,15})$/.exec(value);
          fullByCanonical[match ? match[1] + '_' + match[2] : value] = full;
        }
        for (const raw of rows) {
          const row = uptimePeriod.mapRow(raw);
          periodicUptimeSummary.checks += row.checks;
          periodicUptimeSummary.online_checks += row.online_checks;
          const canonical = row.server + '_' + String(row.imei || '').replace(/^S\d+_/, '');
          const full = fullByCanonical[canonical];
          if (!full) continue;
          periodicUptimeByImei[full] = {
            total_checks: row.checks,
            online_checks: row.online_checks,
            first_check: row.observed_from,
            uptime30d: row.uptime_pct,
            period_days: bounds.days,
          };
        }
        periodicUptimeSummary.failed_checks = Math.max(
          0,
          periodicUptimeSummary.checks - periodicUptimeSummary.online_checks
        );
        periodicUptimeSummary.uptime_pct = periodicUptimeSummary.checks
          ? Math.round(periodicUptimeSummary.online_checks / periodicUptimeSummary.checks * 10000) / 100
          : null;
      } catch (_) { /* история аптайма отсутствует → аптайм просто не отдаём */ }

      for (const imei of clientImeis) {
        if (ipTracking[imei]) filteredIpTracking[imei] = ipTracking[imei];
        if (periodicUptimeByImei[imei]) filteredUptimeTracking[imei] = periodicUptimeByImei[imei];
        if (speedLatest[imei]) filteredSpeedtest[imei] = speedLatest[imei];
      }

      merged.ipTracking = filteredIpTracking;
      merged.uptimeTracking = filteredUptimeTracking;
      merged.uptimeSummary30d = periodicUptimeSummary;
      merged.speedtestLatest = filteredSpeedtest;
    }

    // Include server info for client portal (needed for IP addresses)
    merged.servers = apiServers.map(s => ({
      name: s.name, displayName: s.displayName || s.name, publicIp: s.publicIp,
      country: (SERVER_COUNTRIES[s.name] || {}).country || '',
      countryName: (SERVER_COUNTRIES[s.name] || {}).name || s.name
    }));

    res.json(merged);
  } catch (err) {
    res.status(502).json({ error: 'API request failed', details: err.message });
  }
});

// ── Self-serve перевыпуск API-ключа (v2.10.68) ─────────────────────────────
// Grace-ротация: новый ключ работает сразу, прежний — ещё api_key_grace_hours
// (дефолт 24 ч, Настройки админки), затем отклоняется в findClientByApiKey.
// Полный plaintext возвращается ОДИН РАЗ в ответе — в БД только SHA-256.
// Анти-спам: не чаще раза в 60 секунд (ключи не резина, а каждая ротация
// шлёт клиенту Telegram и пишет аудит).
r.post('/api/client/api_key/regenerate', dashboardLimiter, authMiddleware, async (req, res) => {
  try {
    const client = clientByLogin.get(req.user.login);
    if (!client) return res.status(404).json({ error: 'Client not found' });
    // Анти-спам на ПОВТОРНУЮ ротацию (есть прежний ключ и он выдан < 60 с
    // назад). Первая ротация после создания клиента не лимитируется —
    // apiKeyCreatedAt у свежесозданного клиента тоже «только что».
    const createdAt = Date.parse(client.apiKeyCreatedAt || '') || 0;
    if (client.apiKeyPrev && Date.now() - createdAt < 60 * 1000) {
      return res.status(429).json({ error: 'Ключ перевыпущен менее минуты назад. Подождите и попробуйте снова.' });
    }
    const graceHours = Number(getSetting('api_key_grace_hours', 24)) || 24;
    const { plain, prevExpiresAt } = rotateApiKey(client, graceHours);
    saveClients(clients);
    rebuildClientMaps();   // иначе новый ключ заработает только после рестарта
    auditLog(req.user.login, 'api_key_regenerate_self', { clientId: client.id, prevExpiresAt, ip: getClientIp(req) });
    try {
      await notifyClient(client,
        '🔑 Ваш API-ключ был перевыпущен в личном кабинете.\n' +
        (prevExpiresAt
          ? 'Прежний ключ перестанет работать ' + new Date(prevExpiresAt).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' }) + ' (мск).'
          : 'Прежний ключ отключён.') +
        '\nЕсли это были не вы — срочно свяжитесь с поддержкой.',
        { action: 'api_key_regenerated', level: 'warn' });
    } catch (_) { /* TG-ошибка не должна ронять ротацию */ }
    res.json({ ok: true, apiKey: plain, prevExpiresAt, graceHours });
  } catch (e) {
    logger.error('[client-portal] api_key regenerate error: ' + e.message);
    res.status(500).json({ error: e.message });
  }
});

r.get('/api/billing_history', authMiddleware, async (req, res) => {
  const clientInfo = clientByLogin.get(req.user.login);
  if (!clientInfo) return res.status(404).json({ error: 'Client not found' });

  // Есть ли у клиента живые порты (для баннера долга): cached-данные боксов.
  // Без портов «Отрицательный баланс» не показываем — продлевать нечего.
  let hasPorts = true;   // fail-open: при ошибке боксов поведение как раньше
  try {
    const results = await fetchAllServersDataCached();
    const mergedPorts = mergeServerData(results, req.user.portNameFilter).ports || {};
    hasPorts = Object.values(mergedPorts).some(list => Array.isArray(list) && list.length > 0);
  } catch (_) { /* боксы недоступны — не гасим баннер ошибочно */ }

  const entries = ledgerDb.listByClient(clientInfo.id);

  // Optional filters
  const { month, limit: limitStr } = req.query;
  let filtered = entries;

  // Filter by month (e.g. "2026-02")
  if (month) {
    filtered = filtered.filter(e => e.date && e.date.startsWith(month));
  }

  // Sort newest first
  filtered = filtered.slice().sort((a, b) => (b.timestamp || b.date || '').localeCompare(a.timestamp || a.date || ''));

  // Limit results
  const limit = parseInt(limitStr) || 200;
  filtered = filtered.slice(0, limit);

  // Summary: payments, charges, adjustments
  const allEntries = entries;
  const totalCharges = allEntries.filter(e => e.type === 'charge' || e.type === 'correction').reduce((sum, e) => sum + ledgerExpense(e), 0);
  const totalPayments = allEntries.filter(e => e.type === 'payment').reduce((sum, e) => sum + (e.amount || 0), 0);

  // Current month summary
  const currentMonthPrefix = new Date().toISOString().slice(0, 7);
  const monthCharges = allEntries
    .filter(e => (e.type === 'charge' || e.type === 'correction') && e.date && e.date.startsWith(currentMonthPrefix))
    .reduce((sum, e) => sum + ledgerExpense(e), 0);

  // Average daily charge over last 7 days: sum charges for days [today-7 .. today-1] / 7
  const avgDailyCharge7d = _avgDailyCharge7d(allEntries);

  res.json({
    balance: clientInfo.balance,
    currency: clientInfo.currency || 'RUB',
    summary: {
      totalCharges: Math.round(totalCharges * 100) / 100,
      totalPayments: Math.round(totalPayments * 100) / 100,
      monthCharges: Math.round(monthCharges * 100) / 100,
      avgDailyCharge7d,
      daysUntilZero: avgDailyCharge7d > 0 ? Math.floor(clientInfo.balance / avgDailyCharge7d) : null
    },
    // B3 (Р13): портал-баннер (blocked/debt/warning) — рендерится на вкладке «История баланса».
    debtStatus: _debtStatus(clientInfo, avgDailyCharge7d, hasPorts),
    
    entries: filtered.map(({ db_id, ...e }) => e)
  });
});

r.post('/api/client/reset_ip', authMiddleware, async (req, res) => {
  try {
    const { imei, serverName } = req.body;
    if (!imei || !serverName) return res.status(400).json({ error: 'imei and serverName required' });
    // Verify client owns this modem
    const pnf = req.user.portNameFilter;
    if (pnf !== '*') {
      const results = await fetchAllServersDataCached();
      const merged = mergeServerData(results, pnf);
      if (!merged.ports[imei]) return res.status(403).json({ error: 'Modem not assigned to this client' });
    }
    const server = findServer(serverName);
    if (!server) return res.status(400).json({ error: 'Server not found' });
    const result = await fetchApi(server, `/apix/reset_modem_by_imei?IMEI=${encodeURIComponent(imei)}`);
    const success = result && result.result === 'success';
    auditLog(req.user.login, 'client_reset_ip', { imei, serverName, ip: getClientIp(req), success });
    if (success) {
      res.json({ ok: true, result });
    } else {
      res.json({ ok: false, error: result?.message || 'Reset failed', result });
    }
  } catch (err) { res.status(502).json({ ok: false, error: 'Reset failed', details: err.message }); }
});

const _resetIpHandler = async (req, res) => {
  const nick = (req.body && req.body.nick) || req.query.nick;
  const token = (req.body && req.body.token) || req.query.token;
  req.query.nick = nick; req.query.token = token; // for downstream code
  return _resetIpImpl(req, res);
};

r.post('/api/client/reset_ip_by_token', resetTokenLimiter, _resetIpHandler);
r.get('/api/client/reset_ip_by_token', resetTokenLimiter, _resetIpHandler);

async function _resetIpImpl(req, res) {
  const { nick, token } = req.query;
  if (!nick || !token) return res.status(400).json({ error: 'nick and token required' });
  // Tokens are hashed at rest (migration 045) — the map is keyed by hash.
  const client = clientByResetToken.get(sha256hex(String(token)));
  if (!client) return res.status(401).json({ error: 'Invalid token' });
  // Verify nick belongs to this client (WP2: live → roster → history; a new
  // client without traffic history passes via the live/roster steps).
  const owned = await isModemOwned({ nick, portNameFilter: client.portName, deps: _ownershipDeps });
  if (!owned) return res.status(403).json({ error: 'Modem not assigned to this client' });
  // Try all servers
  for (const server of apiServers) {
    try {
      const result = await fetchApi(server, `/apix/reset_modem?arg=${encodeURIComponent(nick)}`);
      if (result) return res.json({ ok: true, result });
    } catch (e) { /* try next server */ }
  }
  res.status(404).json({ error: 'Modem not found' });
}

r.post('/api/client/set_rotation', authMiddleware, async (req, res) => {
  try {
    const { nick, serverName, minutes } = req.body;
    if (!nick || !serverName) return res.status(400).json({ error: 'nick and serverName required' });
    const mins = parseInt(minutes);
    if (isNaN(mins) || mins < 0 || mins > 10080) return res.status(400).json({ error: 'minutes must be 0-10080' });

    // Verify the modem belongs to this client (WP2: single priority chain in
    // src/modems/ownership.js — live binding → roster (24h) → traffic_hourly).
    //
    // Historical note: an even older check compared p.portID (after stripping
    // a stale "S1_/S2_" prefix) against `nick`. mergeServerData prefixes portID
    // with the server name (e.g. "MD2_…"), and portID is NOT the modem nick
    // anyway, so it denied EVERY real modem → "Modem not assigned to your
    // account". Do not reintroduce portID-based matching here.
    const portNameFilter = req.user.portNameFilter;
    if (portNameFilter !== '*') {
      const owned = await isModemOwned({ nick, portNameFilter, deps: _ownershipDeps });
      if (!owned) return res.status(403).json({ error: 'Modem not assigned to your account' });
    }

    const server = findServer(serverName);
    if (!server) return res.status(400).json({ error: 'Server not found' });

    // Get current modem IMEI from status
    const statusData = await fetchApi(server, '/apix/show_status_json');
    const modems = Array.isArray(statusData) ? statusData : [];
    const modem = modems.find(m => m.modem_details && m.modem_details.NICK === nick);
    if (!modem) return res.status(404).json({ error: 'Modem not found' });

    const rawImei = String(modem.modem_details.IMEI).replace(/^S\d+_/, '');
    // Тот же механизм, что в admin store_modem: /conf/edit + merge формы +
    // verify-after-write. Старые /crud/store_modem + /modem/settings молча
    // не применяли ротацию (см. историю в proxies.js) → «Failed to set rotation».
    const form = await proxyConf.getConfForm(server, `/conf/edit/${rawImei}`);
    if (!form.ok) {
      logger.warn({ serverName, rawImei, reason: form.reason }, '[SetRotation] /conf/edit недоступен');
      return res.status(502).json({ error: `ProxySmart не отдал форму модема (${form.reason})` });
    }
    const merged = { ...form.fields, IMEI: rawImei, AUTO_IP_ROTATION: String(mins) };
    const posted = await proxyConf.postConfForm(server, `/conf/edit/${rawImei}`, merged);
    if (!posted.ok) {
      logger.warn({ serverName, rawImei, reason: posted.reason }, '[SetRotation] POST не прошёл');
      return res.status(502).json({ error: `ProxySmart не сохранил настройки (${posted.reason})` });
    }
    const back = await proxyConf.verifyRotation(server, `/conf/edit/${rawImei}`, mins);
    if (!back.ok) {
      logger.warn({ serverName, rawImei, mins, gotRot: back.gotRot }, '[SetRotation] verify-after-write FAILED');
      return res.status(502).json({ error: `ProxySmart не применил ротацию: запрошено ${mins}, в форме ${back.gotRot == null ? 'нет данных' : back.gotRot}` });
    }
    modemRotationCache[serverName + ':' + rawImei] = mins;
    proxySmart.invalidateCache();

    logger.info(`[Rotation] Client ${req.user.login} set ${nick} rotation to ${mins} min (verified)`);
    auditLog(req.user.login, 'client_set_rotation', { nick, serverName, minutes: mins, ip: getClientIp(req) });
    res.json({ ok: true, minutes: mins });
  } catch (err) { res.status(502).json({ error: 'Failed to set rotation', details: err.message }); }
});

r.get('/api/client/credentials_export', authMiddleware, async (req, res) => {
  try {
    const results = await fetchAllServersDataCached();
    const merged = mergeServerData(results, req.user.portNameFilter);

    const COUNTRIES = SERVER_COUNTRIES;
    // Build server URL map for direct reset URLs
    const credentials = [];

    for (const [imei, portList] of Object.entries(merged.ports)) {
      const serverName = extractServerName(imei);
      const ci = COUNTRIES[serverName] || {};
      let modemNick = imei;
      for (const m of merged.status) {
        if (m.modem_details?.IMEI === imei) {
          modemNick = m.modem_details.NICK || imei;
          break;
        }
      }
      for (const p of portList) {
        if (p.LOGIN && p.PASSWORD) {
          credentials.push({
            modem: modemNick,
            server: serverName,
            serverIp: ci.serverIp || '',
            httpPort: p.HTTP_PORT || '',
            socksPort: p.SOCKS_PORT || '',
            login: p.LOGIN,
            password: p.PASSWORD,
            httpProxy: ci.serverIp ? `${ci.serverIp}:${p.HTTP_PORT}` : '',
            socks5Proxy: ci.serverIp ? `${ci.serverIp}:${p.SOCKS_PORT}` : '',
            httpCreds: p.http_creds || '',
            socks5Creds: p.socks5_creds || '',
            resetUrl: p.RESET_SECURE_LINK?.URL || ''
          });
        }
      }
    }

    // SEC: serverInfo with user/pass removed — clients use /api/client/reset_ip instead
    const clientInfo = clientByLogin.get(req.user.login);
    auditLog(req.user.login, 'client_export_creds', { count: credentials.length, ip: getClientIp(req) });
    res.json({
      credentials,
      clientName: req.user.login,
      exportDate: new Date().toISOString(),
      // Migration 045: tokens are hashed at rest — the export can no longer
      // carry the usable token. Get a fresh link via reset_link/rotate.
      resetToken: ''
    });
  } catch (err) { res.status(502).json({ error: 'Export failed', details: err.message }); }
});

// Issue a NEW self-service reset link (WP7.4). Generates a fresh token,
// stores only its SHA-256 hash, and returns the plaintext + URL ONCE —
// the previous link dies immediately (rotation, not duplication).
r.post('/api/client/reset_link/rotate', authMiddleware, (req, res) => {
  const client = clientByLogin.get(req.user.login);
  if (!client) return res.status(404).json({ error: 'Client not found' });
  const plain = crypto.randomBytes(16).toString('hex');
  // Keep the lookup map in sync surgically (a full rebuildClientMaps() would
  // re-key every map for one token change; the client object identity is
  // stable, so re-keying just this entry is safe).
  if (client.resetToken) clientByResetToken.delete(client.resetToken);
  client.resetToken = sha256hex(plain);
  clientByResetToken.set(client.resetToken, client);
  saveClients(clients);
  try { auditLog(req.user.login, 'client_reset_link_rotate', { ip: getClientIp(req) }); } catch (_) { /* best-effort */ }
  const base = req.protocol + '://' + (req.get('host') || '');
  res.json({ ok: true, token: plain, url: `${base}/api/client/reset_ip_by_token?token=${plain}&nick=` });
});

r.get('/api/client/referral', authMiddleware, (req, res) => {
  const client = clientByLogin.get(req.user.login);
  if (!client) return res.status(404).json({ error: 'Client not found' });
  const referrals = clients.filter(c => c.referred_by === client.id);
  // B2C Э3 (WP5): статус привязки Telegram для блока в «Профиле».
  // botUsername — из kv-кэша getMe (ключ tg_bot_username, см. telegram/bot.js),
  // fallback — настройка telegram_bot_username. Общие поля, не за retail-флагом.
  let botUsername = '';
  try {
    const row = db.prepare("SELECT value FROM kv_store WHERE key = 'tg_bot_username'").get();
    botUsername = (row && row.value) || getSetting('telegram_bot_username', '') || '';
  } catch (_) { botUsername = getSetting('telegram_bot_username', '') || ''; }
  res.json({
    referrals_count: referrals.length,
    referral_balance: client.referral_balance || 0,
    // B2C (WP3): вкладка «Профиль» ЛК берёт отсюда же email/верификацию и
    // реф-код для ссылки /register?ref= — отдельный profile-endpoint не нужен.
    referral_code: client.referral_code || '',
    email: client.email || '',
    emailVerified: !!client.emailVerified,
    tgLinked: !!client.tgChatId,
    tgUsername: client.tgUsername || '',   // 065: @username привязанного TG
    botUsername,
    referrals: referrals.map(r => ({ name: r.name, createdAt: r.createdAt }))
  });
});

// WP6 (Этап 7): вывод рефкомиссии НА БАЛАНС — самообслуживание из ЛК.
// Атомарно через atomicCredit с self-referral: referral_balance −= amount и
// balance += amount в ОДНОЙ транзакции (+ строка ledger referral_withdraw).
// Вывод деньгами на карту — вручную через оператора (админ: referral_payout).
r.post('/api/client/referral/withdraw_to_balance', authMiddleware, (req, res) => {
  const client = clientByLogin.get(req.user.login);
  if (!client) return res.status(404).json({ error: 'Client not found' });
  const amount = Math.round((client.referral_balance || 0) * 100) / 100;
  if (!(amount > 0)) return res.status(400).json({ error: 'Нет средств к выводу' });
  try {
    const result = atomicCredit(client.id, amount, {
      type: 'referral_withdraw', source: 'referral',
      amount,
      date: new Date().toISOString().slice(0, 10),
      timestamp: new Date().toISOString(),
      note: 'Вывод партнёрской комиссии на баланс',
    }, { referral: { referrerId: client.id, delta: -amount } });
    saveClients(clients);
    auditLog(client.login, 'referral_withdraw_to_balance', { amount, ip: getClientIp(req) });
    logActivity('client', 'info', 'referral_withdraw', client.login,
      `Партнёрская комиссия выведена на баланс: ${amount} ₽`, { amount });
    res.json({ ok: true, amount, balance: result.balanceAfter });
  } catch (e) {
    logger.error(`[Referral] withdraw ${client.login}: ${e.message}`);
    res.status(500).json({ error: 'Не удалось выполнить вывод — попробуйте позже' });
  }
});

r.get('/api/client/documents', authMiddleware, (req, res) => {
  const client = clientByLogin.get(req.user.login);
  if (!client) return res.json([]);
  res.json((client.documents || []).map(d => ({ id: d.id, name: d.name, date: d.date })));
});

r.get('/api/client/documents/:docId/download', authMiddleware, (req, res) => {
  const client = clientByLogin.get(req.user.login);
  if (!client) return res.status(404).json({ error: 'Not found' });
  const doc = (client.documents || []).find(d => d.id === req.params.docId);
  if (!doc) return res.status(404).json({ error: 'Document not found' });
  const filePath = path.join(DOCUMENTS_DIR, doc.fileName);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });
  const ext = path.extname(doc.name || doc.fileName);
  const mimeTypes = { '.pdf': 'application/pdf', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.doc': 'application/msword', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.png': 'image/png', '.jpg': 'image/jpeg' };
  res.setHeader('Content-Type', mimeTypes[ext] || 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(doc.name)}`);
  fs.createReadStream(filePath).pipe(res);
});

r.get('/api/client/closing_documents', authMiddleware, (req, res) => {
  const client = clientByLogin.get(req.user.login);
  if (!client) return res.json({ documents: [] });
  res.json({ documents: (client.closingDocuments || []).map(d => ({
    id: d.id,
    period: d.period,
    totalAmount: d.totalAmount,
    status: d.status,
    createdAt: d.createdAt,
    actNumber: d.actNumber,
    items: d.items
  }))});
});

r.get('/api/client/closing_documents/:docId/pdf', authMiddleware, async (req, res) => {
  const client = clientByLogin.get(req.user.login);
  if (!client) return res.status(404).json({ error: 'Client not found' });
  const doc = (client.closingDocuments || []).find(d => d.id === req.params.docId);
  if (!doc) return res.status(404).json({ error: 'Document not found' });

  if (!doc.tochkaDocumentId) {
    return res.status(404).json({ error: 'Документ не связан с Точкой. PDF недоступен.' });
  }

  try {
    const result = await tochkaRequest('GET', `/uapi/invoice/v1.0/closing-documents/${tochkaConfig.customerCode}/${doc.tochkaDocumentId}/file`);
    if (result.buffer) {
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${doc.actNumber || 'act'}.pdf"`);
      res.send(result.buffer);
    } else {
      res.status(502).json({ error: 'Failed to get PDF from Tochka' });
    }
  } catch (err) {
    res.status(502).json({ error: 'Failed to get PDF', details: err.message });
  }
});

r.get('/api/client/bills', authMiddleware, (req, res) => {
  const client = clientByLogin.get(req.user.login);
  if (!client) return res.json({ bills: [] });
  res.json({ bills: (client.bills || []).map(b => ({
    id: b.id,
    period: b.period,
    amount: b.amount,
    status: b.status,
    createdAt: b.createdAt,
    billNumber: b.billNumber,
    hasPdf: !!b.tochkaBillId
  }))});
});

r.get('/api/client/bills/:billId/pdf', authMiddleware, async (req, res) => {
  const client = clientByLogin.get(req.user.login);
  if (!client) return res.status(404).json({ error: 'Client not found' });
  const bill = (client.bills || []).find(b => b.id === req.params.billId);
  if (!bill || !bill.tochkaBillId) return res.status(404).json({ error: 'Bill not found' });

  try {
    const result = await tochkaRequest('GET', `/uapi/invoice/v1.0/bills/${tochkaConfig.customerCode}/${bill.tochkaBillId}/file`);
    if (result.status === 200 && result.buffer) {
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(bill.billNumber + '.pdf')}`);
      res.send(result.buffer);
    } else {
      res.status(500).json({ error: 'Failed to download PDF' });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Установка/смена email из ЛК — ОБЩИЙ endpoint для ВСЕХ типов клиентов
// (НЕ за retail-флагом): у TG-созданных аккаунтов email пуст, у части B2B
// его тоже нет. Смена сбрасывает emailVerified; verify-письмо уходит только
// при включённой рознице (тот же паттерн, что в registration.js /api/register).
r.post('/api/client/email', authMiddleware, validate(ClientEmailSchema), (req, res) => {
  const client = clientByLogin.get(req.user.login);
  if (!client) return res.status(404).json({ error: 'Client not found' });
  const normEmail = String(req.body.email).trim().toLowerCase();
  if (clients.some(c => c !== client && c.email && c.email.toLowerCase() === normEmail)) {
    return res.status(409).json({ error: 'Аккаунт с этим email уже существует' });
  }
  client.email = normEmail;
  client.emailVerified = false;
  try {
    saveClients(clients);
  } catch (e) {
    // idx_clients_email — частичный UNIQUE по clients(email) (миграция 060).
    if (e && (e.code === 'SQLITE_CONSTRAINT_UNIQUE' || /UNIQUE constraint/i.test(e.message || ''))) {
      return res.status(409).json({ error: 'Аккаунт с этим email уже существует' });
    }
    throw e;
  }
  auditLog(req.user.login, 'email_changed', { email: normEmail, ip: getClientIp(req) });
  let verificationSent = false;
  if (getSetting('retail_enabled', false) && normEmail) {
    const verifyToken = authTokensDb.issue(client.login, 'verify_email');
    const base = (req.headers['x-forwarded-proto'] || req.protocol) + '://' + req.headers.host;
    verificationSent = true;
    mailer.send({
      to: normEmail, kind: 'verify_email',
      subject: 'Подтвердите email — Arendaproxy',
      text: `Подтвердите адрес: ${base}/verify?token=${verifyToken}\nСсылка действует 24 часа.`,
      html: mailer.renderTemplate({
        title: 'Подтвердите email',
        intro: 'Вы изменили email в личном кабинете Arendaproxy.ru. Подтвердите новый адрес — ссылка действует 24 часа.',
        ctaText: 'Подтвердить email', ctaUrl: `${base}/verify?token=${verifyToken}`,
        note: 'Если вы не меняли email — срочно свяжитесь с поддержкой.',
      }),
    }).catch(e => logger.warn('[ClientEmail] verify email send failed: ' + e.message));
  }
  res.json({ ok: true, email: normEmail, verificationSent });
});

  return r;
};
