// 2026-09-27: персистентность алерт-кулдаунов через рестарт.
// Инцидент: sim_package_exhausted пришёл в 11:54 и снова в 12:16 после
// деплоя — кулдауны писались в kv_store debounce-таймером (5 сек) и терялись
// в окне перед SIGTERM, а восстановление в init() молча не работало, т.к.
// прод передаёт kvGet ФУНКЦИЕЙ (k) => row (src/boot/startup.js), а init звал
// kvGet.get(key) → TypeError проглатывался best-effort catch.
//   - flushCooldowns() пишет в kv_store синхронно (без ожидания debounce);
//   - после flush + новой инициализации кулдаун действует (алерт подавляется);
//   - восстановление принимает обе формы kvGet (функция и statement {get});
//   - debounce-таймер _persistCooldowns сохранён (пишет сам через 5 сек);
//   - gracefulShutdown в server.js вызывает alerts.flushCooldowns().

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

// Свежий инстанс модуля = «новый процесс»: cooldownState/_bootAt сбрасываются.
function loadAlerts() {
  delete require.cache[require.resolve('../src/telegram/alerts.js')];
  return require('../src/telegram/alerts.js');
}

const PAYLOAD = { server: 'SFLUSH', nick: 'M-flush', imei: 'i-flush', mins: 30, operator: 'MTS' };
const COOLDOWN_KV_KEY = 'telegram_alert_cooldowns';

let db, kvStore, sendMessage;

function makeDeps(alerts) {
  return {
    logger: { warn() {}, info() {}, error() {}, debug() {} },
    getSetting: (k, d) => (k === 'telegram_bot_token' ? 'tok' : d),
    appSettings: { telegram_chat_id: '123', alert_incident_correlation_enabled: false, telegram_night_digest_enabled: false },
    kvSetCritical: (k, v) => { kvStore[k] = v; return { ok: true }; },
    // Продовая форма (src/boot/startup.js): функция (k) => row.
    kvGet: (k) => (k in kvStore ? { value: kvStore[k] } : undefined),
    db,
    tgBot: { sendMessage, tgRequest: vi.fn().mockResolvedValue({ ok: true, result: {} }) },
  };
}

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(fs.readFileSync(path.join(__dirname, '..', 'migrations', '032_notifications.sql'), 'utf8'));
  kvStore = {};
  sendMessage = vi.fn().mockResolvedValue({ ok: true, result: { message_id: 1 } });
  vi.useFakeTimers();
});

afterEach(() => { vi.useRealTimers(); db.close(); });

describe('Персистентность алерт-кулдаунов через рестарт', () => {
  it('flush + новая инициализация: кулдаун действует, алерт подавляется', () => {
    const alerts1 = loadAlerts();
    alerts1.init(makeDeps(alerts1));
    vi.setSystemTime(Date.now() + 10 * 60 * 1000);   // за пределы boot grace

    expect(alerts1.trigger('sim_package_exhausted', PAYLOAD)).toBe(true);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    // Debounce (5 сек) ещё не отработал — в kv пусто.
    expect(kvStore[COOLDOWN_KV_KEY]).toBeUndefined();

    // Shutdown-путь: синхронный flush не дожидаясь debounce-таймера.
    alerts1.flushCooldowns();
    expect(kvStore[COOLDOWN_KV_KEY]).toBeTruthy();
    const saved = JSON.parse(kvStore[COOLDOWN_KV_KEY]);
    expect(saved['sim_package_exhausted|simex_SFLUSH_M-flush']).toBeGreaterThan(0);

    // «Новый процесс»: свежий модуль, тот же kv_store.
    const sendMessage2 = vi.fn().mockResolvedValue({ ok: true, result: { message_id: 2 } });
    sendMessage = sendMessage2;
    const alerts2 = loadAlerts();
    alerts2.init(makeDeps(alerts2));
    vi.setSystemTime(Date.now() + 10 * 60 * 1000);   // boot grace 2-го процесса; кулдаун 12ч жив

    expect(alerts2.trigger('sim_package_exhausted', PAYLOAD)).toBe(false);
    expect(sendMessage2).not.toHaveBeenCalled();
  });

  it('восстановление принимает kvGet-statement ({ get(k) }), не только функцию', () => {
    kvStore[COOLDOWN_KV_KEY] = JSON.stringify({ 'sim_package_exhausted|simex_SFLUSH_M-flush': Date.now() });
    const alerts = loadAlerts();
    const deps = makeDeps(alerts);
    deps.kvGet = { get: (k) => (k in kvStore ? { value: kvStore[k] } : undefined) };
    alerts.init(deps);
    vi.setSystemTime(Date.now() + 10 * 60 * 1000);

    expect(alerts.trigger('sim_package_exhausted', PAYLOAD)).toBe(false);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('debounce-таймер сохранён: без flush пишет сам через 5 сек', () => {
    const alerts = loadAlerts();
    alerts.init(makeDeps(alerts));
    vi.setSystemTime(Date.now() + 10 * 60 * 1000);

    expect(alerts.trigger('sim_package_exhausted', PAYLOAD)).toBe(true);
    expect(kvStore[COOLDOWN_KV_KEY]).toBeUndefined();   // не пишем на каждый send

    vi.advanceTimersByTime(5000);
    expect(kvStore[COOLDOWN_KV_KEY]).toBeTruthy();
  });

  it('flush отменяет pending debounce — двойной записи нет', () => {
    const alerts = loadAlerts();
    const deps = makeDeps(alerts);
    const writes = [];
    deps.kvSetCritical = (k, v) => { writes.push([k, v]); return { ok: true }; };
    alerts.init(deps);
    vi.setSystemTime(Date.now() + 10 * 60 * 1000);

    alerts.trigger('sim_package_exhausted', PAYLOAD);
    alerts.flushCooldowns();
    vi.advanceTimersByTime(10000);
    expect(writes.filter(([k]) => k === COOLDOWN_KV_KEY)).toHaveLength(1);
  });

  it('gracefulShutdown в server.js вызывает alerts.flushCooldowns()', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    const body = src.slice(src.indexOf('function gracefulShutdown'), src.indexOf("process.on('SIGTERM'"));
    expect(body).toContain('alerts.flushCooldowns()');
  });
});
