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

module.exports = function createServersRouter(deps) {
  const {
    logger, authMiddleware, adminMiddleware,
    apiServers, SERVER_COUNTRIES, appSettings,
    fetchApi, saveApiServersToDb, proxySmart,
    auditLog, getClientIp,
    // Stage 14.2: setSettings() batches the validated patch + saves once;
    // no more direct `appSettings.x = ...` mutations in this router.
    setSettings, rescheduleSpeedtests, rescheduleProxyCheck,
  } = deps;
  const r = express.Router();

r.get('/api/admin/servers', authMiddleware, adminMiddleware, (req, res) => {
  res.json({ servers: apiServers.map(s => ({
    name: s.name, url: s.url, publicIp: s.publicIp,
    country: SERVER_COUNTRIES[s.name] || {},
    panelUser: s.user || '', panelPassword: s.pass || '',
    osLogin: s.osLogin || '', osPassword: s.osPassword || '',
    hardware: s.hardware || '', address: s.address || ''
  })) });
});

r.patch('/api/admin/servers/:name', authMiddleware, adminMiddleware, async (req, res) => {
  const srv = apiServers.find(s => s.name === req.params.name);
  if (!srv) return res.status(404).json({ error: 'Server not found' });
  const { osLogin, osPassword, hardware, address, panelUser, panelPassword } = req.body;
  if (osLogin     !== undefined) srv.osLogin    = osLogin;
  if (osPassword  !== undefined) srv.osPassword = osPassword;
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
    // Add to runtime
    apiServers.push(testServer);
    SERVER_COUNTRIES[name] = { country: testServer.country, name: testServer.countryName, tz: testServer.tz, serverIp: testServer.publicIp };
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
  delete SERVER_COUNTRIES[req.params.name];
  saveApiServersToDb();
  proxySmart.invalidateCache();
  auditLog(req.user.login, 'delete_server', { name: req.params.name, ip: getClientIp(req) });
  res.json({ ok: true });
});

r.get('/api/admin/settings', authMiddleware, adminMiddleware, (req, res) => {
  res.json(appSettings);
});

r.put('/api/admin/settings', authMiddleware, adminMiddleware, (req, res) => {
  // Stage 14.2: accumulate validated changes into one batch, then commit
  // via setSettings({...}). Previously each line did `appSettings.x = ...`
  // directly with one saveSettings() at the end — internally consistent
  // but the only place in the codebase that mutated appSettings without
  // going through the canonical setSetting/setSettings helper. Now all
  // appSettings writes funnel through the same path.
  const { speedtest_times, pricing_tiers, min_speed_threshold, proxy_check_target, proxy_check_warn_ms, proxy_check_bad_ms } = req.body;
  const patch = {};
  if (speedtest_times && Array.isArray(speedtest_times)) {
    patch.speedtest_times = speedtest_times.filter(t => /^\d{2}:\d{2}$/.test(t));
  }
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
  if (req.body.auto_reboot_min_interval_min != null) {
    patch.auto_reboot_min_interval_min = Math.max(15, Math.min(720, parseInt(req.body.auto_reboot_min_interval_min) || 60));
  }
  // Stage 18.8: hours-threshold for "stale modem" exclusion from agg endpoints.
  // Bounded 1..168 (1h .. 7d) — wider would defeat the purpose; tighter would
  // exclude modems that just blipped during a tracking-poll gap.
  if (req.body.stale_modem_hours != null) {
    patch.stale_modem_hours = Math.max(1, Math.min(168, parseInt(req.body.stale_modem_hours) || 12));
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
  // Stage 19 — failover
  if (req.body.failover_enabled != null)          patch.failover_enabled          = !!req.body.failover_enabled;
  if (req.body.failover_dry_run != null)          patch.failover_dry_run          = !!req.body.failover_dry_run;
  if (req.body.failover_offline_min != null)      patch.failover_offline_min      = Math.max(5, Math.min(240, parseInt(req.body.failover_offline_min) || 15));
  if (req.body.failover_glitch_fails != null)     patch.failover_glitch_fails     = Math.max(2, Math.min(20, parseInt(req.body.failover_glitch_fails) || 3));
  if (req.body.failover_glitch_slow_ms != null)   patch.failover_glitch_slow_ms   = Math.max(1000, Math.min(60000, parseInt(req.body.failover_glitch_slow_ms) || 4000));
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
  // Data retention (days)
  if (req.body.retention_traffic_hourly != null) patch.retention_traffic_hourly = Math.max(7, Math.min(365, parseInt(req.body.retention_traffic_hourly) || 90));
  if (req.body.retention_daily_traffic != null)  patch.retention_daily_traffic  = Math.max(7, Math.min(365, parseInt(req.body.retention_daily_traffic) || 90));
  if (req.body.retention_api_usage != null)      patch.retention_api_usage      = Math.max(7, Math.min(365, parseInt(req.body.retention_api_usage) || 30));
  if (req.body.retention_audit_log != null)      patch.retention_audit_log      = Math.max(7, Math.min(365, parseInt(req.body.retention_audit_log) || 90));
  if (req.body.retention_system_log != null)     patch.retention_system_log     = Math.max(7, Math.min(365, parseInt(req.body.retention_system_log) || 30));
  if (req.body.retention_rotation_log != null)   patch.retention_rotation_log   = Math.max(7, Math.min(365, parseInt(req.body.retention_rotation_log) || 90));
  if (req.body.retention_proxy_checks != null)   patch.retention_proxy_checks   = Math.max(7, Math.min(365, parseInt(req.body.retention_proxy_checks) || 30));
  if (req.body.retention_modem_meta != null)     patch.retention_modem_meta     = Math.max(7, Math.min(365, parseInt(req.body.retention_modem_meta) || 30));
  // Session & billing
  if (req.body.session_ttl_days != null)            patch.session_ttl_days            = Math.max(1, Math.min(365, parseInt(req.body.session_ttl_days) || 30));
  if (req.body.billing_retry_delay_hours != null)   patch.billing_retry_delay_hours   = Math.max(0.5, Math.min(24, parseFloat(req.body.billing_retry_delay_hours) || 1));
  if (req.body.reconciliation_tolerance_gb != null) patch.reconciliation_tolerance_gb = Math.max(0.001, Math.min(1, parseFloat(req.body.reconciliation_tolerance_gb) || 0.01));
  // CRM & auto-create
  if (req.body.auto_create_interval_min != null) patch.auto_create_interval_min = Math.max(1, Math.min(60, parseInt(req.body.auto_create_interval_min) || 10));
  if (req.body.crm_check_interval_min != null)   patch.crm_check_interval_min   = Math.max(5, Math.min(120, parseInt(req.body.crm_check_interval_min) || 10));
  if (req.body.crm_reminder_days != null)        patch.crm_reminder_days        = Math.max(1, Math.min(30, parseInt(req.body.crm_reminder_days) || 3));
  // Telegram daily summary
  if (req.body.telegram_bot_token != null)       patch.telegram_bot_token       = String(req.body.telegram_bot_token).trim();
  if (req.body.telegram_chat_id != null)         patch.telegram_chat_id         = String(req.body.telegram_chat_id).trim();
  if (req.body.telegram_summary_enabled != null) patch.telegram_summary_enabled = !!req.body.telegram_summary_enabled;
  if (req.body.telegram_summary_time != null) {
    const t = String(req.body.telegram_summary_time);
    if (/^\d{2}:\d{2}$/.test(t)) patch.telegram_summary_time = t;
  }

  setSettings(patch);
  if (needsProxyReschedule) rescheduleProxyCheck();
  rescheduleSpeedtests();
  res.json({ ok: true, settings: appSettings });
});

  return r;
};
