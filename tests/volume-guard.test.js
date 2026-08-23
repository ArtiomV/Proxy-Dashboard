// VolumeGuard (A4, 23.08): объёмные алерты с пакетами операторов.
// Почасовая аномалия (per_sim/shared), темп per_sim (сутки модема) и
// темп shared (среднесуточный MTD по оператору + прогноз дней).
import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const vgMod = require('../src/jobs/volume-guard.js');

let db, alertsFired, settings;

const PKG = JSON.stringify([
  { operator: 'Orange MD',   type: 'per_sim', volume_gb: 400,   hourly_gb: 20, pace_pct: 10 },
  { operator: 'Moldtelecom', type: 'shared',  volume_gb: 30720, hourly_gb: 30, pace_pct: 5 },
]);

function mk(overrides = {}) {
  alertsFired = [];
  settings = {
    volume_enabled: true,
    operator_packages: PKG,
    volume_hourly_default_gb: 30,
    ...overrides,
  };
  return vgMod.create({
    db,
    logger: { info() {}, warn() {}, error() {} },
    alerts: { trigger: (rule, payload) => { alertsFired.push({ rule, payload }); return true; } },
    getSetting: (k, dflt) => (k in settings ? settings[k] : dflt),
  });
}

function addRow(server, nick, operator, hourStart, bytes) {
  db.prepare(`INSERT INTO traffic_hourly (server_name, port_id, nick, operator, client_name, hour_start, bytes_in, bytes_out)
    VALUES (?,?,?,?,?,?,?,0)`)
    .run(server, server + '_p_' + nick + '_' + hourStart.replace(/\D/g, ''), nick, operator, '', hourStart, bytes);
}

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(`CREATE TABLE traffic_hourly (
    id INTEGER PRIMARY KEY AUTOINCREMENT, server_name TEXT, port_id TEXT,
    nick TEXT, operator TEXT, client_name TEXT, hour_start TEXT,
    bytes_in INTEGER DEFAULT 0, bytes_out INTEGER DEFAULT 0
  )`);
});

describe('volume-guard', () => {
  it('модем за час выше порога per_sim → volume_modem_hourly с % пакета', () => {
    addRow('S1', 'MD_01', 'Orange MD', '2026-08-23 05:00', 25 * 1e9);   // 25 ГБ > 20 ГБ
    const job = mk();
    const res = job.runOnce();
    expect(res.hourlyAlerts).toBe(1);
    const a = alertsFired.find(x => x.rule === 'volume_modem_hourly');
    expect(a.payload).toMatchObject({ nick: 'MD_01', operator: 'Orange MD', pct_of_package: 6 });
  });

  it('модем ниже порога — молчим; оператор без пакета — молчим', () => {
    addRow('S1', 'MD_01', 'Orange MD', '2026-08-23 05:00', 5 * 1e9);
    addRow('S1', 'MD_02', 'UnknownOp', '2026-08-23 05:00', 500 * 1e9);
    const job = mk();
    const res = job.runOnce();
    expect(res.hourlyAlerts).toBe(0);
  });

  it('per_sim pace: сутки модема > pace_pct% пакета → volume_package_pace (scope sim)', () => {
    const today = new Date().toISOString().slice(0, 10);
    addRow('S1', 'MD_01', 'Orange MD', today + ' 01:00', 45 * 1e9);   // 45 ГБ > 10% от 400
    addRow('S1', 'MD_01', 'Orange MD', today + ' 02:00', 0);
    const job = mk();
    job.runOnce();
    const a = alertsFired.find(x => x.rule === 'volume_package_pace');
    expect(a).toBeTruthy();
    expect(a.payload.scope).toBe('sim');
    expect(a.payload.gb_day).toBeCloseTo(45, 0);
  });

  it('shared pace: MTD-темп выше pace_pct → прогноз days_left', () => {
    const month = new Date().toISOString().slice(0, 7);
    const day = Number(new Date().toISOString().slice(8, 10));
    // Moldtelecom: 30720 ГБ пакет, 5% = 1536 ГБ/сут. Пишем по 2000 ГБ/день.
    for (let d = 1; d <= day; d++) {
      addRow('S1', 'MDT_' + d, 'Moldtelecom', month + '-' + String(d).padStart(2, '0') + ' 01:00', 2000 * 1e9);
    }
    const job = mk();
    job.runOnce();
    const a = alertsFired.find(x => x.rule === 'volume_package_pace' && x.payload.scope === 'package');
    expect(a).toBeTruthy();
    expect(a.payload.operator).toBe('Moldtelecom');
    expect(a.payload.gb_day).toBeCloseTo(2000, 0);
    expect(a.payload.days_left).toBe(0);   // 2000 ГБ/сут × 23 дня > пакет 30720 — уже исчерпан
  });

  it('выключен настройкой / нет пакетов — skip', () => {
    addRow('S1', 'MD_01', 'Orange MD', '2026-08-23 05:00', 500 * 1e9);
    expect(mk({ volume_enabled: false }).runOnce().skipped).toBe('disabled');
    expect(mk({ operator_packages: '[]' }).runOnce().skipped).toBe('no_packages');
    expect(alertsFired.length).toBe(0);
  });

  it('shared hourly: порог модема из hourly_gb пакета', () => {
    addRow('S1', 'MDT_1', 'Moldtelecom', '2026-08-23 05:00', 35 * 1e9);  // 35 > 30
    const job = mk();
    const res = job.runOnce();
    expect(res.hourlyAlerts).toBe(1);
    expect(alertsFired[0].payload.threshold_gb).toBe(30);
  });
});
