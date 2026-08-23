// B2 (ТЗ мониторинга v2, этап 4, 23.08): ack-кнопки «🔧 В работе» /
// «✅ Решено» под TG-алертами и подавление повторных алертов.
//   - кнопки только у critical/important (не bell, не *_recovered, не early);
//   - ack глушит правило по dedup-ключу до until_ts (TTL = ack_ttl_hours);
//   - solved глушит до конца инцидента (until_ts IS NULL);
//   - повторный ack → already + продление until_ts, дублей строк нет;
//   - протухший ack не глушит; неизвестный hash → stale;
//   - после ack кнопки убираются editMessageReplyMarkup.
// БД — in-memory better-sqlite3, миграция 076 накатывается из файла
// (заодно валидируем сам SQL).

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const alerts = require('../src/telegram/alerts.js');

let db, sendMessage, tgRequest;
const appSettings = { telegram_chat_id: '123' };
const kv = { telegram_bot_token: 'tok' };   // getSetting читает отсюда

beforeAll(() => {
  db = new Database(':memory:');
  db.exec(fs.readFileSync(path.join(__dirname, '..', 'migrations', '032_notifications.sql'), 'utf8'));
  // Минимальный server_downtime — нужен для ALTER TABLE в миграции 076.
  db.exec('CREATE TABLE server_downtime (id INTEGER PRIMARY KEY, server_name TEXT, down_from TEXT, down_to TEXT)');
  db.exec(fs.readFileSync(path.join(__dirname, '..', 'migrations', '076_monitoring_v2_stage4.sql'), 'utf8'));
  sendMessage = vi.fn().mockResolvedValue({ ok: true, result: { message_id: 777 } });
  tgRequest = vi.fn().mockResolvedValue({ ok: true, result: {} });
  alerts.init({
    logger: { warn() {}, info() {}, error() {}, debug() {} },
    getSetting: (k, d) => (k in kv ? kv[k] : d),
    appSettings,
    kvSetCritical: () => ({ ok: true }),
    kvGet: { get: () => undefined },
    db,
    tgBot: { sendMessage, tgRequest },
  });
  vi.useFakeTimers();
  vi.setSystemTime(Date.now() + 10 * 60 * 1000);   // за пределы boot grace
});

beforeEach(() => { sendMessage.mockClear(); tgRequest.mockClear(); });
afterAll(() => { vi.useRealTimers(); db.close(); });

// sendMessage/.then и tgRequest/.catch — микротаски; даём им добежать.
const flush = () => Promise.resolve().then(() => Promise.resolve());

describe('B2: кнопки под алертами', () => {
  it('critical-алерт получает «В работе»/«Решено» с callback_data a:ack|solve:<hash16>', () => {
    expect(alerts.trigger('server_unreachable', { server: 'ACKB1', error: 'timeout' })).toBe(true);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const opts = sendMessage.mock.calls[0][3];
    const kb = opts.reply_markup.inline_keyboard[0];
    expect(kb[0].text).toContain('В работе');
    expect(kb[0].callback_data).toMatch(/^a:ack:[0-9a-f]{16}$/);
    expect(kb[1].text).toContain('Решено');
    expect(kb[1].callback_data).toMatch(/^a:solve:[0-9a-f]{16}$/);
    // callback_data в пределах TG-лимита 64 байта
    expect(kb[0].callback_data.length).toBeLessThanOrEqual(64);
  });

  it('important-алерт (не recovered) тоже с кнопками', () => {
    expect(alerts.trigger('modem_ping_dead', { server: 'ACKB2', nick: 'M1', imei: 'i1', loss: 100 })).toBe(true);
    const opts = sendMessage.mock.calls[0][3];
    expect(opts.reply_markup.inline_keyboard[0]).toHaveLength(2);
  });

  it('*_recovered — без кнопок (глушить нечего)', () => {
    expect(alerts.trigger('server_recovered', { server: 'ACKB3', downSec: 120 })).toBe(true);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0][3]).toBeUndefined();
  });

  it('early-priority — без кнопок', () => {
    expect(alerts.trigger('reboot_score_high', { server: 'ACKB4', nick: 'R4', imei: 'i4', score: 7 })).toBe(true);
    expect(sendMessage.mock.calls[0][3]).toBeUndefined();
  });

  it('старое bell-only правило удалено — офлайн идёт через единое правило', () => {
    expect(alerts.RULES.modem_offline).toBeUndefined();
    expect(alerts.RULES.modem_offline_20m).toBeTruthy();
  });

  it('коллектор и event-driven путь не создают две карточки одного офлайна', () => {
    const payload = { server: 'DEDUP', imei: 'imei-1', nick: 'M1', mins: 30, lastOnline: '—' };
    const key = 'modem_offline_20m|mof_DEDUP_imei-1';
    alerts.recordBellEvent({
      dedup_key: key, dedup_window_sec: 86400, rule_id: 'modem_offline_20m',
      priority: 'important', entity_kind: 'modem', entity_id: 'M1',
      title: 'Модем офлайн', message: 'тест', payload,
    });
    alerts.clearCooldown('modem_offline_20m', payload);
    expect(alerts.trigger('modem_offline_20m', payload)).toBe(true);
    const count = db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE dedup_key = ?').get(key).n;
    expect(count).toBe(1);
  });
});

