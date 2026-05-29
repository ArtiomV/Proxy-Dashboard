'use strict';

// Stage 18.13 — admin endpoints for the Telegram alert framework.
//   GET  /api/admin/alerts             — list rules + their enabled state
//   PUT  /api/admin/alerts/:id         — body: { enabled: boolean }
//   POST /api/admin/alerts/:id/test    — fire the rule once with sample payload

const express = require('express');
const alerts = require('../telegram/alerts');

module.exports = function (deps) {
  const { logger, authMiddleware, adminMiddleware, appSettings, kvSetCritical, setSettings } = deps;
  const r = express.Router();

  r.get('/api/admin/alerts', authMiddleware, adminMiddleware, (req, res) => {
    res.json({ rules: alerts.listRules() });
  });

  r.put('/api/admin/alerts/:id', authMiddleware, adminMiddleware, (req, res) => {
    const id = req.params.id;
    const rule = alerts.RULES[id];
    if (!rule) return res.status(404).json({ error: 'unknown rule' });
    const enabled = !!req.body.enabled;
    const key = 'alert_' + id + '_enabled';
    try {
      // Persist via the same path appSettings updates use elsewhere (kvSetCritical
      // for history) and live-mutate appSettings so the change takes effect
      // without restart.
      appSettings[key] = enabled;
      if (typeof setSettings === 'function') {
        setSettings({ [key]: enabled });
      } else if (typeof kvSetCritical === 'function') {
        kvSetCritical('app_settings', JSON.stringify(appSettings), { source: 'alerts-toggle' });
      }
      res.json({ ok: true, id, enabled });
    } catch (e) {
      logger.error('[Alerts] save toggle: ' + e.message);
      res.status(500).json({ error: e.message });
    }
  });

  r.post('/api/admin/alerts/:id/test', authMiddleware, adminMiddleware, (req, res) => {
    const id = req.params.id;
    const rule = alerts.RULES[id];
    if (!rule) return res.status(404).json({ error: 'unknown rule' });
    // Sample payloads chosen to render meaningfully for each rule.
    const samples = {
      server_unreachable:         { server: 'TEST', error: 'connection refused (тест)' },
      server_recovered:           { server: 'TEST', downSec: 312 },
      tochka_webhook_failed:      { streak: 3, error: 'signature mismatch (тест)' },
      db_backup_failed:           { error: 'ENOSPC: no space left (тест)' },
      duplicate_credit_blocked:   { client: 'Тестовый клиент', amount: 1000, natural_key: 'test|1000|2026-05-24|...' },
      heap_high:                  { pct: 92, usedMB: 460, totalMB: 500 },
      disk_low_critical:          { freeGB: 4.2, pct: 8 },
      client_charge_failed:       { client: 'Тестовый клиент', amount: 5000, balance_before: 1200 },
      modem_offline_20m:          { nick: 'TEST_MODEM', imei: '123', server: 'TEST', mins: 25, lastOnline: '24.05.2026, 20:00' },
      modem_recovered:            { nick: 'TEST_MODEM', imei: '123', server: 'TEST', downSec: 1830 },
      recovery_exhausted:         { nick: 'TEST_MODEM', server: 'TEST', attempts: 3 },
      failover_done:              { server: 'TEST', client: 'Тестовый клиент', deadNick: 'DEAD_MODEM', spareNick: 'SPARE_MODEM', reason: 'hard_offline' },
      failover_no_spare:          { server: 'TEST', client: 'Тестовый клиент', nick: 'DEAD_MODEM' },
      failover_failed:            { server: 'TEST', client: 'Тестовый клиент', error: 'edit_port HTTP 502' },
      payment_received:           { client: 'Тестовый клиент', amount: 12345, inn: '7707083893', source: 'Точка (тест)', balanceAfter: 50000, natural_key: 'test|12345|2026-05-24|...', date: '2026-05-24' },
      client_balance_negative:    { client: 'Тестовый клиент', balance: -1500 },
      proxy_expiring_3d:          { server: 'TEST', portId: 'port123', portName: 'TestClient', client: 'TestClient', daysLeft: 2, validBefore: '2026-05-26' },
      traffic_spike_burst:        { count: 7 },
      dashboard_restarted:        { restartCount: 42 },
      heap_warn:                  { pct: 87, usedMB: 435, totalMB: 500 },
      disk_low_warn:              { freeGB: 18.1, pct: 15 },
      cron_stuck:                 { job: 'TestCron', lastRunAgo: '5 ч', intervalLabel: '1 ч' },
      // Stage 18.15 — bell-only rules
      modem_offline:              { nick: 'TEST_MODEM', imei: '123', server: 'TEST', mins: 25 },
      client_debt:                { client_id: 'test', client: 'Тестовый клиент', balance: -500 },
      crm_reminder:               { id: 'test', name: 'Тестовая сделка', reminderDate: new Date().toISOString() },
    };
    // Bypass cooldown for tests by clearing first.
    try { alerts.clearCooldown(id, samples[id] || {}); } catch (_) {}
    const sent = alerts.trigger(id, samples[id] || {});
    res.json({ ok: sent, id, note: sent ? 'отправлено' : 'не отправлено (отключено или нет telegram_chat_id)' });
  });

  return r;
};
