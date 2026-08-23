'use strict';
//
// src/routes/servers.js — API servers + global settings (Stage 3).
//
// 6 admin-only routes:
//   GET    /api/admin/servers         — list registered ProxySmart servers
//   POST   /api/admin/servers         — add a new server (validates panel auth first)
//   PATCH  /api/admin/servers/:name   — update server metadata + creds
//   DELETE /api/admin/servers/:name   — drop a server
//   GET    /api/admin/settings        — read appSettings blob
//   PUT    /api/admin/settings        — bounded-validation writes to appSettings

const express = require('express');
const credCheck = require('../services/cred-check');

module.exports = function createServersRouter(deps) {
  const {
    db, logger, authMiddleware, adminMiddleware,
    apiServers, SERVER_COUNTRIES, appSettings,
    fetchApi, saveApiServersToDb, proxySmart,
    auditLog, getClientIp, getSetting,
    // Stage 14.2: setSettings() batches the validated patch + saves once;
    // no more direct `appSettings.x = ...` mutations in this router.
    setSettings, rescheduleSpeedtests, rescheduleProxyCheck,
  } = deps;
  const r = express.Router();

// WP5+WP6: живая статистика сервера — системный RPS + активные коннекты +
// уникальность IP-пула. Источники: /modem/common_status (rps, count_connections,
// devices) и /apix/unique_ips_json (UNIQUE_IPS_PERCENT за 14 дней). unique_ips
// — это 14-дневный скан, поэтому кэшируем per-server на 10 мин; common_status
// дешёвый, но кэшируем вместе одним TTL для простоты. Per-server graceful:
// упавший бокс → null (карточка просто не покажет плашки).
const _srvStatsCache = new Map();   // name → { at, data }
const SRV_STATS_TTL_MS = 10 * 60 * 1000;

r.get('/api/admin/server_stats', authMiddleware, adminMiddleware, async (req, res) => {
  const out = {};
  await Promise.all(apiServers.map(async (s) => {
    const cached = _srvStatsCache.get(s.name);
    if (cached && (Date.now() - cached.at) < SRV_STATS_TTL_MS) { out[s.name] = cached.data; return; }
    try {
      const [common, uniq] = await Promise.all([
        fetchApi(s, '/modem/common_status', 8000).catch(() => null),
        fetchApi(s, '/apix/unique_ips_json', 12000).catch(() => null),
      ]);
      if (!common && !uniq) { out[s.name] = null; return; }
      const data = {
        rps: common && Number.isFinite(+common.rps) ? Math.round(+common.rps) : null,
        conns: common && Number.isFinite(+common.count_connections) ? +common.count_connections : null,
        devices: common && Number.isFinite(+common.devices) ? +common.devices : null,
        uniqueIpPct: uniq && Number.isFinite(+uniq.UNIQUE_IPS_PERCENT) ? +uniq.UNIQUE_IPS_PERCENT : null,
        rotations: uniq && Number.isFinite(+uniq.TOTAL_ROTATIONS) ? +uniq.TOTAL_ROTATIONS : null,
        uniqDays: uniq && Number.isFinite(+uniq.DAYS) ? +uniq.DAYS : null,
      };
      _srvStatsCache.set(s.name, { at: Date.now(), data });
      out[s.name] = data;
    } catch (e) {
      logger.info(`[ServerStats] ${s.name}: ${e.message}`);
      out[s.name] = null;
    }
  }));
  res.json({ stats: out });
});

// ServerMetrics (джоба src/jobs/server-metrics.js): последняя строка метрик
// по каждому боксу + возраст данных (сек). SSH-поля могут отсутствовать —
// фронт показывает то, что есть (HTTP-метрики панели), с пометкой.
r.get('/api/admin/server_metrics', authMiddleware, adminMiddleware, (req, res) => {
  const byName = {};
  const nowMs = Date.now();
  const generatedAt = new Date(nowMs).toISOString();
  const sinceIso = new Date(nowMs - 24 * 3600e3).toISOString();
  try {
    const rows = db.prepare(`SELECT * FROM server_metrics
      WHERE id IN (SELECT MAX(id) FROM server_metrics GROUP BY server_name)`).all();
    // Средние за сутки по числовым метрикам (NULL-поля AVG игнорирует сам).
    // collected_at хранится ISO со 'T' — сравниваем с ISO-строкой, не datetime().
    const avgRows = db.prepare(`SELECT server_name,
        AVG(cpu_pct) a_cpu, AVG(mem_used_pct) a_mem, AVG(disk_used_pct) a_disk,
        AVG(temp_c) a_temp, AVG(conns) a_conns, COUNT(*) samples
      FROM server_metrics WHERE collected_at > ? GROUP BY server_name`).all(sinceIso);
    const avg24 = {};
    for (const a of avgRows) {
      avg24[a.server_name] = {
        cpu_pct: a.a_cpu == null ? null : Math.round(a.a_cpu * 10) / 10,
        mem_used_pct: a.a_mem == null ? null : Math.round(a.a_mem * 10) / 10,
        disk_used_pct: a.a_disk == null ? null : Math.round(a.a_disk * 10) / 10,
        temp_c: a.a_temp == null ? null : Math.round(a.a_temp * 10) / 10,
        conns: a.a_conns == null ? null : Math.round(a.a_conns),
        samples: a.samples,
      };
    }
    // Ряды за 24ч для спарклайнов карточек (редизайн 20.08): до 48 точек,
    // равномерное прореживание, null там, где метрики не было. ts — метки
    // времени точек (ховер-тултип на спарклайнах, 21.08).
    const seriesRows = db.prepare(`SELECT server_name, collected_at, cpu_pct, mem_used_pct, disk_used_pct, conns
      FROM server_metrics WHERE collected_at > ? ORDER BY collected_at`).all(sinceIso);
    const bySrv = {};
    for (const r of seriesRows) (bySrv[r.server_name] || (bySrv[r.server_name] = [])).push(r);
    const series24 = {};
    for (const [name, arr] of Object.entries(bySrv)) {
      const step = Math.max(1, Math.ceil(arr.length / 48));
      const ts = [], cpu = [], mem = [], disk = [], conns = [];
      for (let i = 0; i < arr.length; i += step) {
        ts.push(arr[i].collected_at);
        cpu.push(arr[i].cpu_pct);
        mem.push(arr[i].mem_used_pct);
        disk.push(arr[i].disk_used_pct);
        conns.push(arr[i].conns);
      }
      series24[name] = { ts, cpu, mem, disk, conns };
    }
    for (const row of rows) {
      byName[row.server_name] = {
        ...row,
        age_sec: Math.max(0, Math.round((nowMs - Date.parse(row.collected_at)) / 1000)),
        avg24: avg24[row.server_name] || null,
        series24: series24[row.server_name] || null,
      };
    }
  } catch (e) {
    logger.warn('[ServerMetrics] read failed: ' + e.message);
  }

  // Флапание за последние 24 часа. Эпизоды подрезаем границами окна, чтобы
  // длительность и полоска не завышались, если падение началось раньше суток.
  // Отдельный try сохраняет совместимость с очень старыми БД без миграции 035.
  const downtime24 = {};
  try {
    const rows = db.prepare(`SELECT server_name, down_from, down_to, duration_sec
      FROM server_downtime WHERE down_to > ? AND down_from < ? ORDER BY down_from`).all(sinceIso, generatedAt);
    for (const row of rows) {
      const fromMs = Date.parse(row.down_from);
      const toMs = Date.parse(row.down_to);
      if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) continue;
      const clippedFrom = Math.max(fromMs, nowMs - 24 * 3600e3);
      const clippedTo = Math.min(toMs, nowMs);
      if (clippedTo <= clippedFrom) continue;
      const d = downtime24[row.server_name] || (downtime24[row.server_name] = {
        episodes: 0, duration_sec: 0, events: [],
      });
      d.episodes += 1;
      d.duration_sec += Math.round((clippedTo - clippedFrom) / 1000);
      d.events.push({
        from: new Date(clippedFrom).toISOString(),
        to: new Date(clippedTo).toISOString(),
        duration_sec: Math.round((clippedTo - clippedFrom) / 1000),
      });
    }
  // Незакрытые эпизоды: сервер лежит ПРЯМО СЕЙЧАС — в server_downtime запись
  // появится только после восстановления (modem-tracking), поэтому текущий
  // простой подмешиваем из in-memory _serverDownSince. Иначе карточка лежащего
  // бокса показывала «флапание: 0 мин» (баг 23.08).
  _mergeOngoingDowntime(downtime24, deps._serverDownSince, nowMs);
  } catch (_) { /* server_downtime may not exist on an old local DB */ }

  // Последнее серверное событие. Аппаратные USB-события берём из истории
  // метрик; для серверов без них используем свежую запись system_log,
  // адресованную самому серверу.
  const latestEvents = {};
  const eventSinceIso = new Date(nowMs - 7 * 24 * 3600e3).toISOString();
  try {
    const rows = db.prepare(`SELECT server_name, collected_at, usb_errors
      FROM server_metrics
      WHERE collected_at > ? AND trim(COALESCE(usb_errors, '')) <> ''
      ORDER BY collected_at DESC`).all(eventSinceIso);
    for (const row of rows) {
      if (latestEvents[row.server_name]) continue;
      const raw = String(row.usb_errors || '').trim();
      const parsed = raw.match(/^(\d+)\s*:\s*([\s\S]*)$/);
      latestEvents[row.server_name] = {
        timestamp: row.collected_at,
        source: parsed ? 'USB ' + parsed[1] : 'USB',
        message: (parsed ? parsed[2] : raw) || 'Обнаружено USB-событие',
      };
    }
  } catch (_) { /* server_metrics may not exist on an old local DB */ }
  try {
    const rows = db.prepare(`SELECT timestamp, category, action, target, message
      FROM system_log WHERE timestamp > ? AND target IS NOT NULL AND trim(target) <> ''
      ORDER BY id DESC LIMIT 500`).all(eventSinceIso.replace('T', ' ').replace('Z', ''));
    const labels = { system: 'Система', modem: 'Модем', recovery: 'Восстановление', proxy_check: 'Прокси' };
    const serverNames = new Set(apiServers.map(s => s.name));
    for (const row of rows) {
      if (!serverNames.has(row.target)) continue;
      const prev = latestEvents[row.target];
      if (prev && Date.parse(prev.timestamp) >= Date.parse(row.timestamp)) continue;
      latestEvents[row.target] = {
        timestamp: row.timestamp,
        source: labels[row.category] || row.category || 'Система',
        message: row.message || row.action || 'Системное событие',
      };
    }
  } catch (_) { /* system_log may not exist on an old local DB */ }

  for (const [name, metric] of Object.entries(byName)) {
    if (!metric) continue;
    metric.downtime24 = downtime24[name] || { episodes: 0, duration_sec: 0, events: [] };
    metric.latest_event = latestEvents[name] || null;
  }
  // Адрес площадки из конфига сервера (карточка показывает «S1 · Армянская …»).
  const addresses = {};
  for (const s of apiServers) {
    addresses[s.name] = s.address || '';
    if (!(s.name in byName)) byName[s.name] = null;   // данных ещё нет
  }
  res.json({ metrics: byName, addresses, generated_at: generatedAt });
});

