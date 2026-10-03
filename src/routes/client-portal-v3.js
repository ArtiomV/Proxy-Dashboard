'use strict';
//
// src/routes/client-portal-v3.js — эндпоинты ЛК v3 (макет «Клиентский кабинет
// v3»), которых не было в client-portal.js:
//
//   GET  /api/client/rotation_log        — журнал ротаций IP своего модема (3d «Ротации IP»)
//   GET  /api/client/proxy_prefs         — свои названия прокси + флаги «уведомлять, если офлайн»
//   POST /api/client/proxy_prefs         — сохранить название / флаг для одного ника
//   POST /api/client/proxy_password      — сгенерировать новый пароль порта (3d «Настройки»)
//   GET  /api/client/profile             — учётная запись + реквизиты для документов (3j)
//   GET  /api/client/referral_stats      — начисления партнёрки, «начислено всего», активные (3i)
//
// Владение: модем — через resolveOwnedModem (та же цепочка, что set_rotation),
// порт — через выборку mergeServerData по portName клиента (чужой порт в неё
// не попадает).

const express = require('express');
const crypto = require('crypto');
const { resolveOwnedModem } = require('../modems/ownership');
const { REFERRAL_PCT, referralCommission } = require('../billing/referral');

const PREFS_KEY = id => 'client_proxy_prefs:' + id;
const LABEL_MAX = 60;

// caller/target_mode из ProxySmart → причина в терминах макета
function rotationReason(row) {
  const c = String(row.caller || '').toLowerCase();
  const m = String(row.target_mode || '').toLowerCase();
  if (/cron|auto|timer|schedul|interval/.test(c) || /auto|timer|interval/.test(m)) return 'timer';
  if (/token|link|secure|reset_url|url/.test(c)) return 'link';
  if (/api/.test(c)) return 'api';
  if (c) return 'manual';
  return 'timer';
}

