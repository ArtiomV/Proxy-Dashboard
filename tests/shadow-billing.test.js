// Фаза 0 (§2 ТЗ): теневой тест тарификации. Локируем контракт:
// V1 = max(durable, live) × price; V2 = durable × price с фолбэком на live
// при hours_present < 20; запись идемпотентна по (date, client_id);
// per_modem / billingPaused / без цены — исключены; деньги не двигаются.

import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const trafficDb = require('../src/db/traffic.js');
const { trafficBytesToGb } = require('../src/utils/traffic.js');
const { create } = require('../src/jobs/shadow-billing.js');

const YESTERDAY = '2026-08-09'; // МСК-дата «вчера» = UTC 2026-08-08 21:00 → 2026-08-09 20:00

function mkDb() {
  const db = new Database(':memory:');
  // Как в проде: базовая схема + весь каталог миграций боевым раннером
  // (заодно проверяет, что 054 применяется без ошибок).
  db.exec(fs.readFileSync(path.join(__dirname, '..', 'schema.sql'), 'utf8'));
  // sha256hex нужна миграции 043 — регистрируется так же, как в server.js
  db.function('sha256hex', { deterministic: true }, require('../src/utils/secrets').sha256hex);
  require('../src/db/migrations.js').runMigrations(db, {
    migrationsDir: path.join(__dirname, '..', 'migrations'),
    logger: silentLogger,
  });
  trafficDb.init(db);
  return db;
}

// n почасовых строк по bytesEach байт за МСК-дату YESTERDAY (UTC-сдвиг +3)
function seedHourly(db, clientName, n, bytesEach, uncertainCount = 0) {
  const stmt = db.prepare(`INSERT INTO traffic_hourly
    (server_name, port_id, nick, operator, client_name, hour_start, bytes_in, bytes_out, uncertain)
    VALUES ('S1', ?, '', '', ?, ?, ?, 0, ?)`);
  const base = Date.UTC(2026, 7, 8, 21); // вчера 00:00 МСК
  for (let i = 0; i < n; i++) {
    const hourStart = new Date(base + i * 3600000).toISOString().slice(0, 19).replace('T', ' ');
    stmt.run(`p_${clientName}`, clientName, hourStart, bytesEach, i < uncertainCount ? 1 : 0);
  }
}

const silentLogger = { info() {}, warn() {}, error() {} };

let db, logRows, sent;
function mkJob(overrides = {}) {
  logRows = [];
  sent = [];
  const clients = overrides.clients || [
    { id: 'c1', name: 'Client A', portName: 'clientA', price: 250, currency: 'RUB', billingType: 'per_gb' },
  ];
  const base = {
    db, logger: silentLogger,
    logActivity: (...a) => logRows.push(a),
    fetchAllServersData: async () => [{
      serverName: 'S1',
      bw: { p1: { portName: 'clientA', bandwidth_bytes_yesterday_in: '3000000000', bandwidth_bytes_yesterday_out: '0' } },
    }],
    getMoscowYesterday: () => YESTERDAY,
    getMoscowNow: () => new Date('2026-08-10T09:00:00'), // понедельник
    trafficDb,
    // Зеркалит продовый durable-путь server.js (hourly-first); фолбэк не нужен
    getClientBytesForMskDate: (portName, date) =>
      trafficDb.hourlyByClientDateStmt().get(portName, date).bytes || 0,
    computeClientYesterdayBytes: (results, portName) => {
      let total = 0;
      for (const data of results) {
        for (const b of Object.values(data.bw || {})) {
          if (b.portName === portName) {
            total += Number(b.bandwidth_bytes_yesterday_in) + Number(b.bandwidth_bytes_yesterday_out);
          }
        }
      }
      return total;
    },
    trafficBytesToGb,
    clients,
    appSettings: { telegram_bot_token: 'tok', telegram_chat_id: 'chat' },
    tgBot: { sendMessage: async (token, chatId, text) => { sent.push({ token, chatId, text }); return { ok: true }; } },
  };
  return create(Object.assign(base, overrides));
}

function shadowRows() {
  return db.prepare('SELECT * FROM billing_shadow_log ORDER BY client_id').all();
}

