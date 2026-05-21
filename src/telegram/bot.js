'use strict';

/**
 * Telegram bot for dashboard notifications.
 *
 * Two surfaces:
 *   1) Long-poll loop that handles /start and registers chat_ids.
 *      The first admin that does /start becomes the recipient.
 *   2) sendMessage()/runDailySummary() for outbound traffic.
 *
 * State is kept in appSettings via the host's setSetting/getSetting helpers
 * (passed in via init): telegram_bot_token, telegram_chat_id,
 * telegram_summary_enabled, telegram_summary_time (HH:MM MSK).
 */

const https = require('https');

let logger;
let getSetting;        // (key, def) => value
let setSetting;        // (key, val) => Promise<void> | void
let buildDailySummary; // async (yyyy-mm-dd) => { text, parse_mode }
let _lastUpdateId = 0;
let _pollAbort = false;

function init(deps) {
  logger          = deps.logger;
  getSetting      = deps.getSetting;
  setSetting      = deps.setSetting;
  buildDailySummary = deps.buildDailySummary;
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function tgRequest(token, method, params) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(params || {});
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${token}/${method}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 30000,
    }, res => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => {
        try { resolve(JSON.parse(buf)); }
        catch (e) { reject(new Error('TG response parse: ' + e.message + ' body=' + buf.slice(0, 200))); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('TG timeout')));
    req.write(body); req.end();
  });
}

async function sendMessage(token, chatId, text, opts = {}) {
  if (!token) throw new Error('telegram_bot_token not set');
  if (!chatId) throw new Error('telegram_chat_id not set');
  // Telegram message hard limit 4096 chars — split or truncate.
  const TXT_LIMIT = 4000;
  if (text.length > TXT_LIMIT) {
    // send first chunk with note
    const first = text.slice(0, TXT_LIMIT) + '\n…(обрезано — открой дашборд для полного списка)';
    return tgRequest(token, 'sendMessage', { chat_id: chatId, text: first, parse_mode: opts.parse_mode || 'HTML', disable_web_page_preview: true });
  }
  return tgRequest(token, 'sendMessage', { chat_id: chatId, text, parse_mode: opts.parse_mode || 'HTML', disable_web_page_preview: true });
}

// ---------------------------------------------------------------------------
// Long-poll loop — handles /start to auto-register chat_id
// ---------------------------------------------------------------------------

async function pollLoop() {
  while (!_pollAbort) {
    const token = getSetting('telegram_bot_token', '');
    if (!token) { await sleep(15000); continue; }
    try {
      const r = await tgRequest(token, 'getUpdates', { offset: _lastUpdateId + 1, timeout: 25 });
      if (r && r.ok && Array.isArray(r.result)) {
        for (const u of r.result) {
          _lastUpdateId = u.update_id;
          await handleUpdate(token, u);
        }
      } else if (r && !r.ok) {
        // Telegram 429 — read retry_after and honor it (1.5x as safety margin).
        // Without this we hammered the API for "Too Many Requests" indefinitely.
        if (r.error_code === 429) {
          const retryAfter = (r.parameters && r.parameters.retry_after) ? r.parameters.retry_after : 5;
          const waitMs = Math.min(Math.round(retryAfter * 1500), 60000);
          logger.warn(`[Telegram] 429 rate-limited, backing off ${waitMs}ms`);
          await sleep(waitMs);
        } else if (r.error_code === 401 || r.error_code === 404) {
          // Invalid token / bot deleted — don't spam retries, wait long.
          logger.error('[Telegram] auth failure: ' + (r.description || ''));
          await sleep(60000);
        } else {
          logger.warn('[Telegram] getUpdates: ' + (r.description || JSON.stringify(r)));
          await sleep(5000);
        }
      }
    } catch (e) {
      // ECONNRESET / timeouts are expected for long-poll — log at debug level
      const transient = /ECONNRESET|timeout|ETIMEDOUT|EAI_AGAIN/i.test(e.message || '');
      if (!transient) logger.warn('[Telegram] poll error: ' + (e.message || e));
      await sleep(5000);
    }
  }
}

async function handleUpdate(token, u) {
  const msg = u.message || u.edited_message;
  if (!msg || !msg.text) return;
  const chatId = msg.chat && msg.chat.id;
  const txt = msg.text.trim();

  if (txt === '/start') {
    const currentChatId = String(getSetting('telegram_chat_id', '') || '');
    if (!currentChatId) {
      // First /start wins — register as recipient
      try { await setSetting('telegram_chat_id', String(chatId)); }
      catch (e) { logger.error('[Telegram] save chat_id: ' + e.message); }
      await sendMessage(token, chatId,
        '✅ <b>Бот подключён</b>\n\n' +
        'Этот чат теперь получает ежедневные сводки proxies.rent.\n\n' +
        'Команды:\n' +
        '/today — сводка за сегодня (текущий момент)\n' +
        '/yesterday — пересчитать вчерашнюю сводку\n' +
        '/status — состояние подписки');
      logger.info('[Telegram] chat_id registered: ' + chatId);
    } else if (currentChatId === String(chatId)) {
      await sendMessage(token, chatId, '✅ Этот чат уже получает сводки.');
    } else {
      await sendMessage(token, chatId,
        '⚠️ Сводки уже отправляются в другой чат. ' +
        'Чтобы перенаправить — попроси админа очистить telegram_chat_id в настройках дашборда.');
    }
    return;
  }

  if (txt === '/yesterday' || txt === '/today') {
    const now = new Date();
    const mskNow = new Date(now.getTime() + 3 * 3600000);
    let date;
    if (txt === '/yesterday') {
      mskNow.setUTCDate(mskNow.getUTCDate() - 1);
    }
    date = mskNow.toISOString().slice(0, 10);
    const recipient = String(getSetting('telegram_chat_id', '') || '');
    if (recipient && recipient !== String(chatId)) {
      await sendMessage(token, chatId, '⛔ У тебя нет доступа к сводке.');
      return;
    }
    try {
      const summary = await buildDailySummary(date);
      await sendMessage(token, chatId, summary.text, { parse_mode: summary.parse_mode });
    } catch (e) {
      await sendMessage(token, chatId, '❌ Ошибка построения сводки: ' + e.message);
    }
    return;
  }

  if (txt === '/status') {
    const enabled = !!getSetting('telegram_summary_enabled', true);
    const time = getSetting('telegram_summary_time', '08:00');
    const chat = getSetting('telegram_chat_id', '');
    await sendMessage(token, chatId,
      `📡 <b>Статус подписки</b>\nВключено: ${enabled ? 'да' : 'нет'}\nВремя: ${time} МСК\nchat_id: <code>${chat}</code>`);
    return;
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function start() {
  _pollAbort = false;
  pollLoop().catch(e => logger.error('[Telegram] poll loop crashed: ' + e.message));
}

function stop() { _pollAbort = true; }

module.exports = { init, start, stop, sendMessage, tgRequest };