r.get('/api/admin/servers', authMiddleware, adminMiddleware, (req, res) => {
  res.json({ servers: apiServers.map(s => ({
    name: s.name, url: s.url, publicIp: s.publicIp,
    country: SERVER_COUNTRIES[s.name] || {},
    panelUser: s.user || '', panelPassword: s.pass || '',
    osLogin: s.osLogin || '', osPassword: s.osPassword || '', sshPort: s.sshPort || '',
    hardware: s.hardware || '', address: s.address || ''
  })) });
});

r.patch('/api/admin/servers/:name', authMiddleware, adminMiddleware, async (req, res) => {
  const srv = apiServers.find(s => s.name === req.params.name);
  if (!srv) return res.status(404).json({ error: 'Server not found' });
  const { osLogin, osPassword, sshPort, hardware, address, panelUser, panelPassword } = req.body;
  if (osLogin     !== undefined) srv.osLogin    = osLogin;
  if (osPassword  !== undefined) srv.osPassword = osPassword;
  if (sshPort !== undefined) {
    const p = Number(sshPort);
    if (sshPort !== '' && sshPort !== null && !(p > 0 && p < 65536)) {
      return res.status(400).json({ error: 'sshPort must be 1..65535 or empty' });
    }
    srv.sshPort = p > 0 && p < 65536 ? p : undefined;
  }
  if (hardware    !== undefined) srv.hardware   = hardware;
  if (address     !== undefined) srv.address    = address;

  // Panel credentials change → validate against ProxySmart before persisting,
  // otherwise we can lock ourselves out of the server with a typo.
  if (panelUser !== undefined || panelPassword !== undefined) {
    const candidate = {
      ...srv,
      user: panelUser !== undefined ? String(panelUser).trim() || 'proxy' : srv.user,
      pass: panelPassword !== undefined ? String(panelPassword) : srv.pass
    };
    if (!candidate.user || !candidate.pass) {
      return res.status(400).json({ error: 'panel user and password cannot be empty' });
    }
    try {
      await fetchApi(candidate, '/apix/show_status_json', 8000);
    } catch (e) {
      return res.status(502).json({ error: 'Panel auth failed — credentials not saved', details: e.message });
    }
    srv.user = candidate.user;
    srv.pass = candidate.pass;
    proxySmart.invalidateCache();
  }

  saveApiServersToDb();
  auditLog(req.user.login, 'update_server', { name: req.params.name, fields: Object.keys(req.body || {}), ip: getClientIp(req) });
  res.json({ ok: true });
});

