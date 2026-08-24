// 2026-08-24: MAX-override traffic_hourly в /api/client/daily_traffic.
// Инцидент 23.08.26: рестарт proxysmart на MD-боксах обнулил счётчик
// bandwidth_bytes_yesterday_* → daily_traffic за день занижен. Админский
// эндпоинт уже брал MAX(daily_traffic, traffic_hourly), клиентский — нет,
// и клиенты видели заниженное потребление. Теперь клиентский тоже
// MAX-мерджит почасовые дельты за прошлые дни (сегодня — живой счётчик).

import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'module';
import express from 'express';
import request from 'supertest';
const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const createTrafficRouter = require('../../src/routes/traffic.js');

const noop = () => {};
const logger = { info: noop, warn: noop, error: noop };

let db, app, dailyTraffic;

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(`CREATE TABLE traffic_hourly (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    server_name TEXT, port_id TEXT, nick TEXT, operator TEXT, client_name TEXT,
    hour_start TEXT, bytes_in INTEGER DEFAULT 0, bytes_out INTEGER DEFAULT 0,
    uncertain INTEGER DEFAULT 0, UNIQUE(port_id, hour_start))`);

  dailyTraffic = {
    // Заниженное значение за 23.08 (счётчик бокса обнулился рестартом)
    'S1_portA': { '2026-08-23': { in: 100e9, out: 50e9, portName: 'WildBox' } },
    // Корректное значение: daily_traffic больше почасовой реконструкции
    'S1_portB': { '2026-08-23': { in: 400e9, out: 100e9, portName: 'WildBox' } },
  };

  const ins = db.prepare(`INSERT INTO traffic_hourly
    (server_name, port_id, client_name, hour_start, bytes_in, bytes_out) VALUES (?,?,?,?,?,?)`);
  // 23.08 МСК = 22.08 21:00 UTC .. 23.08 20:59 UTC. 300 GB суммарно по portA.
  ins.run('S1', 'S1_portA', 'WildBox', '2026-08-23 05:00:00', 200e9, 80e9);
  ins.run('S1', 'S1_portA', 'WildBox', '2026-08-23 06:00:00', 20e9, 0);
  // portB: почасовая реконструкция МЕНЬШЕ daily_traffic — не должна затирать
  ins.run('S1', 'S1_portB', 'WildBox', '2026-08-23 05:00:00', 100e9, 50e9);
  // Другой клиент — не должен попасть в выдачу WildBox
  ins.run('S1', 'S1_portX', 'OtherClient', '2026-08-23 05:00:00', 999e9, 999e9);

  app = express();
  app.use(express.json());
  const router = createTrafficRouter({
    db, logger,
    authMiddleware: (req, res, next) => { req.user = { login: 'wildbox' }; next(); },
    adminMiddleware: (req, res, next) => next(),
    fetchAllServersDataCached: async () => [],
    mergeServerData: () => ({ bandwidth: {} }),
    fetchApi: async () => ({}), postApi: async () => ({}), findServer: () => null,
    getMoscowToday: () => '2026-08-24',
    trafficBytesToGb: (b) => b / 1e9, parseBwToBytes: () => 0, parseTrafficValue: () => 0,
    normalizeOperator: (s) => s,
    clients: [], clientByLogin: new Map([['wildbox', { portName: 'WildBox' }]]), clientById: new Map(),
    dailyTraffic, portKeyToPortName: {},
    knownModems: {}, SERVER_COUNTRIES: {},
    recordDailyTraffic: noop, refreshPortKeyMapping: noop, logActivity: noop, kvGet: () => null,
  });
  app.use(router);
});

describe('GET /api/client/daily_traffic — traffic_hourly MAX-override', () => {
  it('заниженный daily_traffic поднимается до traffic_hourly за прошлый день', async () => {
    const res = await request(app).get('/api/client/daily_traffic');
    expect(res.status).toBe(200);
    const day = res.body.daily['S1_portA']['2026-08-23'];
    expect(day.in).toBe(220e9);
    expect(day.out).toBe(80e9);
    expect(day.portName).toBe('WildBox');
  });

  it('корректный daily_traffic НЕ затирается меньшей почасовой реконструкцией', async () => {
    const res = await request(app).get('/api/client/daily_traffic');
    const day = res.body.daily['S1_portB']['2026-08-23'];
    expect(day.in).toBe(400e9);
    expect(day.out).toBe(100e9);
  });

  it('чужие клиенты не попадают в выдачу', async () => {
    const res = await request(app).get('/api/client/daily_traffic');
    expect(res.body.daily['S1_portX']).toBeUndefined();
  });
});
