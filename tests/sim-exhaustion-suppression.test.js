// 2026-09-26: пока модем в состоянии «пакет исчерпан» (sim_exhaustion_state,
// миграция 104), alerts.js подавляет правила его нестабильности
// (EXHAUST_SUPPRESSED_RULES) — и в _triggerNow, и в pre-check trigger().
// SIM-проблемы другого рода (redirect) и само sim_package_exhausted/recovered
// НЕ подавляются. После удаления строки (восстановление) алерты идут снова.

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const alerts = require('../src/telegram/alerts.js');

let db, sendMessage;
const appSettings = { telegram_chat_id: '123', alert_incident_correlation_enabled: false, telegram_night_digest_enabled: false };
const kv = { telegram_bot_token: 'tok', alert_incident_correlation_enabled: false };

const mig = (f) => fs.readFileSync(path.join(__dirname, '..', 'migrations', f), 'utf8');

beforeAll(() => {
  db = new Database(':memory:');
  db.exec(mig('032_notifications.sql'));
  db.exec('CREATE TABLE server_downtime (id INTEGER PRIMARY KEY, server_name TEXT, down_from TEXT, down_to TEXT)');
  db.exec(mig('076_monitoring_v2_stage4.sql'));
  db.exec(mig('103_alert_acks_closed_at.sql'));
  db.exec(mig('104_sim_exhaustion_state.sql'));
  sendMessage = vi.fn().mockResolvedValue({ ok: true, result: { message_id: 1 } });
  alerts.init({
    logger: { warn() {}, info() {}, error() {}, debug() {} },
    getSetting: (k, d) => (k in kv ? kv[k] : d),
    appSettings,
    kvSetCritical: () => ({ ok: true }),
    kvGet: { get: () => undefined },
    db,
    tgBot: { sendMessage, tgRequest: vi.fn().mockResolvedValue({ ok: true, result: {} }) },
  });
  vi.useFakeTimers();
  vi.setSystemTime(Date.now() + 10 * 60 * 1000);   // за пределы boot grace
});
afterAll(() => { vi.useRealTimers(); db.close(); });

function setExhausted(on) {
  db.prepare('DELETE FROM sim_exhaustion_state').run();
  if (on) db.prepare("INSERT INTO sim_exhaustion_state (server_name, imei, nick, operator, since_ts, alerted_at) VALUES ('S1', 'imeiX', 'MD_X', 'Moldcell', 1, 2)").run();
}

describe('подавление нестабильности модема с исчерпанным пакетом', () => {
  it('modem_offline_20m / modem_ping_dead молчат по exhausted-модему — ни TG, ни bell', () => {
    setExhausted(true);
    expect(alerts.trigger('modem_offline_20m', { server: 'S1', nick: 'MD_X', imei: 'imeiX', mins: 30 })).toBe(false);
    expect(alerts.trigger('modem_ping_dead', { server: 'S1', nick: 'MD_X', imei: 'imeiX' })).toBe(false);
    expect(sendMessage).not.toHaveBeenCalled();
    const bell = db.prepare("SELECT COUNT(*) c FROM notifications WHERE rule_id IN ('modem_offline_20m','modem_ping_dead')").get().c;
    expect(bell).toBe(0);
  });

  it('матч по imei работает и с чужого server (модем переехал), другие модемы не задеты', () => {
    setExhausted(true);
    expect(alerts.trigger('modem_offline_20m', { server: 'S4', nick: 'MD_X', imei: 'imeiX', mins: 30 })).toBe(false);
    // Другой модем того же сервера — обычный путь (true = принят к отправке).
    expect(alerts.trigger('modem_offline_20m', { server: 'S1', nick: 'MD_Y', imei: 'imeiY', mins: 30 })).toBe(true);
  });

  it('SIM-проблемы другого рода (sim_redirect_imposed) НЕ подавляются', () => {
    setExhausted(true);
    expect(alerts.trigger('sim_redirect_imposed', { server: 'S1', nick: 'MD_X', imei: 'imeiX' })).toBe(true);
  });

  it('после удаления состояния (пакет восстановлен) алерты идут снова', () => {
    setExhausted(false);
    expect(alerts.trigger('modem_ping_dead', { server: 'S1', nick: 'MD_X', imei: 'imeiX' })).toBe(true);
  });
});
