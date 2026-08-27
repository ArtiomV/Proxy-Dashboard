// B2C Э3 (WP5): админ-алерты розницы — правила retail_registered,
// retail_purchase, retail_bulk_buy, retail_pool_low, retail_pool_empty.
// Проверяем срабатывание, дедуп по ключу и рендер текстов.
// Паттерн — как alerts-urgent.test.js (моки deps, fake timers за boot-grace).

import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const alerts = require('../src/telegram/alerts.js');

let sendMessage;
beforeAll(() => {
  sendMessage = vi.fn().mockResolvedValue({});
  alerts.init({
    logger: { warn: () => {}, info: () => {}, error: () => {} },
    // WP5: токен читается через getSetting (enc1: в kv) — мокаем его.
    getSetting: (k, d) => (k === 'telegram_bot_token' ? 'tok' : d),
    appSettings: { telegram_chat_id: '123', telegram_night_digest_enabled: false },
    kvSetCritical: () => ({ ok: true }),
    kvGet: { get: () => undefined },
    db: { prepare: () => ({ run: () => ({ lastInsertRowid: 1 }), get: () => undefined }) },
    tgBot: { sendMessage },
  });
  // boot-grace 5 минут молчания — переносим «сейчас» за пределы окна.
  vi.useFakeTimers();
  vi.setSystemTime(Date.now() + 10 * 60 * 1000);
});

beforeEach(() => { sendMessage.mockClear(); });

afterAll(() => { vi.useRealTimers(); });

describe('WP5: retail-алерты — срабатывание и рендер', () => {
  it('retail_registered: email-регистрация → TG с логином и каналом', () => {
    const fired = alerts.trigger('retail_registered', { login: 'u_a1', email: 'a@b.c', via: 'email' });
    expect(fired).toBe(true);
    const text = sendMessage.mock.calls[0][2];
    expect(text).toContain('u_a1');
    expect(text).toContain('a@b.c');
    expect(text).toContain('email + пароль');
  });

  it('retail_registered: TG-регистрация → канал «Telegram Login»; дедуп по login', () => {
    expect(alerts.trigger('retail_registered', { login: 'u_a2', email: null, via: 'telegram' })).toBe(true);
    expect(sendMessage.mock.calls[0][2]).toContain('Telegram Login');
    // повтор с тем же login — кулдаун (дедуп)
    expect(alerts.trigger('retail_registered', { login: 'u_a2', email: null, via: 'telegram' })).toBe(false);
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it('retail_purchase: покупка → тариф и сумма; дедуп по login+tariff+price', () => {
    const p = { login: 'u_b1', tariff: 'РФ 100 Мбит', price: 99 };
    expect(alerts.trigger('retail_purchase', p)).toBe(true);
    const text = sendMessage.mock.calls[0][2];
    expect(text).toContain('u_b1');
    expect(text).toContain('РФ 100 Мбит');
    expect(text).toContain('99');
    expect(alerts.trigger('retail_purchase', p)).toBe(false);   // тот же ключ — дедуп
    expect(alerts.trigger('retail_purchase', { ...p, price: 199 })).toBe(true);  // другая сумма — новое событие
  });

  it('retail_bulk_buy: дедуп по clientId — другой клиент проходит', () => {
    expect(alerts.trigger('retail_bulk_buy', { client_id: 'c1', login: 'u_c1', count: 3, threshold: 3 })).toBe(true);
    const text = sendMessage.mock.calls[0][2];
    expect(text).toContain('u_c1');
    expect(text).toContain('3');
    expect(alerts.trigger('retail_bulk_buy', { client_id: 'c1', login: 'u_c1', count: 4, threshold: 3 })).toBe(false);
    expect(alerts.trigger('retail_bulk_buy', { client_id: 'c2', login: 'u_c2', count: 3, threshold: 3 })).toBe(true);
  });

  it('retail_pool_low: агрегированный (20.08) — глобальный дедуп; текст содержит free/min и разбивку', () => {
    expect(alerts.trigger('retail_pool_low', { free: 2, min: 3, breakdown: 'S1: 2, S2: 0' })).toBe(true);
    const text = sendMessage.mock.calls[0][2];
    expect(text).toContain('S1: 2');
    expect(text).toContain('2');
    expect(alerts.trigger('retail_pool_low', { free: 1, min: 3, breakdown: 'S1: 1' })).toBe(false);  // глобальный кулдаун (сутки)
  });

  it('retail_pool_empty: критический, дедуп по серверу', () => {
    const rule = alerts.RULES.retail_pool_empty;
    expect(rule).toBeTruthy();
    expect(rule.priority).toBe('critical');
    expect(alerts.trigger('retail_pool_empty', { server: 'S9', geo: 'MD' })).toBe(true);
    expect(sendMessage.mock.calls[0][2]).toContain('S9');
    expect(alerts.trigger('retail_pool_empty', { server: 'S9', geo: 'MD' })).toBe(false);
  });
});
