'use strict';
//
// src/routes/telegram-crm.js — Telegram + AI insights + CRM (Stage 3).
//
// Five routes, all admin-only:
//   POST /api/admin/telegram/send_test       — render & send daily summary
//   GET  /api/admin/telegram/preview         — render summary without sending
//   GET  /api/admin/ai_insights/preview      — Claude AI block alone
//   GET  /api/admin/crm_reminders            — pg query against Twenty CRM
//   GET  /api/admin/crm_token                — exchange creds for CRM token
//
// crm_token previously had inline require('https') / require('http')
// inside the route body — those move to the module head per Stage 6.

const express = require('express');
const http = require('http');
const https = require('https');
const { Pool } = require('pg');

module.exports = function createTelegramCrmRouter(deps) {
  const {
    logger, authMiddleware, adminMiddleware,
    tgBot, tgSummary, aiInsights,
    getAppSettings,
  } = deps;
  const r = express.Router();

  r.post('/api/admin/telegram/send_test', authMiddleware, adminMiddleware, async (req, res) => {
    try {
      const appSettings = getAppSettings();
      const token = appSettings.telegram_bot_token;
      const chatId = appSettings.telegram_chat_id;
      if (!token) return res.status(400).json({ error: 'telegram_bot_token not set' });
      if (!chatId) return res.status(400).json({ error: 'telegram_chat_id not set — send /start to the bot first' });
      const date = req.body && req.body.date && /^\d{4}-\d{2}-\d{2}$/.test(req.body.date)
        ? req.body.date
        : new Date(Date.now() + 3 * 3600000 - 86400000).toISOString().slice(0, 10);
      const { text, parse_mode } = await tgSummary.buildDailySummary(date);
      const rr = await tgBot.sendMessage(token, chatId, text, { parse_mode });
      res.json({ ok: true, date, telegram: rr });
    } catch (e) {
      res.status(502).json({ error: e.message });
    }
  });

  // Preview just the AI-insights block for a given date, without sending to Telegram.
  // Useful for tuning the prompt or sanity-checking output before the morning send.
  r.get('/api/admin/ai_insights/preview', authMiddleware, adminMiddleware, async (req, res) => {
    try {
      const date = (req.query.date && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date))
        ? req.query.date
        : new Date(Date.now() + 3 * 3600000 - 86400000).toISOString().slice(0, 10);
      const includeContext = req.query.include_context === '1';
      const text = await aiInsights.generateInsights(date);
      const out = { ok: true, date, text };
      if (includeContext) out.context = aiInsights.buildDayContext(date);
      res.json(out);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Preview the summary text without sending.
  r.get('/api/admin/telegram/preview', authMiddleware, adminMiddleware, async (req, res) => {
    try {
      const date = (req.query.date && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date))
        ? req.query.date
        : new Date(Date.now() + 3 * 3600000 - 86400000).toISOString().slice(0, 10);
      const rr = await tgSummary.buildDailySummary(date);
      res.json({ ok: true, date, text: rr.text, parse_mode: rr.parse_mode });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // CRM reminders — check opportunities with reminderDate <= now
  r.get('/api/admin/crm_reminders', authMiddleware, adminMiddleware, async (req, res) => {
    const dbUrl = process.env.CRM_DB_URL;
    const workspace = process.env.CRM_WORKSPACE;
    if (!dbUrl || !workspace || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(workspace)) return res.json({ reminders: [] });
    let pool;
    try {
      pool = new Pool({ connectionString: dbUrl, max: 1, idleTimeoutMillis: 5000 });
      const result = await pool.query(
        `SELECT id, name, "reminderDate", stage, amount, "closeDate"
         FROM ${workspace}.opportunity
         WHERE "reminderDate" IS NOT NULL AND "reminderDate" <= NOW() AND "deletedAt" IS NULL
         ORDER BY "reminderDate" ASC LIMIT 50`
      );
      res.json({ reminders: result.rows });
    } catch (e) {
      logger.error('[CRM] Reminders query error:', e.message);
      res.json({ reminders: [], error: e.message });
    } finally {
      if (pool) pool.end().catch(() => {});
    }
  });

  r.get('/api/admin/crm_token', authMiddleware, adminMiddleware, async (req, res) => {
    const crmUrl = process.env.CRM_URL || '';
    const crmEmail = process.env.CRM_EMAIL || '';
    const crmPass = process.env.CRM_PASSWORD || '';
    if (!crmUrl || !crmEmail || !crmPass) {
      return res.json({ error: 'CRM not configured', url: crmUrl || null });
    }
    try {
      const lib = crmUrl.startsWith('https') ? https : http;
      const body = JSON.stringify({
        query: `mutation GetToken($email: String!, $pass: String!, $origin: String!) {
          getLoginTokenFromCredentials(email: $email, password: $pass, origin: $origin) {
            loginToken { token }
          }
        }`,
        variables: { email: crmEmail, pass: crmPass, origin: crmUrl }
      });
      const url = new URL(crmUrl + '/metadata');
      const result = await new Promise((resolve, reject) => {
        const rr = lib.request({
          hostname: url.hostname, port: url.port, path: url.pathname, method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
          timeout: 10000
        }, (resp) => {
          let d = ''; resp.on('data', c => d += c);
          resp.on('end', () => {
            if (resp.statusCode >= 400) { reject(new Error(`CRM HTTP ${resp.statusCode}: ${d.slice(0, 200)}`)); return; }
            try { resolve(JSON.parse(d)); } catch (_) { reject(new Error('CRM вернул не-JSON ответ (возможно сервер перезагружается)')); }
          });
        });
        rr.on('error', reject);
        rr.on('timeout', () => { rr.destroy(); reject(new Error('CRM timeout')); });
        rr.write(body); rr.end();
      });
      const token = result && result.data && result.data.getLoginTokenFromCredentials && result.data.getLoginTokenFromCredentials.loginToken && result.data.getLoginTokenFromCredentials.loginToken.token;
      if (token) {
        res.json({ token, url: crmUrl });
      } else {
        res.json({ error: 'CRM login failed', url: crmUrl });
      }
    } catch (e) {
      res.json({ error: e.message, url: crmUrl });
    }
  });

  return r;
};
