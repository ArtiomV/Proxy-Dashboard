// SSLMonitor (D2, 23.08): суточный контроль SSL-сертификата домена.
// tlsConnect/nowMs инжектируются — сеть не дёргаем.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const sslMod = require('../src/jobs/ssl-monitor.js');

const NOW = Date.parse('2026-08-23T06:00:00.000Z');

function mk({ daysLeft = 30, tlsError = null, enabled = true } = {}) {
  const alertsFired = [];
  const validTo = new Date(NOW + daysLeft * 86400000).toUTCString();
  const job = sslMod.create({
    logger: { info() {}, warn() {}, error() {} },
    alerts: { trigger: (rule, payload) => alertsFired.push({ rule, payload }) },
    getSetting: (k, dflt) => (k === 'ssl_monitor_enabled' ? enabled : dflt),
    nowMs: () => NOW,
    tlsConnect: async () => {
      if (tlsError) throw new Error(tlsError);
      return { valid_to: validTo };
    },
  });
  return { job, alertsFired };
}

describe('ssl-monitor', () => {
  it('cert OK (>14 дней) — без алертов', async () => {
    const { job, alertsFired } = mk({ daysLeft: 30 });
    const res = await job.checkOnce();
    expect(res.ok).toBe(true);
    expect(res.daysLeft).toBe(30);
    expect(alertsFired.length).toBe(0);
  });

  it('≤14 дней → ssl_cert_expiring (important)', async () => {
    const { job, alertsFired } = mk({ daysLeft: 10 });
    await job.checkOnce();
    expect(alertsFired).toEqual([{ rule: 'ssl_cert_expiring', payload: expect.objectContaining({ daysLeft: 10 }) }]);
  });

  it('≤3 дней → ssl_cert_critical', async () => {
    const { job, alertsFired } = mk({ daysLeft: 2 });
    await job.checkOnce();
    expect(alertsFired).toEqual([{ rule: 'ssl_cert_critical', payload: expect.objectContaining({ daysLeft: 2 }) }]);
  });

  it('TLS-ошибка → ssl_cert_critical с текстом ошибки', async () => {
    const { job, alertsFired } = mk({ tlsError: 'handshake failed' });
    const res = await job.checkOnce();
    expect(res.ok).toBe(false);
    expect(alertsFired).toEqual([{ rule: 'ssl_cert_critical', payload: expect.objectContaining({ error: 'handshake failed' }) }]);
  });

  it('выключен настройкой — skip без сети', async () => {
    const { job, alertsFired } = mk({ enabled: false });
    const res = await job.checkOnce();
    expect(res.skipped).toBe(true);
    expect(alertsFired.length).toBe(0);
  });
});