function create(deps) {
  const {
    db, logger, authMiddleware,
    fetchAllServersDataCached, mergeServerData, fetchApi, postApi, findServer,
    knownModems, clients, clientById, clientByLogin, ledgerDb,
    auditLog, getClientIp, proxySmart, getSetting,
  } = deps;
  const r = express.Router();
  const _ownershipDeps = { fetchAllServersDataCached, mergeServerData, knownModems, db };

  function readPrefs(clientId) {
    try {
      const row = db.prepare('SELECT value FROM kv_store WHERE key = ?').get(PREFS_KEY(clientId));
      const v = row ? JSON.parse(row.value) : {};
      return { labels: v.labels || {}, notifyOffline: v.notifyOffline || {} };
    } catch (_) { return { labels: {}, notifyOffline: {} }; }
  }
  function writePrefs(clientId, prefs) {
    db.prepare("INSERT OR REPLACE INTO kv_store (key, value, updated_at) VALUES (?, ?, datetime('now'))")
      .run(PREFS_KEY(clientId), JSON.stringify(prefs));
  }

  // ── Журнал ротаций ────────────────────────────────────────────────────
  r.get('/api/client/rotation_log', authMiddleware, async (req, res) => {
    const nick = String(req.query.nick || '');
    const serverName = String(req.query.serverName || '');
    if (!nick || !serverName) return res.status(400).json({ error: 'nick and serverName required' });
    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 30, 1), 90);
    try {
      const ent = await resolveOwnedModem({ nick, serverName, portNameFilter: req.user.portNameFilter, purpose: 'read', deps: _ownershipDeps });
      if (!ent) return res.status(403).json({ error: 'Modem not assigned to your account' });
      const since = new Date(Date.now() - days * 864e5).toISOString().slice(0, 19).replace('T', ' ');
      const rows = db.prepare(
        `SELECT old_ip, new_ip, started_at, ended_at, took_sec, caller, target_mode
           FROM rotation_log
          WHERE server_name = ? AND nick = ? AND started_at >= ?
          ORDER BY started_at DESC LIMIT 5000`
      ).all(serverName, nick, since);
      const counts = { all: 0, timer: 0, manual: 0, ext: 0 };
      const perDay = {};
      const ips = new Set();
      let tookSum = 0, tookN = 0, today = 0;
      const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Moscow' });
      const entries = rows.map(row => {
        const reason = rotationReason(row);
        counts.all++;
        if (reason === 'timer') counts.timer++;
        else if (reason === 'manual') counts.manual++;
        else counts.ext++;
        const day = String(row.started_at || '').slice(0, 10);
        perDay[day] = (perDay[day] || 0) + 1;
        if (day === todayStr) today++;
        if (row.new_ip) ips.add(row.new_ip);
        if (row.took_sec > 0) { tookSum += row.took_sec; tookN++; }
        return { time: row.started_at, from: row.old_ip || '', to: row.new_ip || '', took: row.took_sec || null, reason };
      });
      const reason = String(req.query.reason || 'all');
      const filtered = reason === 'all' ? entries
        : entries.filter(e => (reason === 'ext' ? (e.reason === 'link' || e.reason === 'api') : e.reason === reason));
      const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
      const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 10, 1), 200);
      res.json({
        days, counts, perDay, today,
        avgTook: tookN ? Math.round(tookSum / tookN * 10) / 10 : null,
        uniqueIps: ips.size,
        total: filtered.length,
        entries: filtered.slice(offset, offset + limit),
      });
    } catch (e) {
      logger.error('[client/rotation_log] ' + e.message);
      res.status(500).json({ error: 'rotation_log failed' });
    }
  });

  // ── Настройки прокси: названия и уведомления ─────────────────────────
  r.get('/api/client/proxy_prefs', authMiddleware, (req, res) => {
    const client = clientByLogin.get(req.user.login);
    if (!client) return res.status(404).json({ error: 'Client not found' });
    const p = readPrefs(client.id);
    res.json({ labels: p.labels, notifyOffline: p.notifyOffline, tgLinked: !!client.tgChatId });
  });

  r.post('/api/client/proxy_prefs', authMiddleware, async (req, res) => {
    const client = clientByLogin.get(req.user.login);
    if (!client) return res.status(404).json({ error: 'Client not found' });
    const body = req.body || {};
    const nick = String(body.nick || '');
    if (!nick) return res.status(400).json({ error: 'nick required' });
    const ent = await resolveOwnedModem({ nick, serverName: body.serverName || undefined, portNameFilter: req.user.portNameFilter, purpose: 'read', deps: _ownershipDeps });
    if (!ent) return res.status(403).json({ error: 'Modem not assigned to your account' });
    const p = readPrefs(client.id);
    if (body.label !== undefined) {
      const label = String(body.label || '').replace(/\s+/g, ' ').trim().slice(0, LABEL_MAX);
      if (label) p.labels[nick] = label; else delete p.labels[nick];
    }
    if (body.notifyOffline !== undefined) {
      if (body.notifyOffline) p.notifyOffline[nick] = true; else delete p.notifyOffline[nick];
    }
    try { writePrefs(client.id, p); } catch (e) {
      logger.error('[client/proxy_prefs] ' + e.message);
      return res.status(500).json({ error: 'Не удалось сохранить' });
    }
    try { auditLog(req.user.login, 'client_proxy_prefs', { nick, ip: getClientIp(req) }); } catch (_) { /* best-effort */ }
    res.json({ ok: true, labels: p.labels, notifyOffline: p.notifyOffline });
  });

  // ── Новый пароль порта ───────────────────────────────────────────────
  // Тот же механизм, что /api/admin/update_port_creds: store_port + apply_port.
  // Владение — порт присутствует в выборке mergeServerData по portName клиента.
  r.post('/api/client/proxy_password', authMiddleware, async (req, res) => {
    const portId = String((req.body && req.body.portId) || '');
    const serverName = String((req.body && req.body.serverName) || '');
    if (!portId || !serverName) return res.status(400).json({ error: 'portId and serverName required' });
    if (req.user.portNameFilter === '*') return res.status(400).json({ error: 'Только для клиентских аккаунтов' });
    try {
      const results = await fetchAllServersDataCached();
      const merged = mergeServerData(results, req.user.portNameFilter);
      let imeiKey = null, port = null;
      for (const [k, list] of Object.entries(merged.ports || {})) {
        for (const p of list || []) {
          if (p.portID === portId && p._server === serverName) { imeiKey = k; port = p; break; }
        }
        if (port) break;
      }
      if (!port) return res.status(403).json({ error: 'Port not assigned to your account' });
      if (port._cached) return res.status(409).json({ error: 'Сервер прокси сейчас недоступен — попробуйте позже' });
      const server = findServer(serverName);
      if (!server) return res.status(400).json({ error: 'Server not found' });
      const prefix = serverName + '_';
      const rawImei = imeiKey.startsWith(prefix) ? imeiKey.slice(prefix.length) : imeiKey;
      const rawPortId = portId.startsWith(prefix) ? portId.slice(prefix.length) : portId;
      // 12 символов [A-Za-z0-9] — как у выдаваемых паролей, без спецсимволов (URL-safe)
      const ABC = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
      const bytes = crypto.randomBytes(12);
      let password = '';
      for (let i = 0; i < 12; i++) password += ABC[bytes[i] % ABC.length];
      await postApi(server, '/crud/store_port', { IMEI: rawImei, portID: rawPortId, proxy_password: password });
      try { await fetchApi(server, `/apix/apply_port?arg=${encodeURIComponent(rawPortId)}`); }
      catch (e) { logger.warn(`[client/proxy_password] apply_port ${rawPortId}: ${e.message}`); }
      if (proxySmart && proxySmart.invalidateCache) proxySmart.invalidateCache();
      auditLog(req.user.login, 'client_proxy_password', { serverName, portId: rawPortId, ip: getClientIp(req) });
      res.json({ ok: true, password, login: port.LOGIN || '' });
    } catch (e) {
      logger.error('[client/proxy_password] ' + e.message);
      res.status(502).json({ error: 'Не удалось сменить пароль', details: e.message });
    }
  });

  // ── Профиль ──────────────────────────────────────────────────────────
  const TYPE_LABEL = { legal: 'Юридическое лицо', company: 'Юридическое лицо', ip: 'Индивидуальный предприниматель', individual: 'Физическое лицо', person: 'Физическое лицо', retail: 'Физическое лицо' };
  r.get('/api/client/profile', authMiddleware, (req, res) => {
    const c = clientByLogin.get(req.user.login);
    if (!c) return res.status(404).json({ error: 'Client not found' });
    let botUsername = '';
    try {
      const row = db.prepare("SELECT value FROM kv_store WHERE key = 'tg_bot_username'").get();
      botUsername = (row && row.value) || getSetting('telegram_bot_username', '') || '';
    } catch (_) { botUsername = getSetting('telegram_bot_username', '') || ''; }
    let pwChangedAt = null;
    try {
      const row = db.prepare("SELECT timestamp FROM audit_log WHERE admin = ? AND action = 'password_changed' ORDER BY id DESC LIMIT 1").get(c.login);
      pwChangedAt = row ? row.timestamp : null;
    } catch (_) { /* таблицы/колонок может не быть — поле опционально */ }
    const ct = String(c.clientType || '').toLowerCase();
    res.json({
      login: c.login,
      name: c.name || '',
      email: c.email || '',
      emailVerified: !!c.emailVerified,
      clientType: ct,
      clientTypeLabel: TYPE_LABEL[ct] || (c.inn ? 'Юридическое лицо' : 'Физическое лицо'),
      billingType: c.billingType || 'per_gb',
      price: c.price || 0,
      currency: c.currency || 'RUB',
      createdAt: c.createdAt || null,
      legal: {
        name: c.legalName || '',
        inn: c.inn || '',
        kpp: c.kpp || '',
        address: c.address || '',
        contract: c.contractInfo || '',
        contractDate: c.contractDate || '',
      },
      tgLinked: !!c.tgChatId,
      tgUsername: c.tgUsername || '',
      botUsername,
      pwChangedAt,
    });
  });

  // ── Партнёрка: начисления ────────────────────────────────────────────
  const PAY_TYPES = new Set(['payment', 'bank_payment', 'card_payment']);
  r.get('/api/client/referral_stats', authMiddleware, (req, res) => {
    const c = clientByLogin.get(req.user.login);
    if (!c) return res.status(404).json({ error: 'Client not found' });
    const referred = clients.filter(x => x.referred_by === c.id);
    const monthAgo = new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);
    const rows = [];
    let active = 0;
    for (const ref of referred) {
      let entries = [];
      try { entries = ledgerDb.listByClient(ref.id); } catch (_) { entries = []; }
      let isActive = false;
      for (const e of entries) {
        const d = e.date || (e.timestamp || '').slice(0, 10);
        if (d >= monthAgo && (e.type === 'charge' || PAY_TYPES.has(e.type))) isActive = true;
        if (PAY_TYPES.has(e.type) && e.amount > 0) {
          rows.push({ date: d, ts: e.timestamp || d, client: ref.name || ref.login || '—', pay: e.amount, fee: referralCommission(e.amount) });
        } else if (e.type === 'payment_reversal' && e.amount) {
          const amt = -Math.abs(e.amount);
          rows.push({ date: d, ts: e.timestamp || d, client: ref.name || ref.login || '—', pay: amt, fee: -referralCommission(Math.abs(e.amount)) });
        }
      }
      if (isActive) active++;
    }
    rows.sort((a, b) => String(b.ts).localeCompare(String(a.ts)));
    // «Начислено всего» — точно: остаток + всё, что уже выведено (на баланс
    // или деньгами оператором). Строки rows — расчётные (ставка × платёж).
    let withdrawn = 0;
    try {
      for (const e of ledgerDb.listByClient(c.id)) {
        if (e.type === 'referral_withdraw' || (e.type === 'payout' && e.source === 'referral')) withdrawn += Math.abs(e.amount || 0);
      }
    } catch (_) { /* best-effort */ }
    const balance = c.referral_balance || 0;
    const firstDate = rows.length ? rows[rows.length - 1].date : null;
    res.json({
      rate: REFERRAL_PCT,
      balance,
      totalEarned: Math.round((balance + withdrawn) * 100) / 100,
      since: firstDate,
      referrals: referred.length,
      active,
      code: c.referral_code || '',
      mainBalance: c.balance || 0,
      accruals: rows.slice(0, 100).map(({ ts, ...x }) => x),
    });
  });

  // ── Запрос счёта для юрлица (3f «Пополнить» → «Счёт для юрлица») ─────
  // Счёт выставляет оператор (банк Точка, один счёт за период) — клиент
  // отправляет запрос: TG-алерт bill_requested + след в system_log.
  const _billReqAt = new Map();
  r.post('/api/client/bill_request', authMiddleware, (req, res) => {
    const c = clientByLogin.get(req.user.login);
    if (!c) return res.status(404).json({ error: 'Client not found' });
    const amount = Math.round(parseFloat(req.body && req.body.amount));
    if (!(amount >= 1000) || amount > 10000000) return res.status(400).json({ error: 'Сумма — от 1 000 до 10 000 000 ₽' });
    const last = _billReqAt.get(c.id) || 0;
    if (Date.now() - last < 60 * 1000) return res.status(429).json({ error: 'Запрос уже отправлен — подождите минуту' });
    _billReqAt.set(c.id, Date.now());
    const payload = { client_id: c.id, client: c.name || c.login, amount, payer: c.legalName || c.name || '', inn: c.inn || '', email: c.email || '' };
    try { require('../telegram/alerts').trigger('bill_requested', payload); } catch (e) { logger.warn('[bill_request] alert: ' + e.message); }
    try { if (deps.logActivity) deps.logActivity('client', 'info', 'bill_request', c.login, `Запрос счёта из ЛК: ${amount} ₽`, { amount }); } catch (_) { /* best-effort */ }
    auditLog(req.user.login, 'client_bill_request', { amount, ip: getClientIp(req) });
    res.json({ ok: true, amount, email: c.email || '' });
  });

  // ── Вебхук клиента (03.10): одна запись на клиента (миграция 110) ──────
  // События: proxy_offline, proxy_online, ip_changed, payment_received,
  // daily_charge. Доставка — src/webhooks.js (дергается из SSE-пушей).
  const WEBHOOK_EVENTS = ['proxy_offline', 'proxy_online', 'ip_changed', 'payment_received', 'daily_charge'];
  r.get('/api/client/webhook', authMiddleware, (req, res) => {
    const c = clientByLogin.get(req.user.login);
    if (!c) return res.status(404).json({ error: 'Client not found' });
    try {
      const row = db.prepare('SELECT url, events, enabled, last_ok_at, last_error FROM client_webhooks WHERE client_id = ?').get(c.id);
      res.json({
        webhook: row ? { url: row.url, events: String(row.events).split(',').filter(Boolean), enabled: !!row.enabled, lastOkAt: row.last_ok_at, lastError: row.last_error } : null,
        availableEvents: WEBHOOK_EVENTS,
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  r.post('/api/client/webhook', authMiddleware, (req, res) => {
    const c = clientByLogin.get(req.user.login);
    if (!c) return res.status(404).json({ error: 'Client not found' });
    const body = req.body || {};
    const url = String(body.url || '').trim().slice(0, 500);
    const events = (Array.isArray(body.events) ? body.events : []).filter(e => WEBHOOK_EVENTS.includes(e));
    const enabled = body.enabled !== false;
    try {
      if (!url) {
        // пустой URL — удаление вебхука
        db.prepare('DELETE FROM client_webhooks WHERE client_id = ?').run(c.id);
        return res.json({ ok: true, webhook: null });
      }
      let parsed;
      try { parsed = new URL(url); } catch (_) { return res.status(400).json({ error: 'Некорректный URL' }); }
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return res.status(400).json({ error: 'URL должен быть http(s)' });
      if (!events.length) return res.status(400).json({ error: 'Выберите хотя бы одно событие' });
      db.prepare(`INSERT INTO client_webhooks (client_id, url, events, enabled) VALUES (?, ?, ?, ?)
                  ON CONFLICT(client_id) DO UPDATE SET url=excluded.url, events=excluded.events, enabled=excluded.enabled`)
        .run(c.id, url, events.join(','), enabled ? 1 : 0);
      auditLog(req.user.login, 'client_webhook_save', { url, events, enabled, ip: getClientIp(req) });
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  r.post('/api/client/webhook/test', authMiddleware, (req, res) => {
    const c = clientByLogin.get(req.user.login);
    if (!c) return res.status(404).json({ error: 'Client not found' });
    try {
      if (deps.webhooksDeliver) deps.webhooksDeliver(req.user.login, 'payment_received', { test: true, amount: 0, note: 'Тестовое событие из личного кабинета' }, true);
      res.json({ ok: true, note: 'Тестовое событие отправлено (payment_received). Статус доставки появится в течение нескольких секунд.' });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  return r;
}

module.exports = create;
module.exports.rotationReason = rotationReason;
