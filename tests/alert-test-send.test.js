import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const alerts = require('../src/telegram/alerts.js');

let sendMessage, token, settings;

beforeEach(() => {
  sendMessage = vi.fn().mockResolvedValue({ ok: true, result: { message_id: 1 } });
  token = 'test-token';
  settings = {
    telegram_chat_id: '12345',
    // A disabled production rule must still be testable explicitly.
    alert_server_disk_forecast_enabled: false,
  };
  alerts.init({
    logger: { warn() {}, info() {}, error() {} },
    getSetting: (key, fallback) => key === 'telegram_bot_token' ? token : fallback,
    appSettings: settings,
    kvSetCritical: () => ({ ok: true }),
    kvGet: { get: () => undefined },
    db: { prepare: () => ({ run: () => ({ lastInsertRowid: 1 }), get: () => undefined }) },
    tgBot: { sendMessage },
  });
});

describe('manual alert diagnostics', () => {
  const sample = { server: 'S1', free_gb: 18, growth_gb_day: 1.2, days_left: 15, full_date: '07.09.2026' };

  it('sends a preventive rule even when its production toggle is disabled', async () => {
    const first = await alerts.testRule('server_disk_forecast', sample);
    const second = await alerts.testRule('server_disk_forecast', sample);
    expect(first).toMatchObject({ ok: true, channel: 'telegram' });
    expect(second).toMatchObject({ ok: true, channel: 'telegram' });
    expect(sendMessage).toHaveBeenCalledTimes(2); // no boot grace or cooldown for an explicit test
    expect(sendMessage.mock.calls[0][2]).toContain('Диск может заполниться');
  });

  it('reports the exact missing Telegram setting', async () => {
    settings.telegram_chat_id = '';
    expect(await alerts.testRule('server_disk_forecast', sample))
      .toMatchObject({ ok: false, reason: 'telegram_chat_id_missing' });
    settings.telegram_chat_id = '12345';
    token = '';
    expect(await alerts.testRule('server_disk_forecast', sample))
      .toMatchObject({ ok: false, reason: 'telegram_bot_token_missing' });
  });

  it('surfaces a Telegram API rejection instead of claiming it was sent', async () => {
    sendMessage.mockResolvedValueOnce({ ok: false, description: 'Bad Request: chat not found' });
    const result = await alerts.testRule('server_disk_forecast', sample);
    expect(result).toMatchObject({ ok: false, reason: 'telegram_rejected' });
    expect(result.error).toContain('chat not found');
  });
});

// 21.09: proxy_expiring_3d — одно сообщение на клиента со списком всех
// истекающих портов (раньше — по сообщению на порт).
describe('proxy_expiring_3d — групповой рендер по клиенту', () => {
  const grouped = {
    client: 'TestClient', client_id: null, count: 2, daysLeft: 2, validBefore: '2026-05-26',
    ports: [
      { server: 'S1', portId: 'port123', validBefore: '2026-05-26', daysLeft: 2 },
      { server: 'S4', portId: 'port124', validBefore: '2026-05-27', daysLeft: 3 },
    ],
  };

  it('одно сообщение содержит все порты клиента', async () => {
    const res = await alerts.testRule('proxy_expiring_3d', grouped);
    expect(res).toMatchObject({ ok: true });
    const text = sendMessage.mock.calls[0][2];
    expect(text).toContain('У клиента TestClient истекают прокси (2)');
    expect(text).toContain('port123');
    expect(text).toContain('port124');
    expect(text).toContain('2026-05-26');
    expect(text).toContain('2026-05-27');
  });

  it('legacy-форма (одиночный порт) рендерится по-прежнему', async () => {
    const res = await alerts.testRule('proxy_expiring_3d', {
      server: 'S1', portId: 'port123', portName: 'TestClient', client: 'TestClient',
      daysLeft: 2, validBefore: '2026-05-26',
    });
    expect(res).toMatchObject({ ok: true });
    expect(sendMessage.mock.calls[0][2]).toContain('Прокси истекает через 2 д.');
  });
});
