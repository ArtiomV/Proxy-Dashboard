// WP6.2: with a section's dependency broken, /api/admin/data must still
// answer 200 with the other sections intact (degradation, not 502).

import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import express from 'express';
import { createRequire } from 'module';
import { bootApp } from '../_helpers/app.js';

const require = createRequire(import.meta.url);
const createOpsExtRouter = require('../../src/routes/ops-ext.js');
const { getMoscowNow, getMoscowToday, getMoscowYesterday } = require('../../src/utils/time.js');
const { parseBwToBytes, trafficBytesToGb } = require('../../src/utils/traffic.js');

let app, db;

beforeAll(() => {
  const ctx = bootApp();
  db = ctx.db;

  const silent = { info() {}, warn() {}, error() {}, debug() {} };
  const passAuth = (req, res, next) => { req.user = { login: 'test_admin', isAdmin: 1 }; next(); };
  const brokenTrackingDb = {
    metaFleetRosterStmt: () => ({ all: () => { throw new Error('roster table exploded'); } }),
  };
  const router = createOpsExtRouter({
    db, logger: silent, DB_PATH: ':memory:',
    trackingDb: brokenTrackingDb,
    getConnsHistory: () => ({}),
    authMiddleware: passAuth, adminMiddleware: passAuth,
    dashboardLimiter: (req, res, next) => next(),
    fs: require('fs'), path: require('path'),
    dbStmts: {}, dbAudit: { ensureRequestContext() {} },
    appSettings: {},
    getAllBankPayments: () => [],
    getSessionCount: () => 0,
    getClients: () => [],
    getApiServers: () => [],
    getServerCountries: () => ({}),
    getRunningJobs: () => new Map(),
    getLastBillingRunSummary: () => null,
    getLastReconciliationMonth: () => null,
    getIntervals: () => [],
    getFetchAllServersDataCached: () => async () => [],
    getMergeServerData: () => () => ({ status: [], bandwidth: {} }),
    getIpTracking: () => ({}),
    getUptimeTracking: () => ({}),
    getKnownModems: () => ({}),
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

describe('/api/admin/data — section degradation (WP6.2)', () => {
  it('broken fleet roster → 200 with degraded fleet, other sections intact', async () => {
    const res = await request(app).get('/api/admin/data');
    expect(res.status).toBe(200);
    // fleet section degraded to its fallback
    expect(res.body.fleet).toBeTruthy();
    expect(res.body.fleet.total).toBe(0);
    // billing/traffic/meta sections survived
    expect(res.body).toHaveProperty('metrics');
    expect(res.body.metrics).toHaveProperty('revenue_30d');
    expect(res.body).toHaveProperty('clientMonthCharges');
    expect(res.body).toHaveProperty('clientLiveMonthGb');
    expect(res.body).toHaveProperty('servers');
    expect(res.body).toHaveProperty('clients');
  });
});
