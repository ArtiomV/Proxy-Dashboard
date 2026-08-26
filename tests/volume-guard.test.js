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
  { operator: 'Digi',        type: 'unlimited', volume_gb: 0,   hourly_gb: 30, pace_pct: 0 },
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
  it('buildForecasts: per-SIM and shared packages get explicit days/date forecasts', () => {
    for (let d = 1; d <= 10; d++) {
      const day = String(d).padStart(2, '0');
      addRow('S1', 'MD_01', 'Orange MD', '2026-08-' + day + ' 01:00', 10 * 1e9);
      addRow('S1', 'MDT_01', 'Moldtelecom', '2026-08-' + day + ' 02:00', 90 * 1e9);
    }
    const forecasts = vgMod.buildForecasts(db, JSON.parse(PKG), new Date('2026-08-10T12:00:00.000Z'));
    const sim = forecasts.find(f => f.scope === 'sim' && f.nick === 'MD_01');
    expect(sim).toMatchObject({ used_gb: 100, gb_day: 10, days_left: 30, full_date: '2026-09-09' });
    const shared = forecasts.find(f => f.scope === 'package' && f.operator === 'Moldtelecom');
    expect(shared.used_gb).toBe(900);
    expect(shared.days_left).toBeGreaterThan(300);
    const unlimited = forecasts.find(f => f.operator === 'Digi');
    expect(unlimited.status).toBe('unlimited');
    expect(unlimited.days_left).toBeUndefined();
  });

  it('shared forecast scales capacity by the number of required bundles', () => {
    for (let d = 1; d <= 10; d++) {
      const day = String(d).padStart(2, '0');
      addRow('S1', 'M_1', 'Moldcell', '2026-08-' + day + ' 01:00', 3 * 1e9);
      addRow('S1', 'M_2', 'Moldcell', '2026-08-' + day + ' 02:00', 3 * 1e9);
      addRow('S1', 'M_3', 'Moldcell', '2026-08-' + day + ' 03:00', 3 * 1e9);
    }
    const forecasts = vgMod.buildForecasts(db, [
      { operator: 'Moldcell', type: 'shared', volume_gb: 100, max_sims: 2 },
    ], new Date('2026-08-10T12:00:00.000Z'));
    expect(forecasts[0]).toMatchObject({
      scope: 'package', modems: 3, max_sims: 2, bundle_count: 2,
      package_gb: 200, used_gb: 90,
    });
  });

  it('shared package with no active SIM is not marked as exhausted', () => {
    const forecasts = vgMod.buildForecasts(db, [
      { operator: 'Moldcell', type: 'shared', volume_gb: 100, max_sims: 10 },
    ], new Date('2026-08-10T12:00:00.000Z'));
    expect(forecasts[0]).toMatchObject({
      status: 'no_usage', modems: 0, bundle_count: 0, package_gb: 0, days_left: null,
    });
  });

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

  it('renewal_day: период считается от даты обновления тарифа, а не от 1-го числа', () => {
    // Расход в прошлом биллинговом периоде (до обновления 20-го) не должен
    // попадать в остаток текущего периода.
    for (let d = 1; d <= 19; d++) {
      addRow('S1', 'MDT_1', 'Moldtelecom', '2026-08-' + String(d).padStart(2, '0') + ' 01:00', 100 * 1e9);
    }
    for (let d = 20; d <= 25; d++) {
      addRow('S1', 'MDT_1', 'Moldtelecom', '2026-08-' + String(d).padStart(2, '0') + ' 01:00', 10 * 1e9);
    }
    const forecasts = vgMod.buildForecasts(db, [
      { operator: 'Moldtelecom', type: 'shared', volume_gb: 1000, renewal_day: 20 },
    ], new Date('2026-08-25T12:00:00.000Z'));
    expect(forecasts[0]).toMatchObject({
      used_gb: 60,                    // только 20–25 августа, не 1900 ГБ с начала месяца
      period_start: '2026-08-20',
      reset_date: '2026-09-20',
    });
    // Без renewal_day — старое поведение: календарный месяц
    const legacy = vgMod.buildForecasts(db, [
      { operator: 'Moldtelecom', type: 'shared', volume_gb: 100000 },
    ], new Date('2026-08-25T12:00:00.000Z'));
    expect(legacy[0]).toMatchObject({ used_gb: 1960, period_start: '2026-08-01', reset_date: '2026-09-01' });
  });

  it('packagePeriod: дата обновления в будущем месяце и 31-е в коротком месяце', () => {
    const p = vgMod.packagePeriod({ renewal_day: 5 }, new Date('2026-08-03T12:00:00.000Z'));
    expect(p.start.toISOString().slice(0, 10)).toBe('2026-07-05');
    expect(p.reset.toISOString().slice(0, 10)).toBe('2026-08-05');
    const feb = vgMod.packagePeriod({ renewal_day: 31 }, new Date('2026-03-10T12:00:00.000Z'));
    expect(feb.start.toISOString().slice(0, 10)).toBe('2026-02-28');
    expect(feb.reset.toISOString().slice(0, 10)).toBe('2026-03-31');
  });

  it('эффективность: считает сгоревший трафик и его стоимость за прошлый период', () => {
    db.exec(`CREATE TABLE modem_meta (
      server_name TEXT, nick TEXT, imei TEXT, iccid TEXT, operator TEXT, deleted INTEGER DEFAULT 0
    )`);
    db.prepare("INSERT INTO modem_meta VALUES ('S1','A','1','sim-a','Orange MD',0)").run();
    db.prepare("INSERT INTO modem_meta VALUES ('S1','B','2','sim-b','Orange MD',0)").run();
    // На 10 августа завершённый период — июль. Две SIM по 100 ГБ = 200 ГБ,
    // использовано 50 ГБ, значит 75% пакета и оплаты не использованы.
    addRow('S1', 'A', 'Orange MD', '2026-07-05 01:00', 30 * 1e9);
    addRow('S1', 'B', 'Orange MD', '2026-07-06 01:00', 20 * 1e9);
    const rows = vgMod.buildPackageEfficiency(db, [
      { operator: 'Orange MD', type: 'per_sim', volume_gb: 100, price: 40, currency: 'MDL' },
    ], new Date('2026-08-10T12:00:00.000Z'));
    expect(rows[0]).toMatchObject({
      period_start: '2026-07-01', period_end: '2026-08-01', sim_count: 2,
      bundle_count: 2, purchased_gb: 200, used_gb: 50, unused_gb: 150,
      utilization_pct: 25, monthly_cost: 80, wasted_cost: 60,
      currency: 'MDL', status: 'underused',
    });
  });

  it('shared pace: расход до даты обновления не учитывается в темпе', () => {
    const today = new Date();
    const dayOfMonth = Number(today.toISOString().slice(8, 10));
    if (dayOfMonth < 3) return; // в первые дни месяца кейс вырождается
    const month = today.toISOString().slice(0, 7);
    // Обновление вчера: старые 2000 ГБ/день с 1-го числа не должны давать алерт темпа.
    const renewal = dayOfMonth - 1;
    for (let d = 1; d < renewal; d++) {
      addRow('S1', 'MDT_' + d, 'Moldtelecom', month + '-' + String(d).padStart(2, '0') + ' 01:00', 2000 * 1e9);
    }
    const job = mk({
      operator_packages: JSON.stringify([
        { operator: 'Moldtelecom', type: 'shared', volume_gb: 30720, pace_pct: 5, renewal_day: renewal },
      ]),
    });
    job.runOnce();
    expect(alertsFired.filter(x => x.rule === 'volume_package_pace' && x.payload.scope === 'package')).toEqual([]);
  });

  it('безлимит: почасовая аномалия работает, алерт темпа не создаётся', () => {
    const today = new Date().toISOString().slice(0, 10);
    addRow('S1', 'DIGI_1', 'Digi', today + ' 01:00', 35 * 1e9);
    const job = mk();
    const res = job.runOnce();
    expect(res.hourlyAlerts).toBe(1);
    expect(res.paceAlerts).toBe(0);
    expect(alertsFired).toHaveLength(1);
    expect(alertsFired[0]).toMatchObject({
      rule: 'volume_modem_hourly',
      payload: { operator: 'Digi', pct_of_package: null, threshold_gb: 30 },
    });
  });
});
