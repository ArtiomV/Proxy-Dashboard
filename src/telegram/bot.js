'use strict';

/**
 * Telegram bot for dashboard notifications.
 *
 * Two surfaces:
 *   1) Long-poll loop that handles /start and registers chat_ids.
 *      Legacy: the first admin that does /start becomes the recipient
 *      (only while telegram_admin_ids whitelist AND telegram_chat_id are empty).
 *      B2C Э3 (WP5): `/start link_<code>` привязывает TG-чат к аккаунту
 *      клиента (код — auth_tokens type tg_link, выдаёт POST /api/client/tg_link_code).
 *   2) sendMessage()/runDailySummary() for outbound traffic.
 *
 * Роли: команды сводки (/today /yesterday /status) — только админам.
 * Админ = chat_id из whitelist telegram_admin_ids (CSV); если whitelist пуст —
 * legacy-fallback на telegram_chat_id (миграция без потери админа).
 *
 * State is kept in appSettings via the host's setSetting/getSetting helpers
 * (passed in via init): telegram_bot_token, telegram_chat_id,
 * telegram_admin_ids, telegram_summary_enabled, telegram_summary_time (HH:MM MSK).
 */

const https = require('https');

let logger;
let getSetting;        // (key, def) => value
let setSetting;        // (key, val) => Promise<void> | void
let buildDailySummary; // async (yyyy-mm-dd) => { text, parse_mode }
// B2C Э3 (WP5): привязка аккаунта из бота. Прокидываются из server.js через
// src/boot/startup.js — бот сам про БД не знает.
let authTokensDb;      // issue/consume одноразовых кодов (tg_link)
let getClients;        // () => in-memory clients[]
let saveClients;       // (clients) => persist через clientsRepo.upsertRow
let auditLog;          // (login, action, details)
let kvGet, kvSet;      // кэш username бота (ключ tg_bot_username)
let _sendImpl = null;  // DI для тестов: подмена исходящих сообщений без сети
let _tgReqImpl = null; // DI для тестов: подмена сырых вызовов TG API (answerCallbackQuery и т.п.)
let onAlertAck = null; // B2 (23.08): обработчик ack-кнопок алертов (src/telegram/alerts.js)
let _lastUpdateId = 0;
let _pollAbort = false;

function init(deps) {
  logger          = deps.logger;
  getSetting      = deps.getSetting;
  setSetting      = deps.setSetting;
  buildDailySummary = deps.buildDailySummary;
  authTokensDb    = deps.authTokensDb || null;
  getClients      = deps.getClients || null;
  saveClients     = deps.saveClients || null;
  auditLog        = deps.auditLog || null;
  kvGet           = deps.kvGet || null;
  kvSet           = deps.kvSet || null;
  _sendImpl       = deps.sendMessageImpl || null;
  _tgReqImpl      = deps.tgRequestImpl || null;
  onAlertAck      = deps.onAlertAck || null;
}

// Внутренние отправители (handleUpdate) идут через _send — в тестах подменяется
// через init({ sendMessageImpl }), в проде — боевой sendMessage (HTTPS в TG API).
function _send(token, chatId, text, opts) {
  return (typeof _sendImpl === 'function' ? _sendImpl : sendMessage)(token, chatId, text, opts);
}

