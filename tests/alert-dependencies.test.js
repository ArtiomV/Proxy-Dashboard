// B1 (23.08): зависимости алертов — бокс упал → один алерт про бокс,
// модемные правила его сервера подавляются и считаются; сводка о
// подавленных уходит в сообщении «сервер вернулся».

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const alerts = require('../src/telegram/alerts.js');

let sendMessage;
const appSettings = { telegram_chat_id: '123', alert_dependencies_enabled: true, telegram_night_digest_enabled: false };

beforeAll(() => {
  sendMessage = vi.fn().mockResolvedValue({});
  alerts.init({
    logger: { warn: () => {}, info: () => {}, error: () => {} },
    getSetting: (k, d) => (k === 'telegram_bot_token' ? 'tok' : d),
    appSettings,
    kvSetCritical: () => ({ ok: true }),
    kvGet: { get: () => undefined },
    db: { prepare: () => ({ run: () => ({ lastInsertRowid: 1 }), get: () => undefined }) },
    tgBot: { sendMessage },
  });
  vi.useFakeTimers();
  vi.setSystemTime(Date.now() + 10 * 60 * 1000);   // за пределы boot grace
});

beforeEach(() => { sendMessage.mockClear(); });
afterAll(() => { vi.useRealTimers(); });

describe('B1: зависимости алертов', () => {
  it('бокс упал: модемные алерты его сервера подавляются и считаются', () => {
    expect(alerts.trigger('server_unreachable', { server: 'S9', error: 'timeout' })).toBe(true);
    expect(alerts._boxDownState.has('S9')).toBe(true);

    expect(alerts.trigger('modem_ping_dead', { server: 'S9', nick: 'M1', imei: 'i1', loss: 100 })).toBe(false);
    expect(alerts.trigger('modem_http_fail', { server: 'S9', nick: 'M2', error: 'timeout' })).toBe(false);
    expect(alerts.trigger('modem_offline_20m', { server: 'S9', nick: 'M3', imei: 'i3', mins: 15 })).toBe(false);
    expect(alerts._boxDownState.get('S9').suppressed).toBe(3);
    // Только одно TG-сообщение — про бокс.
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it('модемные алерты ДРУГОГО сервера не подавляются', () => {
    const ok = alerts.trigger('modem_ping_dead', { server: 'S8', nick: 'MX', imei: 'ix', loss: 100 });
    expect(ok).toBe(true);
  });

  it('«сервер вернулся» несёт сводку подавленных и снимает подавление', () => {
    const ok = alerts.trigger('server_recovered', { server: 'S9', downSec: 900 });
    expect(ok).toBe(true);
    expect(alerts._boxDownState.has('S9')).toBe(false);
    const txt = sendMessage.mock.calls.map(c => c[2]).join('\n');
    expect(txt).toContain('подавлено');
    expect(txt).toContain('3');
    // После восстановления модемные алерты снова проходят.
    expect(alerts.trigger('modem_ping_dead', { server: 'S9', nick: 'M1', imei: 'i1', loss: 100 })).toBe(true);
  });

  it('тумблер alert_dependencies_enabled=false выключает подавление', () => {
    appSettings.alert_dependencies_enabled = false;
    alerts.trigger('server_unreachable', { server: 'S7', error: 'timeout' });
    expect(alerts._boxDownState.has('S7')).toBe(false);
    expect(alerts.trigger('modem_ping_dead', { server: 'S7', nick: 'M7', imei: 'i7', loss: 100 })).toBe(true);
    appSettings.alert_dependencies_enabled = true;
  });
});
