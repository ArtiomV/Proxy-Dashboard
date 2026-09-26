// 2026-09-26 · sim-exhaustion: детектор «у симки кончился пакет» по симптомам.
// SIM OK + ppp_connected + без EXT_IP/IP_RESET + пинг 100% ≥ 15 мин
// непрерывно → sim_package_exhausted. Ротация (краткий IP_RESET) и флапы
// не алертят; возврат IP снимает стейт, новый эпизод алертит заново.

import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const simExhaustion = require('../src/jobs/sim-exhaustion.js');

const MODEM_EX = {   // SIM OK, сессия есть, IP нет, пинг 100%
  modem_details: { IMEI: 'imei1', NICK: 'MD_1' },
  net_details: { SimStatus: 'SIM OK', ConnectionStatus: 'OK, ppp_connected', IS_ONLINE: 'no', EXT_IP: '', ping_stats: '?ms, 100% loss', CELLOP: 'Moldcell' },
};
const MODEM_OK = {
  modem_details: { IMEI: 'imei2', NICK: 'MD_2' },
  net_details: { SimStatus: 'SIM OK', ConnectionStatus: 'OK, ppp_connected', IS_ONLINE: 'yes', EXT_IP: '94.139.1.1', ping_stats: '150ms, 0% loss', CELLOP: 'Moldcell' },
};

function boot(feed, settings = {}) {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE traffic_hourly (server_name TEXT, nick TEXT, hour_start TEXT, bytes_in INTEGER, bytes_out INTEGER)');
  const fired = [];
  const job = simExhaustion.create({
    db, logger: { info() {}, warn() {}, error() {} },
    alerts: { trigger: (rule, payload) => { fired.push({ rule, payload }); return true; } },
    getSetting: (k, d) => (k in settings ? settings[k] : d),
    fetchAllServersDataCached: async () => feed(),
  });
  return { job, fired, db };
}

describe('sim-exhaustion', () => {
  it('симптом ≥15 мин непрерывно → один алерт с контекстом расхода', async () => {
    let feed = () => [{ serverName: 'S1', status: [MODEM_EX, MODEM_OK] }];
    const { job, fired, db } = boot(feed);
    db.prepare("INSERT INTO traffic_hourly VALUES ('S1', 'MD_1', '2026-09-26 08:00', 5e9, 1e9)").run();

    await job.runOnce();   // t0 — стейт создан, алерта ещё нет
    expect(fired.length).toBe(0);
    expect(job._state.size).toBe(1);

    const st = job._state.get('S1|imei1');
    st.since = Date.now() - 16 * 60000;   // 16 мин непрерывно
    await job.runOnce();
    expect(fired.length).toBe(1);
    expect(fired[0].rule).toBe('sim_package_exhausted');
    expect(fired[0].payload).toMatchObject({ nick: 'MD_1', server: 'S1', used_gb: 6 });
    expect(fired[0].payload.mins).toBeGreaterThanOrEqual(15);

    await job.runOnce();   // повтор в том же эпизоде — не алертит (st.alerted)
    expect(fired.length).toBe(1);
  });

  it('краткий симптом (флап/ротация) не алертит', async () => {
    const { job, fired } = boot(() => [{ serverName: 'S1', status: [MODEM_EX] }]);
    await job.runOnce();
    await job.runOnce();
    expect(fired.length).toBe(0);
  });

  it('возврат IP снимает стейт; новый эпизод — новый алерт', async () => {
    let down = true;
    const { job, fired } = boot(() => [{ serverName: 'S1', status: [down ? MODEM_EX : MODEM_OK] }]);
    await job.runOnce();
    job._state.get('S1|imei1').since = Date.now() - 20 * 60000;
    await job.runOnce();
    expect(fired.length).toBe(1);
    down = false;                    // IP вернулся (онлайн)
    await job.runOnce();
    expect(job._state.size).toBe(0); // эпизод закрыт
    down = true;                     // новый эпизод
    await job.runOnce();
    job._state.get('S1|imei1').since = Date.now() - 20 * 60000;
    await job.runOnce();
    expect(fired.length).toBe(2);
  });

  it('устаревший фид (_cached) и ротация (IP_RESET+online) не алертят', async () => {
    const rotating = {
      modem_details: { IMEI: 'imei3', NICK: 'MD_3' },
      net_details: { SimStatus: 'SIM OK', ConnectionStatus: 'OK, ppp_connected', IS_ONLINE: 'no', EXT_IP: 'IP_RESET', ping_stats: '150ms, 0% loss' },
    };
    const { job, fired } = boot(() => [{ serverName: 'S1', _cached: true, status: [MODEM_EX] }, { serverName: 'S1', status: [rotating] }]);
    await job.runOnce();
    job._state.forEach(st => { st.since = 0; });
    await job.runOnce();
    expect(fired.length).toBe(0);
  });
});
