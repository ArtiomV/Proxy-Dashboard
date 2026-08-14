// B2C Э3 (WP5): единый TG-бот — привязка аккаунта по /start link_<code> и
// роли по whitelist telegram_admin_ids. Чистые юнит-тесты на моках deps
// (паттерн retail-guard/alerts-urgent): исходящие сообщения подменяются
// через init({ sendMessageImpl }), сеть не трогаем.

import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const bot = require('../src/telegram/bot.js');

let sent, buildCalls, settings, clientsArr, audited, saveCalls, linkCodes;

function setup({ settings: s = {}, clients = [], codes = {} } = {}) {
  sent = []; buildCalls = []; audited = []; saveCalls = 0;
  settings = { telegram_bot_token: 'tok', ...s };
  clientsArr = clients;
  linkCodes = codes;   // code → login (одноразовый: удаляем при consume)
  bot.init({
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    getSetting: (k, d) => (k in settings ? settings[k] : d),
    setSetting: (k, v) => { settings[k] = v; },
    buildDailySummary: async (date) => { buildCalls.push(date); return { text: 'SUMMARY ' + date, parse_mode: 'HTML' }; },
    authTokensDb: {
      consume: (code, type) => {
        if (type !== 'tg_link' || !linkCodes[code]) return null;
        const login = linkCodes[code];
        delete linkCodes[code];   // одноразовый
        return { login, type };
      },
    },
    getClients: () => clientsArr,
    saveClients: () => { saveCalls++; },
    auditLog: (who, action, details) => audited.push({ who, action, details }),
    sendMessageImpl: async (token, chatId, text) => { sent.push({ token, chatId, text }); return { ok: true }; },
  });
}

function upd(chatId, text) {
  return { update_id: 1, message: { chat: { id: chatId }, text } };
}

beforeEach(() => setup());

describe('WP5: роли по whitelist telegram_admin_ids', () => {
  it('/today от не-админа → отказ, сводка не строится', async () => {
    setup({ settings: { telegram_admin_ids: '111,222' } });
    await bot.handleUpdate('tok', upd(999, '/today'));
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toContain('нет доступа');
    expect(buildCalls).toHaveLength(0);
  });

  it('/today от админа из whitelist → сводка отправлена', async () => {
    setup({ settings: { telegram_admin_ids: '111,222' } });
    await bot.handleUpdate('tok', upd(222, '/today'));
    expect(buildCalls).toHaveLength(1);
    expect(sent[0].text).toContain('SUMMARY');
  });

  it('/status от не-админа → отказ (WP5: /status тоже за whitelist)', async () => {
    setup({ settings: { telegram_admin_ids: '111' } });
    await bot.handleUpdate('tok', upd(999, '/status'));
    expect(sent[0].text).toContain('нет доступа');
  });

  it('legacy-fallback: whitelist пуст → админ = telegram_chat_id', async () => {
    setup({ settings: { telegram_chat_id: '555' } });
    await bot.handleUpdate('tok', upd(555, '/today'));
    expect(buildCalls).toHaveLength(1);   // старый админ не потерян
    await bot.handleUpdate('tok', upd(777, '/today'));
    expect(sent[1].text).toContain('нет доступа');
  });

  it('whitelist задан → legacy telegram_chat_id НЕ админ (миграция на whitelist)', async () => {
    setup({ settings: { telegram_chat_id: '555', telegram_admin_ids: '111' } });
    await bot.handleUpdate('tok', upd(555, '/today'));
    expect(sent[0].text).toContain('нет доступа');
    expect(buildCalls).toHaveLength(0);
  });
});

describe('WP5: /start без кода', () => {
  it('legacy: whitelist и chat_id пусты → первый /start становится админом', async () => {
    setup();
    await bot.handleUpdate('tok', upd(4242, '/start'));
    expect(settings.telegram_chat_id).toBe('4242');
    expect(sent[0].text).toContain('Бот подключён');
  });

  it('админ из whitelist → админское приветствие', async () => {
    setup({ settings: { telegram_admin_ids: '111' } });
    await bot.handleUpdate('tok', upd(111, '/start'));
    expect(sent[0].text).toContain('/today');
  });

  it('чужой чат → подсказка про привязку в ЛК', async () => {
    setup({ settings: { telegram_admin_ids: '111' } });
    await bot.handleUpdate('tok', upd(999, '/start'));
    expect(sent[0].text).toContain('Привязать Telegram');
    expect(settings.telegram_chat_id).toBeUndefined();
  });
});

describe('WP5: привязка аккаунта /start link_<code>', () => {
  it('успех: код погашен, tgChatId проставлен, saveClients + audit', async () => {
    const client = { id: 'c1', login: 'u_1' };
    setup({ clients: [client], codes: { GOOD: 'u_1' } });
    await bot.handleUpdate('tok', upd(999, '/start link_GOOD'));
    expect(client.tgChatId).toBe('999');
    expect(saveCalls).toBe(1);
    expect(audited.some(a => a.action === 'tg_linked' && a.who === 'u_1')).toBe(true);
    expect(sent[0].text).toContain('Аккаунт привязан');
  });

  it('чужой/невалидный код → отказ, ничего не сохраняем', async () => {
    const client = { id: 'c1', login: 'u_1' };
    setup({ clients: [client], codes: { GOOD: 'u_1' } });
    await bot.handleUpdate('tok', upd(999, '/start link_WRONG'));
    expect(client.tgChatId).toBeUndefined();
    expect(saveCalls).toBe(0);
    expect(sent[0].text).toContain('недействителен');
  });

  it('код одноразовый: повторный /start с тем же кодом → отказ', async () => {
    const c1 = { id: 'c1', login: 'u_1' };
    setup({ clients: [c1], codes: { GOOD: 'u_1' } });
    await bot.handleUpdate('tok', upd(999, '/start link_GOOD'));
    expect(c1.tgChatId).toBe('999');
    // код уже погашен — второй чат тем же кодом получает отказ
    const c2 = { id: 'c2', login: 'u_2' };
    clientsArr.push(c2);
    await bot.handleUpdate('tok', upd(888, '/start link_GOOD'));
    expect(c2.tgChatId).toBeUndefined();
    expect(sent[1].text).toContain('недействителен');
  });

  it('tg-чат занят другим аккаунтом → вежливый отказ + audit tg_link_conflict', async () => {
    const c1 = { id: 'c1', login: 'u_1' };
    const c2 = { id: 'c2', login: 'u_2', tgChatId: '999' };   // уже занято
    setup({ clients: [c1, c2], codes: { GOOD: 'u_1' } });
    await bot.handleUpdate('tok', upd(999, '/start link_GOOD'));
    expect(c1.tgChatId).toBeUndefined();
    expect(saveCalls).toBe(0);
    expect(audited.some(a => a.action === 'tg_link_conflict')).toBe(true);
    expect(sent[0].text).toContain('уже привязан к другому аккаунту');
  });

  it('повторная привязка к ТОМУ ЖЕ аккаунту → ok без записи', async () => {
    const c1 = { id: 'c1', login: 'u_1', tgChatId: '999' };
    setup({ clients: [c1], codes: { GOOD: 'u_1' } });
    await bot.handleUpdate('tok', upd(999, '/start link_GOOD'));
    expect(saveCalls).toBe(0);
    expect(sent[0].text).toContain('уже привязан к вашему аккаунту');
  });
});