r.post('/api/admin/servers', authMiddleware, adminMiddleware, async (req, res) => {
  const { name, url, user, pass, publicIp, country, countryName, tz } = req.body;
  if (!name || !url || !user || !pass) return res.status(400).json({ error: 'name, url, user, pass required' });
  if (apiServers.find(s => s.name === name)) return res.status(409).json({ error: 'Server name already exists' });
  // Test connectivity
  try {
    const testServer = { name, url, user, pass, publicIp: publicIp || new URL(url).hostname, country: country || '', countryName: countryName || name, tz: tz || 'Europe/Moscow' };
    const status = await fetchApi(testServer, '/apix/show_status_json', 10000);
    const modemCount = Array.isArray(status) ? status.length : 0;
    // Add to runtime. SERVER_COUNTRIES is rebuilt inside saveApiServersToDb
    // (single path for every mutation — no per-route patching, WP4.3).
    apiServers.push(testServer);
    // Save to DB (not .env)
    saveApiServersToDb();
    auditLog(req.user.login, 'add_server', { name, url, modemCount, ip: getClientIp(req) });
    proxySmart.invalidateCache();
    res.json({ ok: true, modemCount });
  } catch (e) {
    res.status(502).json({ error: 'Server unreachable', details: e.message });
  }
});

r.delete('/api/admin/servers/:name', authMiddleware, adminMiddleware, (req, res) => {
  const idx = apiServers.findIndex(s => s.name === req.params.name);
  if (idx === -1) return res.status(404).json({ error: 'Server not found' });
  apiServers.splice(idx, 1);
  // SERVER_COUNTRIES rebuilt inside saveApiServersToDb (WP4.3).
  saveApiServersToDb();
  proxySmart.invalidateCache();
  auditLog(req.user.login, 'delete_server', { name: req.params.name, ip: getClientIp(req) });
  res.json({ ok: true });
});

r.get('/api/admin/settings', authMiddleware, adminMiddleware, (req, res) => {
  // WP7.5: secrets are encrypted at rest — never hand the ciphertext (or the
  // plaintext) to the UI. A mask communicates "configured" without exposure;
  // the value is only ever written (PUT), never read back.
  const masked = { ...appSettings };
  // WP5: telegram_bot_token тоже секрет (enc1: в kv) — маскируем, как API-ключи.
  // WP3 (B2C Э4): tochka_acq_jwt — JWT эквайринга, тот же контур.
  for (const k of ['anthropic_api_key', 'telegram_bot_token', 'tochka_acq_jwt', 'turnstile_secret_key', 'sendpulse_smtp_pass', 'crm_db_url', 'telegram_oidc_secret']) {
    const v = masked[k];
    masked[k] = (typeof v === 'string' && v) ? '••••••••' : '';
  }
  res.json(masked);
});

