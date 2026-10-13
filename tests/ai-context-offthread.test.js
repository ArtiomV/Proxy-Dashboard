// 2026-10-13: контекст ИИ-анализа собирается в worker-потоке (запросы по
// миллионам строк пингов блокировали дашборд ~4 с на каждой утренней
// сводке), а «сбой пинга» = потери ≥ ping_loss_warn_pct: ok=0 в modem_ping
// не бывает (пишется только при 100% потерь), и анализ всегда видел 0%.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const ai = require('../src/telegram/ai_insights.js');
const state = require('../src/state');

let dir, db;
const DATE = '2026-10-12';   // МСК-сутки = UTC [10-11 21:00, 10-12 21:00)

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aictx-'));
  db = new Database(path.join(dir, 'd.db'));
  db.exec(`
    CREATE TABLE modem_ping (id INTEGER PRIMARY KEY, ts TEXT, server TEXT, nick TEXT, latency_ms INTEGER, loss_pct INTEGER, ok INTEGER, measured_at TEXT);
    CREATE TABLE modem_httpcheck (id INTEGER PRIMARY KEY, ts TEXT, server TEXT, nick TEXT, status INTEGER, total_ms INTEGER, content_ok INTEGER, error TEXT, port_id TEXT, route_reason TEXT);
    CREATE TABLE traffic_hourly (server_name TEXT, port_id TEXT, nick TEXT, operator TEXT, client_name TEXT, hour_start TEXT, bytes_in INTEGER, bytes_out INTEGER, uncertain INTEGER);
    CREATE TABLE rotation_log (server_name TEXT, nick TEXT, old_ip TEXT, new_ip TEXT, started_at TEXT, ended_at TEXT, took_sec REAL);
    CREATE TABLE system_log (id INTEGER PRIMARY KEY, timestamp TEXT, category TEXT, level TEXT, action TEXT, target TEXT, message TEXT, details TEXT);
    CREATE TABLE modem_ping_state (server TEXT, nick TEXT, imei TEXT, quality TEXT, latency_ms INTEGER, loss_pct INTEGER, ok INTEGER, observed_at TEXT, measured_at TEXT, updated_at TEXT);
  `);
  const ping = db.prepare('INSERT INTO modem_ping (ts, server, nick, latency_ms, loss_pct, ok) VALUES (?,?,?,?,?,1)');
  for (let i = 0; i < 10; i++) ping.run(`2026-10-12T0${i}:00:00.000Z`, 'S1', 'MD_1', 100, i < 4 ? 50 : 0);   // 4 из 10 с потерями 50%
  for (let i = 0; i < 10; i++) ping.run(`2026-10-12T0${i}:00:00.000Z`, 'S3', 'MD_FREE', 100, 100);          // свободный модем
  db.prepare("INSERT INTO traffic_hourly VALUES ('S1','S1_p','MD_1','op','c','2026-10-12 05:00',100,100,0)").run();
  state.setKnownModems({ S1: { p: { portName: 'client', nick: 'MD_1', imei: 'i1' } } });
  ai.init({ db, logger: { info() {}, warn() {}, error() {} }, getSetting: (k, d) => d });
});

afterAll(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); state.setKnownModems({}); });

describe('AI-контекст: worker-поток и потери как сбой пинга', () => {
  it('контекст из worker совпадает с синхронным', async () => {
    const sync = ai.buildDayContext(DATE);
    const off = await ai.buildDayContextOffThread(DATE);
    expect(off).toEqual(sync);
  });

  it('сбой пинга = потери ≥ 30%; модем без клиента не учитывается', async () => {
    const ctx = await ai.buildDayContextOffThread(DATE);
    const s1 = ctx.servers.find(s => s.server === 'S1');
    expect(s1.ping).toMatchObject({ total: 10, failures: 4, failure_pct: 40 });
    expect(ctx.servers.find(s => s.server === 'S3').ping.total).toBe(0);   // пинги свободного модема не считаются
    expect(ctx.problem_modems.map(m => m.modem)).toEqual(['MD_1']);
    expect(ctx.ping_failure_definition).toContain('30%');
  });
});
