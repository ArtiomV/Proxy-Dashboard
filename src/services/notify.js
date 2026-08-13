'use strict';
//
// src/services/notify.js — B2C Э2: единая точка КЛИЕНТСКИХ уведомлений.
//
// notifyClient(client, text, opts):
//   • Telegram — если у клиента есть tgChatId и задан telegram_bot_token
//     (bot.sendMessage; ошибки TG — warn, поток не роняют);
//   • всегда logActivity('client', ...) — след в системном логе независимо
//     от доставки.
// Email здесь НЕ шлём сознательно — email-потоки уведомлений это фаза 2 по ТЗ.

function create(deps) {
  const { logger, logActivity, getSetting, tgBot } = deps;

  async function notifyClient(client, text, opts = {}) {
    if (!client || !text) return false;
    logActivity('client', opts.level || 'info', opts.action || 'client_notify',
      client.login || client.name || client.id, text, opts.details || null);
    const token = getSetting('telegram_bot_token', '');
    if (!client.tgChatId || !token) return false;   // TG не привязан — только лог
    try {
      await tgBot.sendMessage(token, client.tgChatId, text);
      return true;
    } catch (e) {
      logger.warn(`[Notify] TG ${client.login || client.id}: ${e.message}`);
      return false;
    }
  }

  return { notifyClient };
}

module.exports = { create };
