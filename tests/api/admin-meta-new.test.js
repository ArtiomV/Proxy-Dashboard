import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
import request from 'supertest';

const require = createRequire(import.meta.url);
const express = require('express');
const Database = require('better-sqlite3');
const createAdminMetaRouter = require('../../src/routes/admin-meta.js');
const traffic = require('../../src/utils/traffic.js');

let db, app, settings;

function operatorsRepo() {
  return {
    listAll: () => db.prepare('SELECT operator, country, source, updated_at, first_seen_on FROM operator_country_map').all(),
    getOne: op => db.prepare('SELECT operator, country, source FROM operator_country_map WHERE operator = ?').get(String(op).toLowerCase()),
    setManual: (op, country) => db.prepare("INSERT OR REPLACE INTO operator_country_map (operator,country,source) VALUES (?,?,'manual')").run(String(op).toLowerCase(), country),
    remove: op => db.prepare('DELETE FROM operator_country_map WHERE operator = ?').run(String(op).toLowerCase()),
    setAlias: (alias, canonical) => db.prepare('INSERT OR REPLACE INTO operator_alias_map (alias,canonical) VALUES (?,?)').run(alias, canonical),
    removeAlias: alias => db.prepare('DELETE FROM operator_alias_map WHERE alias = ?').run(alias),
    listAliases: () => db.prepare('SELECT alias, canonical FROM operator_alias_map').all(),
    aliasMap: () => Object.fromEntries(db.prepare('SELECT lower(alias) alias, canonical FROM operator_alias_map').all().map(r => [r.alias, r.canonical])),
  };
}

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(`
    CREATE TABLE modem_meta (
      server_name TEXT, imei TEXT, nick TEXT DEFAULT '', operator TEXT DEFAULT '',
      phone TEXT DEFAULT '', contract_renewal_date TEXT DEFAULT '', updated_at TEXT,
      UNIQUE(server_name, imei)
    );
    CREATE TABLE operator_country_map (
      operator TEXT PRIMARY KEY, country TEXT, source TEXT, updated_at TEXT, first_seen_on TEXT
    );
    CREATE TABLE operator_alias_map (alias TEXT PRIMARY KEY COLLATE NOCASE, canonical TEXT);
  `);
  settings = {
    operator_packages: JSON.stringify([{ operator: 'VF-RO', type: 'per_sim', volume_gb: 400 }]),
    operator_gb_costs: { 'VF-RO': 3.5 },
  };
  app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { login: 'test' }; next(); });
  app.use(createAdminMetaRouter({
    db,
    logger: { info() {}, warn() {}, error() {} },
    authMiddleware: (_req, _res, next) => next(),
    adminMiddleware: (_req, _res, next) => next(),
    operatorsDb: operatorsRepo(),
    trackingDb: {}, knownModems: {}, saveKnownModems() {}, logActivity() {},
    fetchAllServersDataCached: async () => [], apiServers: [],
    getSetting: (key, fallback) => key in settings ? settings[key] : fallback,
    setSettings: patch => Object.assign(settings, patch),
  }));
});

afterEach(() => { traffic.setOperatorAliases({}); db.close(); });

describe('admin meta additions', () => {
  it('stores a strict SIM contract renewal date', async () => {
    db.prepare('INSERT INTO modem_meta (server_name, imei) VALUES (?, ?)').run('S1', 'imei-1');
    const bad = await request(app).put('/api/admin/modems/S1/imei-1/contract').send({ renewal_date: '2026-02-30' });
    expect(bad.status).toBe(400);
    const ok = await request(app).put('/api/admin/modems/S1/imei-1/contract').send({ renewal_date: '2026-09-15' });
    expect(ok.status).toBe(200);
    expect(db.prepare('SELECT contract_renewal_date d FROM modem_meta').get().d).toBe('2026-09-15');
  });

  it('merges operator spelling in rows, packages and costs', async () => {
    db.prepare('INSERT INTO modem_meta (server_name, imei, operator) VALUES (?, ?, ?)').run('S2', 'imei-2', 'VF-RO');
    db.prepare("INSERT INTO operator_country_map (operator,country,source) VALUES ('vf-ro','RO','auto')").run();
    const res = await request(app).put('/api/admin/operators/VF-RO/alias').send({ canonical: 'Vodafone RO' });
    expect(res.status).toBe(200);
    expect(db.prepare('SELECT operator FROM modem_meta').get().operator).toBe('Vodafone RO');
    expect(JSON.parse(settings.operator_packages)[0].operator).toBe('Vodafone RO');
    expect(settings.operator_gb_costs).toEqual({ 'Vodafone RO': 3.5 });
  });
});
