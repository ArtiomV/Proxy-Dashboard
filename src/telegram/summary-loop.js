'use strict';
//
// src/telegram/summary-loop.js — ежедневная сводка в Telegram: тик каждые
// 60с, отправка когда MSK-время ≥ telegram_summary_time и сегодня ещё не
// отправляли (>= target, не === — лаг event-loop не теряет отправку).
// До 3 ретраев на сетевых ошибках, дата последней отправки в appSettings.
// Extracted from server.js (Stage 9, boot-хвост) — без изменения логики.

function create(deps) {
  const { appSettings, tgSummary, tgBot, saveSettings, logger, logActivity } = deps;

  async function tick() {
    try {
      if (!appSettings.telegram_summary_enabled) return;
      const token  = appSettings.telegram_bot_token;
      const chatId = appSettings.telegram_chat_id;
      const time   = appSettings.telegram_summary_time || '08:00';
      if (!token || !chatId) return;
      // MSK now
      const mskNow = new Date(Date.now() + 3 * 3600000);
      const hh = String(mskNow.getUTCHours()).padStart(2, '0');
      const mm = String(mskNow.getUTCMinutes()).padStart(2, '0');
      const nowHM = `${hh}:${mm}`;
      if (nowHM < time) return;          // not yet
      const todayMsk = mskNow.toISOString().slice(0, 10);
      if (appSettings.telegram_last_sent_date === todayMsk) return; // already sent today
      const yMsk = new Date(mskNow.getTime() - 86400000).toISOString().slice(0, 10);
      const { text, parse_mode } = await tgSummary.buildDailySummary(yMsk);
      // Retry up to 3 times on transient network errors (ECONNRESET, timeout)
      let lastErr = null;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const resp = await tgBot.sendMessage(token, chatId, text, { parse_mode });
          if (resp && resp.ok === false) throw new Error('Telegram: ' + (resp.description || JSON.stringify(resp)));
          lastErr = null; break;
        } catch (e) {
          lastErr = e;
          logger.warn(`[Telegram] daily send attempt ${attempt}/3 failed: ${e.message || e}`);
          await new Promise(r => setTimeout(r, 2000 * attempt));
        }
      }
      if (lastErr) throw lastErr;
      appSettings.telegram_last_sent_date = todayMsk;
      saveSettings();
      logger.info(`[Telegram] Daily summary sent for ${yMsk} → chat ${chatId}`);
      logActivity('system', 'info', 'telegram_summary_sent', null, `Daily summary sent for ${yMsk}`, { date: yMsk, chatId });
    } catch (e) {
      const detail = (e && e.stack) ? e.stack : (e && e.message) ? e.message : JSON.stringify(e);
      logger.error('[Telegram] daily tick failed: ' + detail);
      logActivity('system', 'error', 'telegram_summary_failed', null, 'Daily summary failed', { error: detail.slice(0, 500) });
    }
  }

  return { tick };
}

module.exports = { create };