describe('shadow-billing job (Фаза 0)', () => {
  beforeEach(() => { db = mkDb(); });

  it('полное покрытие (24ч): V1 = max(durable, live), V2 = durable, fallback = 0', async () => {
    seedHourly(db, 'clientA', 24, 1e8, 2);   // 2.4 GB durable, 0.2 GB uncertain
    await mkJob().runShadowBilling();
    const rows = shadowRows();
    expect(rows.length).toBe(1);
    const r = rows[0];
    expect(r.date).toBe(YESTERDAY);
    expect(r.client_id).toBe('c1');
    expect(r.hours_present).toBe(24);
    expect(r.gb_durable).toBeCloseTo(2.4, 3);
    expect(r.gb_uncertain).toBeCloseTo(0.2, 3);
    expect(r.gb_live).toBeCloseTo(3, 3);
    expect(r.gb_v1).toBeCloseTo(3, 3);          // max(2.4, 3)
    expect(r.rub_v1).toBeCloseTo(750, 2);       // 3 × 250
    expect(r.gb_v2).toBeCloseTo(2.4, 3);        // канон — durable
    expect(r.rub_v2).toBeCloseTo(600, 2);       // 2.4 × 250
    expect(r.fallback_used).toBe(0);
  });

  it('дыра в durable (hours < 20): V2 уходит на live, fallback_used = 1', async () => {
    seedHourly(db, 'clientA', 10, 1e8);       // 1.0 GB durable, 10 часов
    await mkJob().runShadowBilling();
    const r = shadowRows()[0];
    expect(r.hours_present).toBe(10);
    expect(r.gb_v1).toBeCloseTo(3, 3);
    expect(r.gb_v2).toBeCloseTo(3, 3);        // fallback на live
    expect(r.rub_v2).toBeCloseTo(750, 2);
    expect(r.fallback_used).toBe(1);
  });

  it('gb_durable берётся боевым durable-путём (включая фолбэк за пределы traffic_hourly)', async () => {
    seedHourly(db, 'clientA', 24, 1e8);       // 2.4 GB в traffic_hourly
    // боевой путь вернул больше (фолбэк daily_traffic при дырах в hourly)
    await mkJob({ getClientBytesForMskDate: () => 5e9 }).runShadowBilling();
    const r = shadowRows()[0];
    expect(r.gb_durable).toBeCloseTo(5, 3);
    expect(r.hours_present).toBe(24);          // покрытие — только по traffic_hourly
    expect(r.gb_v1).toBeCloseTo(5, 3);
    expect(r.gb_v2).toBeCloseTo(5, 3);
  });

  it('идемпотентность: повторный прогон за ту же дату обновляет строку, не дублирует', async () => {
    seedHourly(db, 'clientA', 24, 1e8);
    const job = mkJob();
    await job.runShadowBilling();
    await job.runShadowBilling();
    expect(shadowRows().length).toBe(1);
    // «завтрашний» прогон с другими live-данными перезаписывает ту же строку
    await mkJob({ fetchAllServersData: async () => [{
      serverName: 'S1',
      bw: { p1: { portName: 'clientA', bandwidth_bytes_yesterday_in: '4000000000', bandwidth_bytes_yesterday_out: '0' } },
    }] }).runShadowBilling();
    const rows = shadowRows();
    expect(rows.length).toBe(1);
    expect(rows[0].gb_live).toBeCloseTo(4, 3);
    expect(rows[0].rub_v1).toBeCloseTo(1000, 2);
  });

  it('исключения: per_modem, billingPaused, без цены, без portName — без строк; дефолт = per_gb', async () => {
    seedHourly(db, 'clientA', 24, 1e8);
    const clients = [
      { id: 'c1', name: 'A', portName: 'clientA', price: 250, billingType: 'per_gb' },
      { id: 'c2', name: 'B', portName: 'clientB', price: 5000, billingType: 'per_modem' },
      { id: 'c3', name: 'C', portName: 'clientC', price: 250, billingType: 'per_gb', billingPaused: true },
      { id: 'c4', name: 'D', portName: 'clientD', price: 0, billingType: 'per_gb' },
      { id: 'c5', name: 'E', portName: '', price: 250, billingType: 'per_gb' },
      { id: 'c6', name: 'F', portName: 'clientF', price: 250 }, // billingType не задан → per_gb
    ];
    const res = await mkJob({ clients }).runShadowBilling();
    const ids = shadowRows().map(r => r.client_id);
    expect(ids).toEqual(['c1', 'c6']);
    expect(res.written).toBe(2);
    expect(res.skipped).toBe(4);
  });

  it('нулевой трафик — строка всё равно пишется (нулевые gb/rub)', async () => {
    await mkJob({ fetchAllServersData: async () => [] }).runShadowBilling();
    const r = shadowRows()[0];
    expect(r.gb_v1).toBe(0);
    expect(r.rub_v1).toBe(0);
    expect(r.fallback_used).toBe(1);           // hours_present = 0 < 20
  });

  describe('еженедельный отчёт', () => {
    function seedWeek() {
      const ins = db.prepare(`INSERT INTO billing_shadow_log
        (date, client_id, hours_present, gb_durable, gb_uncertain, gb_live, gb_v1, rub_v1, gb_v2, rub_v2, fallback_used)
        VALUES (?, ?, 24, 1, 0.1, 1, ?, ?, ?, ?, ?)`);
      // 6 дней внутри окна 2026-08-03..2026-08-10 + 1 день за окном
      for (let d = 4; d <= 9; d++) {
        ins.run(`2026-08-0${d}`, 'c1', 2, 500, 1.8, 450, d === 5 ? 1 : 0);
        ins.run(`2026-08-0${d}`, 'c2', 1, 250, 1, 250, 0);
      }
      ins.run('2026-08-01', 'c1', 9, 9999, 9, 9999, 0); // за пределами 7 дней
    }

    it('понедельник: сводка за 7 дней уходит в TG с итогами и топом расхождений', async () => {
      seedWeek();
      const res = await mkJob().runShadowBillingWeekly();
      expect(res.sent).toBe(true);
      expect(res.week_v1).toBe(4500);          // 6×(500+250)
      expect(res.week_v2).toBe(4200);          // 6×(450+250)
      // Δ% = Σ|diff| / Σv1 = 6×(50+0)/4500 ≈ 6.67%
      expect(res.diff_pct).toBeCloseTo(6.67, 2);
      expect(sent.length).toBe(1);
      const t = sent[0].text;
      expect(t).toContain('4500 ₽');
      expect(t).toContain('4200 ₽');
      expect(t).toContain('Fallback-срабатываний (hours<20): 1');
      expect(t).toContain('Топ расхождений');
    });

    it('не понедельник: пропуск без отправки', async () => {
      seedWeek();
      const res = await mkJob({ getMoscowNow: () => new Date('2026-08-11T09:00:00') }).runShadowBillingWeekly();
      expect(res.skipped).toBe('not_monday');
      expect(sent.length).toBe(0);
    });

    it('нет данных за 7 дней: пропуск без отправки', async () => {
      const res = await mkJob().runShadowBillingWeekly();
      expect(res.skipped).toBe('no_data');
      expect(sent.length).toBe(0);
    });
  });
});
