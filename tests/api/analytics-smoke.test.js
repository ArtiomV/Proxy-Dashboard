// WP6.1: smoke coverage for every analytics endpoint after the split —
// catches broken SQL in the new query layer (src/db/analytics.js) and
// miswired router deps. These endpoints had NO test coverage before.

import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { bootApp, asAdmin } from '../_helpers/app.js';

let app, adminToken;

beforeAll(() => {
  const ctx = bootApp();
  app = ctx.app;
  adminToken = asAdmin();
});

const GET = (path) => request(app).get(path).set('X-Auth-Token', adminToken);

describe('analytics endpoints (WP6.1 split) — 200 + basic shape', () => {
  it('GET /api/analytics/modem_health', async () => {
    const res = await GET('/api/analytics/modem_health?days=7');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('modems');
    expect(res.body).toHaveProperty('summary');
    expect(Array.isArray(res.body.modems)).toBe(true);
  });

  it('GET /api/analytics/modem_health_history validates params', async () => {
    const bad = await GET('/api/analytics/modem_health_history');
    expect(bad.status).toBe(400);
    const ok = await GET('/api/analytics/modem_health_history?server=S1&imei=123');
    expect(ok.status).toBe(200);
    expect(ok.body).toHaveProperty('rows');
  });

  it('GET /api/analytics/capacity', async () => {
    const res = await GET('/api/analytics/capacity?days=7');
    expect(res.status).toBe(200);
    expect(res.body.summary).toHaveProperty('total_gb');
    expect(res.body.summary).toHaveProperty('total_modems');
    expect(Array.isArray(res.body.servers)).toBe(true);
  });

  it('GET /api/analytics/latency_stats', async () => {
    const res = await GET('/api/analytics/latency_stats?days=7');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('overall');
    expect(res.body).toHaveProperty('prior');
    expect(Array.isArray(res.body.days)).toBe(true);
  });

  it('GET /api/analytics/latency_day', async () => {
    const res = await GET('/api/analytics/latency_day?date=2026-06-01');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('points');
    expect(res.body).toHaveProperty('summary');
  });

  it('GET /api/analytics/rotations', async () => {
    const res = await GET('/api/analytics/rotations?days=7');
    expect(res.status).toBe(200);
    expect(res.body.summary).toHaveProperty('success_pct');
    expect(Array.isArray(res.body.per_day)).toBe(true);
  });

  it('GET /api/analytics/ip_stats', async () => {
    const res = await GET('/api/analytics/ip_stats?days=30');
    expect(res.status).toBe(200);
    expect(res.body.summary).toHaveProperty('unique_ips');
    expect(Array.isArray(res.body.reused)).toBe(true);
  });

  it('GET /api/analytics/traffic_forecast', async () => {
    const res = await GET('/api/analytics/traffic_forecast?days=30');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('forecasts');
    expect(res.body).toHaveProperty('days_left_in_month');
  });

  it('GET /api/analytics/monthly_traffic', async () => {
    const res = await GET('/api/analytics/monthly_traffic?months=3');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBe(3);
    expect(res.body[2].is_current).toBe(true);
  });

  it('GET /api/analytics/heatmap', async () => {
    const res = await GET('/api/analytics/heatmap?view=country&id=all&days=3');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('matrix');
    expect(res.body.matrix.length).toBe(3);
  });

  it('GET /api/analytics/modem_heatmap validates params', async () => {
    const bad = await GET('/api/analytics/modem_heatmap');
    expect(bad.status).toBe(400);
  });

  it('GET /api/analytics/logs_domains_full', async () => {
    const res = await GET('/api/analytics/logs_domains_full?limit=10');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('summary');
    expect(res.body).toHaveProperty('facets');
    expect(Array.isArray(res.body.rows)).toBe(true);
  });
});
