'use strict';
//
// src/routes/telegram-crm.js — Telegram + AI insights (Stage 3).
// (CRM routes lived here too until the CRM integration was removed, 2026.)
//
// Three routes, all admin-only:
//   POST /api/admin/telegram/send_test       — render & send daily summary
//   GET  /api/admin/telegram/preview         — render summary without sending
//   GET  /api/admin/ai_insights/preview      — Claude AI block alone

const express = require('express');

module.exports = function createTelegramCrmRouter(deps) {
  const {
    authMiddleware, adminMiddleware,
    tgBot, tgSummary, aiInsights,
    getAppSettings,
    getSetting,
  } = deps;
  const r = express.Router();

  r.post('/api/admin/telegram/send_test', authMiddleware, adminMiddleware, async (req, res) => {
    try {
      const appSettings = getAppSettings();
      // WP5: токен — enc1: в kv (SENSITIVE_SETTINGS), читаем через getSetting.
      const token = getSetting ? getSetting('telegram_bot_token', '') : appSettings.telegram_bot_token;
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

  return r;
};