// Сырые вызовы Bot API, для которых нет обёртки-сообщения (answerCallbackQuery,
// editMessageReplyMarkup). В тестах — через init({ tgRequestImpl }).
function _api(token, method, params) {
  return (typeof _tgReqImpl === 'function' ? _tgReqImpl : tgRequest)(token, method, params);
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
  // B2 (23.08): opts.reply_markup — inline-клавиатура (кнопки ack алертов).
  const base = { chat_id: chatId, parse_mode: opts.parse_mode || 'HTML', disable_web_page_preview: true };
  if (opts.reply_markup) base.reply_markup = opts.reply_markup;
  // Telegram message hard limit 4096 chars — split or truncate.
  const TXT_LIMIT = 4000;
  if (text.length > TXT_LIMIT) {
    // send first chunk with note
    const first = text.slice(0, TXT_LIMIT) + '\n…(обрезано — открой дашборд для полного списка)';
    return _api(token, 'sendMessage', { ...base, text: first });
  }
  return _api(token, 'sendMessage', { ...base, text });
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
  // B2 (23.08): inline-кнопки под алертами («🔧 В работе» / «✅ Решено»).
  if (u.callback_query) { await _handleAlertCallback(token, u.callback_query); return; }
  const msg = u.message || u.edited_message;
  if (!msg || !msg.text) return;
  const chatId = msg.chat && msg.chat.id;
  const txt = msg.text.trim();

  // /start [payload]: payload link_<code> — привязка аккаунта из ЛК (WP5);
  // без payload — регистрация админ-чата (legacy) либо подсказка про привязку.
  if (txt === '/start' || txt.startsWith('/start ')) {
    const arg = txt.slice('/start'.length).trim();
    if (arg.startsWith('link_')) { await _handleLinkCode(token, chatId, arg.slice(5), msg.from); return; }

    const whitelist = _adminWhitelist();
    const legacyChatId = String(getSetting('telegram_chat_id', '') || '');
    if (!whitelist.length && !legacyChatId) {
      // Legacy-установка: первый /start wins — register as recipient.
      // Действует только пока ни whitelist, ни chat_id не заданы.
      try { await setSetting('telegram_chat_id', String(chatId)); }
      catch (e) { logger.error('[Telegram] save chat_id: ' + e.message); }
      await _send(token, chatId, _adminGreeting());
      logger.info('[Telegram] chat_id registered: ' + chatId);
    } else if (_isAdminChat(chatId)) {
      await _send(token, chatId, _adminGreeting());
    } else {
      await _send(token, chatId,
        '👋 <b>Бот proxies.rent</b>\n\n' +
        'Присылаю уведомления о балансе и прокси. Чтобы подключить — привяжите аккаунт: ' +
        'личный кабинет → Профиль → «Привязать Telegram».');
    }
    return;
  }

  if (txt === '/yesterday' || txt === '/today') {
    // Команды сводки — только админам (whitelist; пустой whitelist → legacy
    // fallback на telegram_chat_id, см. _isAdminChat). Чужие — отказ.
    if (!_isAdminChat(chatId)) {
      await _send(token, chatId, '⛔ У тебя нет доступа к сводке.');
      return;
    }
    const now = new Date();
    const mskNow = new Date(now.getTime() + 3 * 3600000);
    let date;
    if (txt === '/yesterday') {
      mskNow.setUTCDate(mskNow.getUTCDate() - 1);
    }
    date = mskNow.toISOString().slice(0, 10);
    try {
      const summary = await buildDailySummary(date);
      await _send(token, chatId, summary.text, { parse_mode: summary.parse_mode });
    } catch (e) {
      await _send(token, chatId, '❌ Ошибка построения сводки: ' + e.message);
    }
    return;
  }

  if (txt === '/status') {
    if (!_isAdminChat(chatId)) {
      await _send(token, chatId, '⛔ У тебя нет доступа к сводке.');
      return;
    }
    const enabled = !!getSetting('telegram_summary_enabled', true);
    const time = getSetting('telegram_summary_time', '08:00');
    const chat = getSetting('telegram_chat_id', '');
    await _send(token, chatId,
      `📡 <b>Статус подписки</b>\nВключено: ${enabled ? 'да' : 'нет'}\nВремя: ${time} МСК\nchat_id: <code>${chat}</code>`);
    return;
  }
}

