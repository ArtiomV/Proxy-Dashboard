// ModemPing (A1, 23.08): парсинг ping_stats, свежесть, стрики алертов
// (dead/slow/recovered) и влияние alive() на аптайм.
import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const pingMod = require('../src/jobs/modem-ping.js');

let db, alertsFired, settings;
const NOW = Date.parse('2026-08-23T06:00:00.000Z');

function mk(overrides = {}) {
  alertsFired = [];
  settings = {
    ping_enabled: true,
    ping_loss_dead_pct: 100,
    ping_loss_warn_pct: 30,
    ping_latency_warn_ms: 800,
    ping_stale_cycles: 5,
    ...overrides,
  };
  return pingMod.create({
    db,
    logger: { info() {}, warn() {}, error() {} },
    alerts: { trigger: (rule, payload) => alertsFired.push({ rule, payload }) },
    getSetting: (k, dflt) => (k in settings ? settings[k] : dflt),
  });
}

function statusEntry(imei, nick, pingStats, online = 'yes') {
  return {
    modem_details: { IMEI: imei, NICK: nick },
    net_details: { IS_ONLINE: online, ping_stats: pingStats },
  };
}

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(`CREATE TABLE modem_ping (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL, server TEXT NOT NULL, nick TEXT NOT NULL,
    latency_ms INTEGER, loss_pct INTEGER, ok INTEGER
  )`);
});

describe('parsePingStats', () => {
  it('parses "183ms, 0% loss"', () => {
    const job = mk();
    expect(job.parsePingStats('183ms, 0% loss')).toEqual({ latency_ms: 183, loss_pct: 0 });
    expect(job.parsePingStats('1521ms, 100% loss')).toEqual({ latency_ms: 1521, loss_pct: 100 });
  });
  it('returns null for garbage', () => {
    const job = mk();
    expect(job.parsePingStats(undefined)).toBeNull();
    expect(job.parsePingStats('no data')).toBeNull();
    expect(job.parsePingStats(42)).toBeNull();
  });
});

describe('ingest + alive', () => {
  it('writes history rows and reports alive=true on good ping', () => {
    const job = mk();
    job.ingest('S1', [statusEntry('imei1', 'MD2_39', '183ms, 0% loss')], NOW);
    const rows = db.prepare('SELECT * FROM modem_ping').all();
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({ server: 'S1', nick: 'MD2_39', latency_ms: 183, loss_pct: 0, ok: 1 });
    expect(job.alive('S1', 'imei1')).toBe(true);
  });

  it('alive=false when loss >= dead pct (fresh data)', () => {
    const job = mk();
    job.ingest('S1', [statusEntry('imei1', 'MD2_39', '900ms, 100% loss')], NOW);
    expect(job.alive('S1', 'imei1')).toBe(false);
  });

  it('alive=null when ping feature disabled', () => {
    const job = mk({ ping_enabled: false });
    job.ingest('S1', [statusEntry('imei1', 'MD2_39', '183ms, 0% loss')], NOW);
    expect(job.alive('S1', 'imei1')).toBeNull();
  });

  it('alive=null when data went stale (unchanged N cycles)', () => {
    const job = mk({ ping_stale_cycles: 3 });
    for (let i = 0; i < 4; i++) job.ingest('S1', [statusEntry('imei1', 'M', '900ms, 100% loss')], NOW + i * 60000);
    expect(job.alive('S1', 'imei1')).toBeNull();
    expect(job.latest()['S1_M'].fresh).toBe(false);
  });

  it('skips entries without IMEI', () => {
    const job = mk();
    job.ingest('S1', [{ modem_details: {}, net_details: { ping_stats: '1ms, 0% loss' } }], NOW);
    expect(db.prepare('SELECT COUNT(*) c FROM modem_ping').get().c).toBe(0);
  });
});

describe('alerts', () => {
  it('modem_ping_dead after 2 consecutive 100% loss polls (online), recovered after', () => {
    const job = mk();
    job.ingest('S1', [statusEntry('i1', 'M', '900ms, 100% loss')], NOW);
    expect(alertsFired.length).toBe(0); // первый опрос — только стрик
    job.ingest('S1', [statusEntry('i1', 'M', '900ms, 100% loss')], NOW + 60000);
    expect(alertsFired).toEqual([{ rule: 'modem_ping_dead', payload: expect.objectContaining({ server: 'S1', nick: 'M', loss: 100 }) }]);
    job.ingest('S1', [statusEntry('i1', 'M', '900ms, 100% loss')], NOW + 120000);
    expect(alertsFired.length).toBe(1); // не дублируется, пока не вышли из dead
    job.ingest('S1', [statusEntry('i1', 'M', '200ms, 0% loss')], NOW + 180000);
    expect(alertsFired[1].rule).toBe('modem_ping_recovered');
  });

  it('no dead alert when modem offline (territory of modem_offline)', () => {
    const job = mk();
    job.ingest('S1', [statusEntry('i1', 'M', '900ms, 100% loss', 'no')], NOW);
    job.ingest('S1', [statusEntry('i1', 'M', '900ms, 100% loss', 'no')], NOW + 60000);
    expect(alertsFired.length).toBe(0);
  });

  it('modem_ping_slow after 3 high-latency polls', () => {
    const job = mk();
    for (let i = 0; i < 3; i++) job.ingest('S1', [statusEntry('i1', 'M', '1500ms, 10% loss')], NOW + i * 60000);
    expect(alertsFired).toEqual([{ rule: 'modem_ping_slow', payload: expect.objectContaining({ latency: 1500 }) }]);
  });
});