r.put('/api/admin/settings', authMiddleware, adminMiddleware, async (req, res) => {
  // Stage 14.2: accumulate validated changes into one batch, then commit
  // via setSettings({...}). Previously each line did `appSettings.x = ...`
  // directly with one saveSettings() at the end — internally consistent
  // but the only place in the codebase that mutated appSettings without
  // going through the canonical setSetting/setSettings helper. Now all
  // appSettings writes funnel through the same path.
  const { pricing_tiers, min_speed_threshold, proxy_check_target, proxy_check_warn_ms, proxy_check_bad_ms } = req.body;
  const patch = {};
  if (min_speed_threshold != null) {
    patch.min_speed_threshold = parseFloat(min_speed_threshold) || 2;
  }
  if (req.body.error_rate_threshold != null) {
    patch.error_rate_threshold = Math.max(1, Math.min(100, parseInt(req.body.error_rate_threshold) || 15));
  }
  if (req.body.proxy_alert_latency_ms != null) {
    patch.proxy_alert_latency_ms = Math.max(100, Math.min(60000, parseInt(req.body.proxy_alert_latency_ms) || 1500));
  }
  if (req.body.proxy_alert_error_pct != null) {
    patch.proxy_alert_error_pct = Math.max(0, Math.min(100, parseFloat(req.body.proxy_alert_error_pct) || 5));
  }
  if (req.body.proxy_alert_window_min != null) {
    patch.proxy_alert_window_min = Math.max(5, Math.min(720, parseInt(req.body.proxy_alert_window_min) || 60));
  }
  if (req.body.auto_reboot_enabled != null) {
    patch.auto_reboot_enabled = !!req.body.auto_reboot_enabled;
  }
  // Порог сводного алерта «N модемов не работает» (0 = выключить сводку)
  if (req.body.modems_down_threshold != null) {
    patch.modems_down_threshold = Math.max(0, Math.min(100, parseInt(req.body.modems_down_threshold) || 0));
  }
  if (req.body.auto_reboot_min_interval_min != null) {
    patch.auto_reboot_min_interval_min = Math.max(15, Math.min(720, parseInt(req.body.auto_reboot_min_interval_min) || 60));
  }
  // 20.08: random-ник → авто-ребут (default on); удержание портов в
  // знаменателе против флапов API боксов (default 2 дня).
  if (req.body.random_modem_reboot_enabled != null) {
    patch.random_modem_reboot_enabled = !!req.body.random_modem_reboot_enabled;
  }
  if (req.body.reconcile_days != null) {
    patch.reconcile_days = Math.max(1, Math.min(30, parseInt(req.body.reconcile_days) || 2));
  }
  // Порог TG-алерта по reboot score модема (0..100; notify-collect).
  if (req.body.reboot_score_alert_threshold != null) {
    patch.reboot_score_alert_threshold = Math.max(0, Math.min(100, parseInt(req.body.reboot_score_alert_threshold) || 70));
  }
  // Stage 18.8: hours-threshold for "stale modem" exclusion from agg endpoints.
  // Bounded 1..168 (1h .. 7d) — wider would defeat the purpose; tighter would
  // exclude modems that just blipped during a tracking-poll gap.
  if (req.body.stale_modem_hours != null) {
    patch.stale_modem_hours = Math.max(1, Math.min(168, parseInt(req.body.stale_modem_hours) || 12));
  }
  // 2026-07-28: minutes of darkness before a modem counts as «отключен»
  // (fleet disconnectedMs → card + working counts + TG alert). Bounded
  // 1..120 min — below the tracking poll it would flap on every rotation.
  if (req.body.modem_offline_threshold_min != null) {
    patch.modem_offline_threshold_min = Math.max(1, Math.min(120, parseInt(req.body.modem_offline_threshold_min) || 10));
  }
  if (pricing_tiers && Array.isArray(pricing_tiers)) {
    patch.pricing_tiers = pricing_tiers.map(t => ({
      min_proxies: parseInt(t.min_proxies) || 1,
      price: parseFloat(t.price) || 0,
      label: t.label || ''
    }));
  }
  if (proxy_check_target != null) {
    const url = String(proxy_check_target).trim();
    // SSRF-defense: reject internal/loopback/metadata hosts. proxy_check_target
    // is fed to curl from each ProxySmart server, so a malicious admin could
    // pivot to internal services on those machines (or use server as a probe).
    let ok = false;
    if (url && /^https?:\/\/.+/.test(url)) {
      try {
        const u = new URL(url);
        const host = u.hostname.toLowerCase();
        const bad = /^(localhost$|127\.|10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.|0\.|169\.254\.|::1$|fc00:|fe80:|metadata\.)/i;
        if (!bad.test(host) && !/^\d+$/.test(host) && host !== '0.0.0.0') ok = true;
      } catch (_) { ok = false; }
    }
    if (ok) patch.proxy_check_target = url;
    else return res.status(400).json({ error: 'proxy_check_target rejected (internal/loopback/metadata host)' });
  }
  if (proxy_check_warn_ms != null) {
    patch.proxy_check_warn_ms = Math.max(50, parseInt(proxy_check_warn_ms) || 500);
  }
  if (proxy_check_bad_ms != null) {
    patch.proxy_check_bad_ms = Math.max(100, parseInt(proxy_check_bad_ms) || 2000);
  }
  let needsProxyReschedule = false;
  if (req.body.proxy_check_interval_min != null) {
    patch.proxy_check_interval_min = Math.max(5, Math.min(1440, parseInt(req.body.proxy_check_interval_min) || 60));
    needsProxyReschedule = true;
  }
  // Auto-recovery
  if (req.body.recovery_offline_sec != null)   patch.recovery_offline_sec   = Math.max(10, Math.min(600, parseInt(req.body.recovery_offline_sec) || 60));
  if (req.body.recovery_max_attempts != null)  patch.recovery_max_attempts  = Math.max(1, Math.min(10, parseInt(req.body.recovery_max_attempts) || 3));
  if (req.body.recovery_retry_min != null)     patch.recovery_retry_min     = Math.max(1, Math.min(60, parseInt(req.body.recovery_retry_min) || 3));
  if (req.body.recovery_enabled != null)       patch.recovery_enabled       = !!req.body.recovery_enabled;
  if (req.body.recovery_readd_after != null)   patch.recovery_readd_after   = !!req.body.recovery_readd_after;
  if (req.body.recovery_skip_dead_sim != null) patch.recovery_skip_dead_sim = !!req.body.recovery_skip_dead_sim;
  if (req.body.recovery_skip_unsold != null)   patch.recovery_skip_unsold   = !!req.body.recovery_skip_unsold;
  if (req.body.recovery_daily_cap != null)     patch.recovery_daily_cap     = Math.max(1, Math.min(50, parseInt(req.body.recovery_daily_cap) || 6));
  if (req.body.operator_gb_costs && typeof req.body.operator_gb_costs === 'object') {
    const oc = {};
    Object.keys(req.body.operator_gb_costs).forEach(k => {
      const v = parseFloat(req.body.operator_gb_costs[k]);
      if (!isNaN(v) && v >= 0 && v < 100000) oc[String(k).slice(0, 60)] = v;
    });
    patch.operator_gb_costs = oc;
  }
  // A4 (23.08): пакеты операторов — JSON-массив [{operator, type, volume_gb,
  // hourly_gb, pace_pct}]. До 20 строк; operator ≤60 символов; type — только
  // per_sim/shared; числа в разумных пределах.
  if (req.body.operator_packages != null) {
    let arr;
    try { arr = JSON.parse(String(req.body.operator_packages)); }
    catch (_) { return res.status(400).json({ error: 'operator_packages: невалидный JSON' }); }
    if (!Array.isArray(arr) || arr.length > 20) {
      return res.status(400).json({ error: 'operator_packages: массив до 20 строк' });
    }
    const clean = [];
    for (const p of arr) {
      const op = String((p && p.operator) || '').trim().slice(0, 60);
      if (!op) return res.status(400).json({ error: 'operator_packages: пустое имя оператора' });
      const type = p.type === 'shared' ? 'shared' : 'per_sim';
      const num = (v, max) => { const n = parseFloat(v); return (Number.isFinite(n) && n >= 0 && n <= max) ? n : 0; };
      clean.push({
        operator: op, type,
        volume_gb: num(p.volume_gb, 1e6),
        hourly_gb: num(p.hourly_gb, 1e5),
        pace_pct: Math.min(100, num(p.pace_pct, 100)),
      });
    }
    patch.operator_packages = JSON.stringify(clean);
  }
  if (req.body.volume_enabled != null) patch.volume_enabled = !!req.body.volume_enabled;
  // Stage 19 — failover
  if (req.body.failover_enabled != null)          patch.failover_enabled          = !!req.body.failover_enabled;
  if (req.body.failover_dry_run != null)          patch.failover_dry_run          = !!req.body.failover_dry_run;
  if (req.body.failover_offline_min != null)      patch.failover_offline_min      = Math.max(5, Math.min(240, parseInt(req.body.failover_offline_min) || 15));
  if (req.body.failover_glitch_fails != null)     patch.failover_glitch_fails     = Math.max(2, Math.min(20, parseInt(req.body.failover_glitch_fails) || 3));
  if (req.body.failover_proxy_dead_min != null)   patch.failover_proxy_dead_min   = Math.max(15, Math.min(180, parseInt(req.body.failover_proxy_dead_min) || 45));
  if (req.body.failover_proxy_dead_hard_min != null) patch.failover_proxy_dead_hard_min = Math.max(30, Math.min(360, parseInt(req.body.failover_proxy_dead_hard_min) || 90));
  if (req.body.failover_uptime_floor_pct != null) patch.failover_uptime_floor_pct = Math.max(50, Math.min(100, parseInt(req.body.failover_uptime_floor_pct) || 90));
  if (req.body.failover_spare_min_uptime_pct != null) patch.failover_spare_min_uptime_pct = Math.max(0, Math.min(100, parseInt(req.body.failover_spare_min_uptime_pct) || 90));
  if (req.body.failover_cooldown_h != null)       patch.failover_cooldown_h       = Math.max(1, Math.min(72, parseInt(req.body.failover_cooldown_h) || 6));
  if (req.body.failover_max_per_hour != null)     patch.failover_max_per_hour     = Math.max(1, Math.min(50, parseInt(req.body.failover_max_per_hour) || 5));
  // Modem tracking & rotation
  if (req.body.tracking_interval_min != null)      patch.tracking_interval_min      = Math.max(1, Math.min(30, parseInt(req.body.tracking_interval_min) || 3));
  if (req.body.rotation_cache_ttl_min != null)     patch.rotation_cache_ttl_min     = Math.max(5, Math.min(240, parseInt(req.body.rotation_cache_ttl_min) || 30));
  if (req.body.rotation_sync_interval_min != null) patch.rotation_sync_interval_min = Math.max(5, Math.min(240, parseInt(req.body.rotation_sync_interval_min) || 30));
  // Proxy check (additional)
  if (req.body.proxy_check_timeout_sec != null) patch.proxy_check_timeout_sec = Math.max(5, Math.min(120, parseInt(req.body.proxy_check_timeout_sec) || 15));
  if (req.body.proxy_check_concurrency != null) patch.proxy_check_concurrency = Math.max(1, Math.min(50, parseInt(req.body.proxy_check_concurrency) || 10));
  // Speedtest (additional)
  if (req.body.speedtest_low_threshold != null)    patch.speedtest_low_threshold    = Math.max(0.1, Math.min(50, parseFloat(req.body.speedtest_low_threshold) || 1));
  if (req.body.speedtest_retest_delay_min != null) patch.speedtest_retest_delay_min = Math.max(1, Math.min(120, parseInt(req.body.speedtest_retest_delay_min) || 10));
  if (req.body.speedtest_max_history != null)      patch.speedtest_max_history      = Math.max(5, Math.min(200, parseInt(req.body.speedtest_max_history) || 30));
  // Модемы почасового SpeedMonitor: CSV ников (строка). Ники — [A-Za-z0-9_-],
  // до 50 штук; пустая строка = вернуться к дефолту (джоба подставит сама).
  if (req.body.speedtest_modems != null) {
    const nicks = String(req.body.speedtest_modems).split(',')
      .map(s => s.trim()).filter(Boolean);
    if (nicks.length > 50 || nicks.some(n => !/^[\w-]{1,64}$/.test(n))) {
      return res.status(400).json({ error: 'speedtest_modems: CSV ников [A-Za-z0-9_-], до 50 штук' });
    }
    patch.speedtest_modems = nicks.join(',');
  }
  // SpeedMonitor (выборочный почасовой замер): перезамеры и ретенция.
  if (req.body.speedmon_retry_dl_threshold != null) patch.speedmon_retry_dl_threshold = Math.max(0.5, Math.min(50, parseFloat(req.body.speedmon_retry_dl_threshold) || 5));
  if (req.body.speedmon_retry_round_min != null)    patch.speedmon_retry_round_min    = Math.max(1, Math.min(30, parseInt(req.body.speedmon_retry_round_min) || 5));
  if (req.body.speedmon_retry_rounds != null)       patch.speedmon_retry_rounds       = Math.max(0, Math.min(20, parseInt(req.body.speedmon_retry_rounds) ?? 10));
  if (req.body.retention_speed_monitor != null)     patch.retention_speed_monitor     = Math.max(7, Math.min(365, parseInt(req.body.retention_speed_monitor) || 60));
  // Боксы розничного пула: CSV имён серверов (порядок важен — первый из
  // списка = бокс выдачи по умолчанию, см. retail.js buy_proxy).
  if (req.body.retail_pool_servers != null) {
    const names = String(req.body.retail_pool_servers).split(',')
      .map(s => s.trim()).filter(Boolean);
    if (names.length > 20 || names.some(n => !/^[\w-]{1,64}$/.test(n))) {
      return res.status(400).json({ error: 'retail_pool_servers: CSV имён серверов, до 20 штук' });
    }
    patch.retail_pool_servers = names.join(',');
  }
  // Data retention (days)
  if (req.body.retention_traffic_hourly != null) patch.retention_traffic_hourly = Math.max(7, Math.min(365, parseInt(req.body.retention_traffic_hourly) || 90));
  if (req.body.retention_daily_traffic != null)  patch.retention_daily_traffic  = Math.max(7, Math.min(365, parseInt(req.body.retention_daily_traffic) || 90));
  if (req.body.retention_api_usage != null)      patch.retention_api_usage      = Math.max(7, Math.min(365, parseInt(req.body.retention_api_usage) || 30));
  if (req.body.retention_audit_log != null)      patch.retention_audit_log      = Math.max(7, Math.min(365, parseInt(req.body.retention_audit_log) || 90));
  if (req.body.retention_system_log != null)     patch.retention_system_log     = Math.max(7, Math.min(365, parseInt(req.body.retention_system_log) || 30));
  if (req.body.retention_rotation_log != null)   patch.retention_rotation_log   = Math.max(7, Math.min(365, parseInt(req.body.retention_rotation_log) || 90));
  if (req.body.retention_proxy_checks != null)   patch.retention_proxy_checks   = Math.max(7, Math.min(365, parseInt(req.body.retention_proxy_checks) || 30));
  if (req.body.retention_modem_meta != null)     patch.retention_modem_meta     = Math.max(7, Math.min(365, parseInt(req.body.retention_modem_meta) || 30));
  if (req.body.retention_top_hosts_daily != null) patch.retention_top_hosts_daily = Math.max(7, Math.min(365, parseInt(req.body.retention_top_hosts_daily) || 90));
  // Session & billing
  if (req.body.session_ttl_days != null)            patch.session_ttl_days            = Math.max(1, Math.min(365, parseInt(req.body.session_ttl_days) || 30));
  if (req.body.billing_retry_delay_hours != null)   patch.billing_retry_delay_hours   = Math.max(0.5, Math.min(24, parseFloat(req.body.billing_retry_delay_hours) || 1));
  if (req.body.reconciliation_tolerance_gb != null) patch.reconciliation_tolerance_gb = Math.max(0.001, Math.min(1, parseFloat(req.body.reconciliation_tolerance_gb) || 0.01));
  // Курсы валют затрат (₽ за 1 MDL/RON): 0 = авто (ЦБ), >0 = ручной фикс.
  if (req.body.fx_rate_mdl != null) patch.fx_rate_mdl = Math.max(0, Math.min(10000, parseFloat(req.body.fx_rate_mdl) || 0));
  if (req.body.fx_rate_ron != null) patch.fx_rate_ron = Math.max(0, Math.min(10000, parseFloat(req.body.fx_rate_ron) || 0));
  // Auto-create
  if (req.body.auto_create_interval_min != null) patch.auto_create_interval_min = Math.max(1, Math.min(60, parseInt(req.body.auto_create_interval_min) || 10));
  // Telegram daily summary
  // WP5: токен — секрет; маска GET ('••••••••') не является значением —
  // игнорируем её, чтобы сохранение нетронутой формы не затирало токен.
  if (req.body.telegram_bot_token != null && req.body.telegram_bot_token !== '••••••••')  patch.telegram_bot_token       = String(req.body.telegram_bot_token).trim();
  if (req.body.telegram_chat_id != null)         patch.telegram_chat_id         = String(req.body.telegram_chat_id).trim();
  if (req.body.telegram_summary_enabled != null) patch.telegram_summary_enabled = !!req.body.telegram_summary_enabled;
  // WP5 (B2C Э3): whitelist админов бота — CSV числовых telegram id.
  // Пустая строка = legacy-режим (админ = telegram_chat_id).
  if (req.body.telegram_admin_ids != null) {
    const ids = String(req.body.telegram_admin_ids).split(',').map(s => s.trim()).filter(Boolean);
    if (ids.length > 20 || ids.some(id => !/^\d{1,20}$/.test(id))) {
      return res.status(400).json({ error: 'telegram_admin_ids: CSV числовых telegram id, до 20 штук' });
    }
    patch.telegram_admin_ids = ids.join(',');
  }
  if (req.body.telegram_bot_username != null) {
    const un = String(req.body.telegram_bot_username).trim().replace(/^@/, '');
    if (un && !/^[A-Za-z0-9_]{5,32}$/.test(un)) {
      return res.status(400).json({ error: 'telegram_bot_username: 5-32 символа [A-Za-z0-9_]' });
    }
    patch.telegram_bot_username = un;
  }
  // WP5 (B2C Э3): пороги алертов розницы
  // 0 = антифрод-алерт «массовая покупка» выключен.
  if (req.body.retail_bulk_buy_threshold != null) patch.retail_bulk_buy_threshold = Math.max(0, Math.min(100, parseInt(req.body.retail_bulk_buy_threshold) || 0));
  if (req.body.retail_pool_min_free != null)      patch.retail_pool_min_free      = Math.max(0, Math.min(1000, parseInt(req.body.retail_pool_min_free) || 0));
  // Шаринг розницы (15.08): достройка портов на модемах якорного клиента.
  if (req.body.retail_max_clients_per_modem != null) patch.retail_max_clients_per_modem = Math.max(1, Math.min(20, parseInt(req.body.retail_max_clients_per_modem) || 1));
  if (req.body.retail_share_anchor_login != null) {
    const anchor = String(req.body.retail_share_anchor_login).trim();
    if (anchor && !/^[\w@-]{1,64}$/.test(anchor)) return res.status(400).json({ error: 'retail_share_anchor_login: некорректный логин' });
    patch.retail_share_anchor_login = anchor;
  }
  // Розница: главный выключатель + параметры жизненного цикла (UI «Розница»)
  if (req.body.retail_enabled != null)            patch.retail_enabled            = !!req.body.retail_enabled;
  if (req.body.retail_test_day_price != null)     patch.retail_test_day_price     = Math.max(0, Math.min(100000, parseFloat(req.body.retail_test_day_price) || 0));
  if (req.body.retail_grace_hours != null)        patch.retail_grace_hours        = Math.max(1, Math.min(720, parseInt(req.body.retail_grace_hours) || 24));
  if (req.body.retail_hold_days != null)          patch.retail_hold_days          = Math.max(1, Math.min(365, parseInt(req.body.retail_hold_days) || 7));
  if (req.body.retail_reg_limit_per_ip_day != null) patch.retail_reg_limit_per_ip_day = Math.max(1, Math.min(1000, parseInt(req.body.retail_reg_limit_per_ip_day) || 10));
  // Регистрация и письма розницы: Turnstile (анти-бот) + SendPulse SMTP.
  // Секреты: маска GET ('••••••••') не является значением — игнорируем её.
  if (req.body.turnstile_site_key != null)        patch.turnstile_site_key        = String(req.body.turnstile_site_key).trim();
  if (req.body.turnstile_secret_key != null && req.body.turnstile_secret_key !== '••••••••') patch.turnstile_secret_key = String(req.body.turnstile_secret_key).trim();
  if (req.body.sendpulse_smtp_user != null)       patch.sendpulse_smtp_user       = String(req.body.sendpulse_smtp_user).trim();
  if (req.body.sendpulse_smtp_pass != null && req.body.sendpulse_smtp_pass !== '••••••••')   patch.sendpulse_smtp_pass   = String(req.body.sendpulse_smtp_pass).trim();
  // Telegram OIDC Login (BotFather «Login widget»): client_id = bot_id, secret — секрет.
  if (req.body.telegram_oidc_client_id != null)   patch.telegram_oidc_client_id   = String(req.body.telegram_oidc_client_id).trim();
  if (req.body.telegram_oidc_secret != null && req.body.telegram_oidc_secret !== '••••••••') patch.telegram_oidc_secret = String(req.body.telegram_oidc_secret).trim();
  if (req.body.sendpulse_from != null) {
    const from = String(req.body.sendpulse_from).trim();
    if (from && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(from)) return res.status(400).json({ error: 'sendpulse_from: некорректный email' });
    patch.sendpulse_from = from;
  }
  // WP7 (B2C Э5): антифрод розницы. 0 у suspend_hits / max_accounts / min_unique = контур выкл.
  if (req.body.domain_guard_suspend_hits != null) patch.domain_guard_suspend_hits = Math.max(0, Math.min(1000, parseInt(req.body.domain_guard_suspend_hits) || 0));
  // Боксы под доменным контролем (CSV имён серверов, порядок не важен).
  if (req.body.domain_guard_servers != null) {
    const dgs = String(req.body.domain_guard_servers).split(',')
      .map(s => s.trim()).filter(Boolean);
    if (dgs.length > 20 || dgs.some(n => !/^[\w-]{1,64}$/.test(n))) {
      return res.status(400).json({ error: 'domain_guard_servers: CSV имён серверов, до 20 штук' });
    }
    patch.domain_guard_servers = dgs.join(',');
  }
  if (req.body.abuse_strikes_block != null)       patch.abuse_strikes_block       = Math.max(1, Math.min(100, parseInt(req.body.abuse_strikes_block) || 2));
  if (req.body.retail_max_accounts_per_ip != null) patch.retail_max_accounts_per_ip = Math.max(0, Math.min(100, parseInt(req.body.retail_max_accounts_per_ip) || 0));
  if (req.body.retail_min_unique_ips != null)     patch.retail_min_unique_ips     = Math.max(0, Math.min(100, parseInt(req.body.retail_min_unique_ips) || 0));
  // WP3 (B2C Э4): эквайринг розницы. provider — только известные значения;
  // jwt — секрет (маска '••••••••' из GET не является значением — игнорируем,
  // как telegram_bot_token). customer_code/merchant_id — цифровые коды Точки.
  if (req.body.retail_acquiring_provider != null) {
    const p = String(req.body.retail_acquiring_provider).trim();
    if (!['', 'none', 'tochka'].includes(p)) {
      return res.status(400).json({ error: 'retail_acquiring_provider: допустимо tochka | none | пусто' });
    }
    patch.retail_acquiring_provider = p;
  }
  if (req.body.retail_min_topup != null) patch.retail_min_topup = Math.max(0, Math.min(1000000, parseFloat(req.body.retail_min_topup) || 0));
  if (req.body.retail_max_topup != null) {
    const mx = Math.max(1, Math.min(1000000, parseFloat(req.body.retail_max_topup) || 100000));
    patch.retail_max_topup = mx;
  }
  if (req.body.tochka_acq_jwt != null && req.body.tochka_acq_jwt !== '••••••••') {
    patch.tochka_acq_jwt = String(req.body.tochka_acq_jwt).trim();
  }
  if (req.body.tochka_acq_customer_code != null) {
    const cc = String(req.body.tochka_acq_customer_code).trim();
    if (cc && !/^\d{9}$/.test(cc)) return res.status(400).json({ error: 'tochka_acq_customer_code: ровно 9 цифр' });
    patch.tochka_acq_customer_code = cc;
  }
  if (req.body.tochka_acq_merchant_id != null) {
    const mid = String(req.body.tochka_acq_merchant_id).trim();
    if (mid && !/^\d{15}$/.test(mid)) return res.status(400).json({ error: 'tochka_acq_merchant_id: ровно 15 цифр' });
    patch.tochka_acq_merchant_id = mid;
  }
  if (req.body.tochka_acq_tax_system != null) {
    const ts = String(req.body.tochka_acq_tax_system).trim();
    if (ts && !['osn', 'usn_income', 'usn_income_outcome', 'esn', 'patent'].includes(ts)) {
      return res.status(400).json({ error: 'tochka_acq_tax_system: osn|usn_income|usn_income_outcome|esn|patent' });
    }
    patch.tochka_acq_tax_system = ts;
  }
  // AI-insights key (Telegram daily summary). The '••••••••' mask shown by the GET
  // endpoint is NOT a value — ignore it so a save of an untouched form can't
  // clobber the real key with the mask itself.
  if (req.body.anthropic_api_key != null && req.body.anthropic_api_key !== '••••••••')        patch.anthropic_api_key        = String(req.body.anthropic_api_key).trim();
  // AI-инсайты в ежедневной TG-сводке (вкл/выкл; ключ — anthropic_api_key выше).
  if (req.body.ai_insights_enabled != null)       patch.ai_insights_enabled       = !!req.body.ai_insights_enabled;
  // Публичный URL дашборда — ссылки в TG-сводке/алертах. Пусто = дефолт.
  if (req.body.public_url != null) {
    const pu = String(req.body.public_url).trim();
    if (pu && !/^https?:\/\/[\w.-]+(?::\d+)?(?:\/[\w./-]*)?$/.test(pu)) {
      return res.status(400).json({ error: 'public_url: http(s)://host[/path] или пусто' });
    }
    patch.public_url = pu.replace(/\/+$/, '');
  }
  // Twenty CRM: DSN базы (postgresql://user:pass@host:5432/db). Секрет — enc1:,
  // маска '••••••••' при GET; пустое замаскированное поле = не менять.
  if (req.body.crm_db_url != null && req.body.crm_db_url !== '••••••••') {
    const cu = String(req.body.crm_db_url).trim();
    if (cu && !/^postgres(ql)?:\/\//.test(cu)) {
      return res.status(400).json({ error: 'crm_db_url: postgresql://user:pass@host:5432/db или пусто' });
    }
    patch.crm_db_url = cu;
  }
  // Симулятор нагрузки (стенд): включение + потолки прогона.
  if (req.body.simulator_enabled != null)          patch.simulator_enabled          = !!req.body.simulator_enabled;
  if (req.body.simulator_max_workers != null)      patch.simulator_max_workers      = Math.max(1, Math.min(200, parseInt(req.body.simulator_max_workers) || 50));
  if (req.body.simulator_max_sse != null)          patch.simulator_max_sse          = Math.max(1, Math.min(100, parseInt(req.body.simulator_max_sse) || 10));
  if (req.body.simulator_max_duration_min != null) patch.simulator_max_duration_min = Math.max(1, Math.min(240, parseInt(req.body.simulator_max_duration_min) || 30));
  if (req.body.telegram_summary_time != null) {
    const t = String(req.body.telegram_summary_time);
    if (/^\d{2}:\d{2}$/.test(t)) patch.telegram_summary_time = t;
  }

  // Live-проверка кредов ДО записи (15.08, по запросу): фатальный вердикт
  // (auth-ответ сервиса — 535/401/истёкший JWT) отклоняет сохранение целиком;
  // сетевой сбой — только warning в ответе, настройки сохраняются.
  const credVerdict = await credCheck.validateSettingsPatch(patch, { getSetting });
  if (credVerdict.errors.length) {
    logger.warn('[Settings] cred check failed: ' + credVerdict.errors.join('; '));
    return res.status(400).json({ error: 'Проверка доступов не пройдена: ' + credVerdict.errors.join('; '), cred_errors: credVerdict.errors });
  }

  setSettings(patch);
  if (needsProxyReschedule) rescheduleProxyCheck();
  rescheduleSpeedtests();
  res.json({ ok: true, settings: appSettings, cred_checks: credVerdict.checks, cred_warnings: credVerdict.warnings });
});

  return r;
};

// Подмешивает незакрытые (текущие) эпизоды простоя из in-memory карты
// { serverName: downSinceMs } в downtime24, собранный из server_downtime.
// Эпизод помечается ongoing:true, границы подрезаются окном 24ч — как у
// закрытых. Чистая функция: покрыта тестами напрямую.
function _mergeOngoingDowntime(downtime24, downSinceMap, nowMs) {
  if (!downSinceMap) return downtime24;
  for (const [name, since] of Object.entries(downSinceMap)) {
    const fromMs = Number(since);
    if (!Number.isFinite(fromMs)) continue;
    const clippedFrom = Math.max(fromMs, nowMs - 24 * 3600e3);
    if (nowMs <= clippedFrom) continue;
    const d = downtime24[name] || (downtime24[name] = { episodes: 0, duration_sec: 0, events: [] });
    d.episodes += 1;
    d.duration_sec += Math.round((nowMs - clippedFrom) / 1000);
    d.events.push({
      from: new Date(clippedFrom).toISOString(),
      to: new Date(nowMs).toISOString(),
      duration_sec: Math.round((nowMs - clippedFrom) / 1000),
      ongoing: true,
    });
  }
  return downtime24;
}

module.exports._mergeOngoingDowntime = _mergeOngoingDowntime;
