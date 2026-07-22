// 2026-07-22: «убрать автовключение неработающих» — bound-but-dead modem must
// drop out of the client's modemCount once uptime_tracking proves it has not
// been ONLINE for >24h. Before the fix, ProxySmart kept the port binding, so
// lastClientSeen refreshed on every poll and the corpse counted forever.
// Fail-open cases (no IMEI / no uptime record) must keep counting.

import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import express from 'express';
import { createRequire } from 'module';
import { bootApp } from '../_helpers/app.js';

const require = createRequire(import.meta.url);
const createOpsExtRouter = require('../../src/routes/ops-ext.js');
const { getMoscowNow, getMoscowToday, getMoscowYesterday } = require('../../src/utils/time.js');
const { parseBwToBytes, trafficBytesToGb } = require('../../src/utils/traffic.js');

const NOW = Date.now();
let app;

beforeAll(() => {
  const ctx = bootApp();
  const silent = { info() {}, warn() {}, error() {}, debug() {} };
  const passAuth = (req, res, next) => { req.user = { login: 'test_admin', isAdmin: 1 }; next(); };

  const known = {
    S4: {
      pLive:      { portName: 'CLIENT', imei: 'LIVE1', nick: 'MD_L', lastClientSeen: NOW },
      pDead:      { portName: 'CLIENT', imei: 'DEAD1', nick: 'MD_D', lastClientSeen: NOW },   // bound, but dark 3 days
      pNoId:      { portName: 'CLIENT', imei: '',      nick: '',     lastClientSeen: NOW },   // identity-less bound port
      pNoUptime:  { portName: 'CLIENT', imei: 'NEW1',  nick: 'MD_N', lastClientSeen: NOW },   // no uptime record yet
    },
  };
  const uptime = {
    'S4_LIVE1': { last_online_check: new Date(NOW - 3600 * 1000).toISOString() },
    'S4_DEAD1': { last_online_check: new Date(NOW - 3 * 86400 * 1000).toISOString() },
  };

  const router = createOpsExtRouter({
    db: ctx.db, logger: silent, DB_PATH: ':memory:',
    trackingDb: { metaFleetRosterStmt: () => ({ all: () => [] }) },
    getConnsHistory: () => ({}),
    authMiddleware: passAuth, adminMiddleware: passAuth,
    dashboardLimiter: (req, res, next) => next(),
    fs: require('fs'), path: require('path'),
    dbStmts: {}, dbAudit: { ensureRequestContext() {} },
    appSettings: {},
    getAllBankPayments: () => [],
    getSessionCount: () => 0,
    getClients: () => [{ login: 'c1', portName: 'CLIENT', password: 'x', passwordHash: 'y' }],
    getApiServers: () => [],
    getServerCountries: () => ({}),
    getRunningJobs: () => new Map(),
    getLastBillingRunSummary: () => null,
    getLastReconciliationMonth: () => null,
    getIntervals: () => [],
    getFetchAllServersDataCached: () => async () => [],
    getMergeServerData: () => () => ({ status: [], bandwidth: {} }),
    getIpTracking: () => ({}),
    getUptimeTracking: () => uptime,
    getKnownModems: () => known,
    getIpHistory: () => ({}),
    getDailyTraffic: () => ({}),
    getPortKeyToPortName: () => ({}),
    getTochkaConfig: () => ({}),
    getProxyCheckSummary: () => ({}),
    computeProxyIssues: () => [],
    fetchApi: async () => ({}),
    findServer: () => null,
    getSpeedtestLatest: () => ({}),
    _getClientTrend: () => ({}),
    _getModemTrend: () => ({}),
    logActivity: () => {},
    getMoscowNow, getMoscowToday, getMoscowYesterday,
    ledgerExpense: (e) => (e.cost != null ? e.cost : (e.amount || 0)),
    parseBwToBytes, trafficBytesToGb,
    getBalanceReconcile: () => ({ getLastResult: () => ({}) }),
  });

  app = express();
  app.use(router);
});

describe('/api/admin/data — клиентский ростер: гейт активности >24ч', () => {
  it('мёртвый >24ч (по uptime) исключён из modemCount; fail-open случаи остаются', async () => {
    const res = await request(app).get('/api/admin/data');
    expect(res.status).toBe(200);
    const c = (res.body.clients || []).find(x => x.portName === 'CLIENT');
    expect(c).toBeTruthy();
    // 3 из 4: живой + identity-less + без uptime-записи. Мёртвый DEAD1 — нет.
    expect(c.modemCount).toBe(3);
  });
});