// ────────────────────────────────────────────────────────────────
//  B2 (23.08): callback_query от inline-кнопок алертов.
//  data: 'a:ack:<hash16>' | 'a:solve:<hash16>' (хэш пары ruleId|dedup —
//  лимит callback_data 64 байта). Разбор и запись — в alerts.onAlertAck.
// ────────────────────────────────────────────────────────────────
function _escTg(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
async function _handleAlertCallback(token, cq) {
  const chatId = cq.message && cq.message.chat && cq.message.chat.id;
  const answer = async (text) => {
    try { await _api(token, 'answerCallbackQuery', { callback_query_id: cq.id, text }); }
    catch (e) { logger.warn('[Telegram] answerCallbackQuery: ' + e.message); }
  };
  if (!_isAdminChat(chatId)) { await answer('⛔ Нет доступа'); return; }
  const m = String(cq.data || '').match(/^a:(ack|solve):([0-9a-f]{16})$/);
  if (!m) { await answer('Неизвестная кнопка'); return; }
  if (typeof onAlertAck !== 'function') { await answer('Обработчик алертов недоступен'); return; }
  const kind = m[1] === 'solve' ? 'solved' : 'ack';
  const from = cq.from || {};
  const user = from.username ? '@' + from.username : (from.first_name || 'admin');
  let r;
  try { r = await onAlertAck(kind, m[2], user); }
  catch (e) { await answer('Ошибка: ' + e.message); return; }
  if (!r || !r.ok) {
    await answer(r && r.error === 'stale' ? 'Кнопка устарела — продублируй алерт' : 'Ошибка обработки');
    return;
  }
  if (r.already) {
    await answer(kind === 'ack' ? ('Уже в работе у ' + (r.by || '?')) : 'Уже отмечено решённым');
    return;
  }
  await answer(kind === 'ack' ? 'Взято в работу' : 'Отмечено решённым');
  const timeMsk = new Date().toLocaleTimeString('ru-RU', { timeZone: 'Europe/Moscow', hour: '2-digit', minute: '2-digit' });
  await _send(token, chatId, kind === 'ack'
    ? `🔧 Взял ${_escTg(user)} в ${timeMsk} МСК — алерт заглушен на ${r.ttlHours} ч`
    : `✅ ${_escTg(user)} отметил алерт решённым`);
}

// ────────────────────────────────────────────────────────────────
//  Роли (WP5): whitelist telegram_admin_ids (CSV telegram id).
//  Пустой whitelist → legacy-fallback: админ = telegram_chat_id (старая
//  установка не теряет доступа; data-миграция не нужна).
// ────────────────────────────────────────────────────────────────
function _adminWhitelist() {
  return String(getSetting('telegram_admin_ids', '') || '')
    .split(',').map(s => s.trim()).filter(Boolean);
}

function _isAdminChat(chatId) {
  const sid = String(chatId);
  const whitelist = _adminWhitelist();
  if (whitelist.length) return whitelist.includes(sid);
  const legacy = String(getSetting('telegram_chat_id', '') || '');
  return !!legacy && legacy === sid;
}

function _adminGreeting() {
  return '✅ <b>Бот подключён</b>\n\n' +
    'Этот чат получает ежедневные сводки и алерты proxies.rent.\n\n' +
    'Команды:\n' +
    '/today — сводка за сегодня (текущий момент)\n' +
    '/yesterday — пересчитать вчерашнюю сводку\n' +
    '/status — состояние подписки';
}

// ────────────────────────────────────────────────────────────────
//  Привязка аккаунта (WP5): /start link_<code>
//  Код — одноразовый auth_token типа tg_link (TTL 15 мин), выданный из ЛК.
// ────────────────────────────────────────────────────────────────
async function _handleLinkCode(token, chatId, code, from) {
  if (!authTokensDb || !getClients || !saveClients) {
    await _send(token, chatId, '⚠️ Привязка временно недоступна — попробуйте позже.');
    return;
  }
  const hit = authTokensDb.consume(String(code || ''), 'tg_link');
  if (!hit) {
    await _send(token, chatId,
      '❌ Код недействителен или истёк. Получите новый в личном кабинете: Профиль → «Привязать Telegram».');
    return;
  }
  const clients = getClients();
  const client = clients.find(c => c.login === hit.login);
  if (!client) {
    await _send(token, chatId, '❌ Аккаунт не найден — получите новый код в личном кабинете.');
    return;
  }
  const sid = String(chatId);
  if (client.tgChatId === sid) {
    await _send(token, chatId, '✅ Этот Telegram уже привязан к вашему аккаунту.');
    return;
  }
  // Один TG-чат = один аккаунт (UNIQUE-индекс idx_clients_tg — последняя
  // линия защиты; здесь — вежливая проверка до записи).
  const occupant = clients.find(c => c !== client && c.tgChatId === sid);
  if (occupant) {
    try { if (auditLog) auditLog(client.login, 'tg_link_conflict', { tg: sid }); } catch (_) { /* best-effort */ }
    await _send(token, chatId,
      '⚠️ Этот Telegram уже привязан к другому аккаунту. ' +
      'Сначала отвяжите его в личном кабинете того аккаунта (Профиль → «Отвязать»).');
    return;
  }
  client.tgChatId = sid;
  client.tgUsername = (from && from.username) || '';   // 065: показываем в профиле ЛК
  saveClients(clients);   // persist через clientsRepo.upsertRow (tg_chat_id, tg_username)
  try { if (auditLog) auditLog(client.login, 'tg_linked', { tg: sid }); } catch (_) { /* best-effort */ }
  logger.info('[Telegram] account linked: ' + client.login + ' ↔ chat ' + sid);
  await _send(token, chatId,
    '✅ <b>Аккаунт привязан</b>\n\n' +
    'Теперь сюда приходят уведомления: зачисления на баланс, выдача прокси, ' +
    'предупреждения об отключении. Отвязать можно в личном кабинете (Профиль).');
}

// ---------------------------------------------------------------------------
// getBotUsername — username бота для ссылки привязки (t.me/<user>?start=...).
// Источник: getMe с кэшем в kv (ключ tg_bot_username); при недоступности API —
// fallback на настройку telegram_bot_username (та же, что у Login Widget).
// ---------------------------------------------------------------------------
const BOT_USERNAME_KV_KEY = 'tg_bot_username';

async function getBotUsername() {
  let cached = '';
  try { const row = kvGet && kvGet(BOT_USERNAME_KV_KEY); cached = row && row.value || ''; } catch (_) { /* best-effort */ }
  if (cached) return cached;
  const token = getSetting('telegram_bot_token', '');
  if (token) {
    try {
      const r = await tgRequest(token, 'getMe');
      if (r && r.ok && r.result && r.result.username) {
        try { if (kvSet) kvSet(BOT_USERNAME_KV_KEY, String(r.result.username)); } catch (_) { /* best-effort */ }
        return String(r.result.username);
      }
    } catch (e) {
      logger.warn('[Telegram] getMe failed: ' + e.message);
    }
  }
  return String(getSetting('telegram_bot_username', '') || '');
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function start() {
  _pollAbort = false;
  pollLoop().catch(e => logger.error('[Telegram] poll loop crashed: ' + e.message));
}

function stop() { _pollAbort = true; }

module.exports = { init, start, stop, sendMessage, tgRequest, getBotUsername, handleUpdate, _isAdminChat, BOT_USERNAME_KV_KEY };
