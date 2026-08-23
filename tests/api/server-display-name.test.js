import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'module';
import request from 'supertest';

const require = createRequire(import.meta.url);
const express = require('express');
const createServersRouter = require('../../src/routes/servers.js');

let app, apiServers, saved, fetchApi;

beforeEach(() => {
  apiServers = [
    { name: 'S1', url: 'http://s1', user: 'proxy', pass: 'p1', publicIp: '10.0.0.1', country: 'MD', countryName: 'Moldova' },
    { name: 'S2', url: 'http://s2', user: 'proxy', pass: 'p2', publicIp: '10.0.0.2', country: 'RO', countryName: 'Romania', displayName: 'Бухарест' },
  ];
  saved = 0;
  fetchApi = vi.fn().mockResolvedValue([]);
  app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { login: 'test' }; next(); });
  app.use(createServersRouter({
    db: { prepare: () => ({ all: () => [], get: () => undefined }) },
    logger: { info() {}, warn() {}, error() {} },
    authMiddleware: (_req, _res, next) => next(),
    adminMiddleware: (_req, _res, next) => next(),
    apiServers,
    SERVER_COUNTRIES: {
      S1: { country: 'MD', name: 'Moldova' },
      S2: { country: 'RO', name: 'Romania' },
    },
    appSettings: {},
    fetchApi,
    saveApiServersToDb: () => { saved++; },
    proxySmart: { invalidateCache() {} },
    auditLog() {}, getClientIp: () => '127.0.0.1',
    getSetting: (_key, fallback) => fallback,
    setSettings() {}, rescheduleSpeedtests() {},
  }));
});

describe('API server display names', () => {
  it('changes the human-facing name without renaming the stable server key', async () => {
    const patch = await request(app).patch('/api/admin/servers/S1').send({
      displayName: 'Кишинёв — Армянская', panelUser: 'proxy', panelPassword: 'p1',
    });
    expect(patch.status).toBe(200);
    expect(patch.body).toMatchObject({ name: 'S1', displayName: 'Кишинёв — Армянская' });
    expect(apiServers[0].name).toBe('S1');
    expect(apiServers[0].displayName).toBe('Кишинёв — Армянская');
    expect(saved).toBe(1);
    expect(fetchApi).not.toHaveBeenCalled();

    const list = await request(app).get('/api/admin/servers');
    expect(list.body.servers[0]).toMatchObject({ name: 'S1', displayName: 'Кишинёв — Армянская' });
  });

  it('rejects duplicate aliases and clears an alias back to the stable key', async () => {
    const duplicate = await request(app).patch('/api/admin/servers/S1').send({ displayName: ' бухарест ' });
    expect(duplicate.status).toBe(409);
    expect(saved).toBe(0);

    apiServers[0].displayName = 'Кишинёв';
    const cleared = await request(app).patch('/api/admin/servers/S1').send({ displayName: '   ' });
    expect(cleared.status).toBe(200);
    expect(cleared.body.displayName).toBe('S1');
    expect(apiServers[0].displayName).toBeUndefined();
  });

  it('does not allow deleting a server through the API', async () => {
    const result = await request(app).delete('/api/admin/servers/S1');
    expect(result.status).toBe(405);
    expect(result.body.error).toContain('Удаление серверов отключено');
    expect(apiServers.map(s => s.name)).toEqual(['S1', 'S2']);
    expect(saved).toBe(0);
  });
});