describe('B2: подавление алертов ack-ами', () => {
  it('ack «в работе» глушит повторный алерт + кнопки убираются из исходного сообщения', async () => {
    const p = { server: 'ACKS1', error: 'timeout' };
    expect(alerts.trigger('server_unreachable', p)).toBe(true);
    await flush();   // .then сохранит message_id в _ackHashMap
    const hash = alerts._ackHash('server_unreachable', 'srv_ACKS1');
    const r = await alerts.onAlertAck('ack', hash, '@tester');
    expect(r).toMatchObject({ ok: true, ttlHours: 2 });   // дефолт ack_ttl_hours=2
    alerts.clearCooldown('server_unreachable', p);
    expect(alerts.trigger('server_unreachable', p)).toBe(false);
    expect(sendMessage).toHaveBeenCalledTimes(1);   // повтор не ушёл
    await flush();
    expect(tgRequest).toHaveBeenCalledWith('tok', 'editMessageReplyMarkup',
      expect.objectContaining({ chat_id: '123', message_id: 777 }));
  });

  it('ack одного сервера не глушит алерт другого', () => {
    expect(alerts.trigger('server_unreachable', { server: 'ACKS1_OTHER', error: 't' })).toBe(true);
  });

  it('«решено» глушит до конца инцидента (until_ts IS NULL)', async () => {
    const p = { server: 'ACKS2', error: 'timeout' };
    expect(alerts.trigger('server_unreachable', p)).toBe(true);
    const hash = alerts._ackHash('server_unreachable', 'srv_ACKS2');
    const r = await alerts.onAlertAck('solved', hash, '@boss');
    expect(r.ok).toBe(true);
    alerts.clearCooldown('server_unreachable', p);
    expect(alerts.trigger('server_unreachable', p)).toBe(false);
    const row = db.prepare('SELECT kind, until_ts FROM alert_acks WHERE rule_id = ? AND dedup_key = ?')
      .get('server_unreachable', 'srv_ACKS2');
    expect(row.kind).toBe('solved');
    expect(row.until_ts).toBeNull();
  });

  it('протухший ack (until_ts в прошлом) не глушит', () => {
    db.prepare(`INSERT INTO alert_acks (rule_id, dedup_key, kind, acked_by, acked_at, until_ts)
                VALUES ('server_unreachable', 'srv_ACKS3', 'ack', '@old', ?, ?)`)
      .run(new Date().toISOString(), Date.now() - 1000);
    alerts._ackInvalidate();
    expect(alerts.trigger('server_unreachable', { server: 'ACKS3', error: 't' })).toBe(true);
  });

  it('повторный ack → already + by, строка одна, until_ts продлён', async () => {
    const p = { server: 'ACKS4', error: 't' };
    alerts.trigger('server_unreachable', p);
    const hash = alerts._ackHash('server_unreachable', 'srv_ACKS4');
    const r1 = await alerts.onAlertAck('ack', hash, '@first');
    expect(r1.ok).toBe(true);
    expect(r1.already).toBeUndefined();
    const r2 = await alerts.onAlertAck('ack', hash, '@second');
    expect(r2).toMatchObject({ ok: true, already: true, by: '@first' });
    const rows = db.prepare(`SELECT * FROM alert_acks WHERE rule_id = 'server_unreachable' AND dedup_key = 'srv_ACKS4'`).all();
    expect(rows).toHaveLength(1);
    expect(rows[0].until_ts).toBe(Date.now() + 2 * 3600 * 1000);   // TTL 2ч по дефолту
  });

  it('«решено» поверх активного ack → solved-строка, алерт заглушен', async () => {
    const p = { server: 'ACKS5', error: 't' };
    alerts.trigger('server_unreachable', p);
    const hash = alerts._ackHash('server_unreachable', 'srv_ACKS5');
    await alerts.onAlertAck('ack', hash, '@first');
    const r = await alerts.onAlertAck('solved', hash, '@second');
    expect(r.ok).toBe(true);
    alerts.clearCooldown('server_unreachable', p);
    expect(alerts.trigger('server_unreachable', p)).toBe(false);
  });

  it('неизвестный hash (кнопка после рестарта) → stale', async () => {
    const r = await alerts.onAlertAck('ack', 'deadbeefdeadbeef', '@x');
    expect(r).toEqual({ ok: false, error: 'stale' });
  });

  it('ack_ttl_hours=4 → until_ts = now + 4ч', async () => {
    kv.ack_ttl_hours = 4;
    try {
      const p = { server: 'ACKS6', error: 't' };
      alerts.trigger('server_unreachable', p);
      const hash = alerts._ackHash('server_unreachable', 'srv_ACKS6');
      const r = await alerts.onAlertAck('ack', hash, '@t');
      expect(r.ttlHours).toBe(4);
      const row = db.prepare(`SELECT until_ts FROM alert_acks WHERE rule_id = 'server_unreachable' AND dedup_key = 'srv_ACKS6'`).get();
      expect(row.until_ts).toBe(Date.now() + 4 * 3600 * 1000);
    } finally { delete kv.ack_ttl_hours; }
  });
});
