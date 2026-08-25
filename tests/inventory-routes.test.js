import { beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import createInventoryRouter from '../src/routes/inventory.js';

let db;
let router;

function invoke(method, path, { body = {}, params = {}, query = {} } = {}) {
  const layer = router.stack.find(item => item.route && item.route.path === path && item.route.methods[method]);
  if (!layer) throw new Error(`Missing route ${method.toUpperCase()} ${path}`);
  const handler = layer.route.stack[layer.route.stack.length - 1].handle;
  const out = { status: 200, body: null };
  const res = {
    status(code) { out.status = code; return this; },
    json(payload) { out.body = payload; return this; },
  };
  handler({ body, params, query, user: { login: 'tester' } }, res);
  return out;
}

beforeEach(() => {
  if (db) db.close();
  db = new Database(':memory:');
  db.exec(`
    CREATE TABLE equipment_inventory (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      location_key TEXT NOT NULL,
      equipment_type TEXT NOT NULL COLLATE NOCASE,
      quantity INTEGER NOT NULL DEFAULT 0 CHECK(quantity >= 0),
      notes TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(location_key, equipment_type)
    );
    CREATE TABLE sim_registry (
      iccid TEXT PRIMARY KEY,
      phone TEXT NOT NULL,
      operator TEXT NOT NULL DEFAULT '',
      notes TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL DEFAULT 'import',
      imported_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE modem_meta (
      server_name TEXT NOT NULL,
      imei TEXT NOT NULL,
      nick TEXT NOT NULL DEFAULT '',
      operator TEXT NOT NULL DEFAULT '',
      phone TEXT NOT NULL DEFAULT '',
      iccid TEXT NOT NULL DEFAULT '',
      deleted INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(server_name, imei)
    );
  `);
  router = createInventoryRouter({
    db,
    logger: { error() {} },
    authMiddleware(req, res, next) { next(); },
    adminMiddleware(req, res, next) { next(); },
    getApiServers: () => [
      { name: 'S1', displayName: 'Кишинёв', address: 'Кишинёв, Армянская 30' },
      { name: 'S2', displayName: 'Резерв', address: 'Кишинёв, Армянская 30' },
    ],
    getServerCountries: () => ({ S1: { country: 'MD' }, S2: { country: 'MD' } }),
  });
});

describe('inventory admin routes', () => {
  it('stores equipment once per physical location', () => {
    const locationKey = 'location:кишинёв, армянская 30';
    const created = invoke('post', '/api/admin/equipment', {
      body: { location_key: locationKey, equipment_type: 'UPS', quantity: 2, notes: 'APC' },
    });
    expect(created.status).toBe(200);
    expect(created.body.item).toMatchObject({ equipment_type: 'UPS', quantity: 2 });
    const listed = invoke('get', '/api/admin/equipment');
    expect(listed.body.locations).toHaveLength(1);
    expect(listed.body.locations[0].servers).toHaveLength(2);
    expect(listed.body.summary.total_units).toBe(2);
  });

  it('imports a registry row and fills the matching modem phone by normalized ICCID', () => {
    db.prepare('INSERT INTO modem_meta (server_name, imei, nick, iccid) VALUES (?, ?, ?, ?)')
      .run('S1', '123456789012345', 'MD_01', '8937 3123 4567 8901 234');
    db.prepare('INSERT INTO modem_meta (server_name, imei, nick, iccid) VALUES (?, ?, ?, ?)')
      .run('S1', '123456789012346', 'MD_02', '');
    const result = invoke('post', '/api/admin/sim_registry/import', {
      body: { text: 'ICCID;Телефон;Оператор\n8937312345678901234;+37360111222;Orange' },
    });
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ processed: 1, inserted: 1, matched: 1, modem_rows_updated: 1 });
    expect(db.prepare('SELECT phone FROM modem_meta').get().phone).toBe('+37360111222');
    const listed = invoke('get', '/api/admin/sim_registry');
    expect(listed.body.summary).toMatchObject({ registry_total: 1, registry_matched: 1, phone_missing: 0, modems_without_iccid: 1 });
    expect(listed.body.items[0].bindings[0].nick).toBe('MD_01');
  });
});
