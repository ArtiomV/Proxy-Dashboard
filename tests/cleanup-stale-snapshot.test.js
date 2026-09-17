import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';
const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const cleanup = require('../src/jobs/cleanup');

// 2026-09-18 (FIX-04/DEEP-11): авторитетность снимка server_cache.json —
// только полный свежий снимок по контракту даёт право на stale-очистку портов.

const DAY = 86400000;
const today = new Date().toISOString().slice(0, 10);
const oldDate = new Date(Date.now() - 5 * DAY).toISOString().slice(0, 10);

let dir, cacheFile, db, memory;

function writeCache(cache) {
  fs.writeFileSync(cacheFile, JSON.stringify(cache));
}

function run() {
  return cleanup.create({
    db, fs, SERVER_CACHE_FILE: cacheFile,
    appSettings: {}, dailyTraffic: memory,
    logger: { info() {}, error() {}, warn() {} }, logActivity() {},
  }).cleanupStalePortMappings();
}

function dbPorts() {
  return db.prepare('SELECT port_name FROM daily_traffic ORDER BY port_name').all().map(r => r.port_name);
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cleanup-snapshot-'));
  cacheFile = path.join(dir, 'cache.json');
  db = new Database(':memory:');
  db.exec("CREATE TABLE daily_traffic(port_name TEXT, date TEXT, client_name TEXT NOT NULL DEFAULT '')");
  memory = {};
});

afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('snapshot contract authority', () => {
  it('fresh valid snapshot authorizes deletion of a gone stale port', () => {
    writeCache({ S1: { cachedAt: Date.now(), bw: { 'port-live': {} }, ports: { imei: [{ portID: 'port-live' }] } } });
    db.prepare("INSERT INTO daily_traffic VALUES (?, ?, '')").run('S1_port-gone', oldDate);
    db.prepare("INSERT INTO daily_traffic VALUES (?, ?, '')").run('S1_port-live', oldDate);
    memory['S1_port-gone'] = { [oldDate]: {} };
    memory['S1_port-live'] = { [oldDate]: {} };
    const result = run();
    expect(result.error).toBeUndefined();
    expect(dbPorts()).toEqual(['S1_port-live']);
    expect(Object.keys(memory)).toEqual(['S1_port-live']);
  });

  it('authoritative empty snapshot (bw={}, ports={}) still authorizes deletion', () => {
    // Достоверный ПУСТОЙ ответ — легальное состояние «портов нет», а не сбой.
    writeCache({ S1: { cachedAt: Date.now(), bw: {}, ports: {} } });
    db.prepare("INSERT INTO daily_traffic VALUES (?, ?, '')").run('S1_port-gone', oldDate);
    memory['S1_port-gone'] = { [oldDate]: {} };
    const result = run();
    expect(result.skippedSrv).toEqual([]);
    expect(dbPorts()).toEqual([]);
    expect(Object.keys(memory)).toEqual([]);
  });

  it('protects ports of a server with an unreachable (stale) snapshot', () => {
    writeCache({ S4: { cachedAt: Date.now() - 31 * 60000, bw: {}, ports: {} } });
    db.prepare("INSERT INTO daily_traffic VALUES (?, ?, '')").run('S4_port-old', oldDate);
    memory['S4_port-old'] = { [oldDate]: {} };
    const result = run();
    expect(result.skipped).toBe('no_fresh_servers');
    expect(result.skippedSrv).toEqual([{ server: 'S4', reason: 'stale' }]);
    expect(dbPorts()).toEqual(['S4_port-old']);
    expect(Object.keys(memory)).toEqual(['S4_port-old']);
  });

  it.each([
    ['non-numeric string', 'invalid', 'cached_at_invalid'],
    ['numeric string', String(Date.now()), 'cached_at_invalid'],
    ['zero', 0, 'cached_at_invalid'],
    ['missing', undefined, 'cached_at_invalid'],
    ['future', Date.now() + 60000, 'cached_at_future'],
  ])('rejects cachedAt: %s', (_label, cachedAt, reason) => {
    const entry = { bw: {}, ports: {} };
    if (cachedAt !== undefined) entry.cachedAt = cachedAt;
    writeCache({ S1: entry });
    db.prepare("INSERT INTO daily_traffic VALUES (?, ?, '')").run('S1_port-old', oldDate);
    memory['S1_port-old'] = { [oldDate]: {} };
    const result = run();
    expect(result.skippedSrv).toEqual([{ server: 'S1', reason }]);
    expect(dbPorts()).toEqual(['S1_port-old']);
    expect(Object.keys(memory)).toEqual(['S1_port-old']);
  });

  it('rejects a snapshot whose bw is a string', () => {
    // Строка truthy, и Object.keys(строки) давал символы — ложные liveIds.
    writeCache({ S1: { cachedAt: Date.now(), bw: 'oops', ports: {} } });
    db.prepare("INSERT INTO daily_traffic VALUES (?, ?, '')").run('S1_port-old', oldDate);
    memory['S1_port-old'] = { [oldDate]: {} };
    const result = run();
    expect(result.skippedSrv).toEqual([{ server: 'S1', reason: 'bw_not_object' }]);
    expect(dbPorts()).toEqual(['S1_port-old']);
    expect(Object.keys(memory)).toEqual(['S1_port-old']);
  });

  it.each([
    ['top-level error field', { error: 'auth failed', cachedAt: Date.now(), bw: {}, ports: {} }, 'snapshot_has_error'],
    ['invalid flag from fetch side', { invalid: true, cachedAt: Date.now(), bw: {}, ports: {} }, 'snapshot_has_error'],
    ['ports value not an array', { cachedAt: Date.now(), bw: {}, ports: { imei: { error: 'fail' } } }, 'ports_list_not_array'],
    ['port entry without portID', { cachedAt: Date.now(), bw: {}, ports: { imei: [{ HTTP_PORT: 10001 }] } }, 'port_entry_invalid'],
  ])('rejects a snapshot with %s', (_label, entry, reason) => {
    writeCache({ S1: entry });
    db.prepare("INSERT INTO daily_traffic VALUES (?, ?, '')").run('S1_port-old', oldDate);
    memory['S1_port-old'] = { [oldDate]: {} };
    const result = run();
    expect(result.skippedSrv).toEqual([{ server: 'S1', reason }]);
    expect(dbPorts()).toEqual(['S1_port-old']);
    expect(Object.keys(memory)).toEqual(['S1_port-old']);
  });

  it('keeps fresh rows of a gone port (stale retention not expired)', () => {
    writeCache({ S1: { cachedAt: Date.now(), bw: {}, ports: {} } });
    db.prepare("INSERT INTO daily_traffic VALUES (?, ?, '')").run('S1_port-gone', today);
    memory['S1_port-gone'] = { [today]: {} };
    const result = run();
    expect(result.dtDeleted).toBe(0);
    expect(dbPorts()).toEqual(['S1_port-gone']);
    expect(Object.keys(memory)).toEqual(['S1_port-gone']);
  });

  it('keeps daily_traffic rows with a client_name', () => {
    writeCache({ S1: { cachedAt: Date.now(), bw: {}, ports: {} } });
    db.prepare("INSERT INTO daily_traffic VALUES (?, ?, '')").run('S1_port-gone', oldDate);
    db.prepare("INSERT INTO daily_traffic VALUES (?, ?, 'client-a')").run('S1_port-client', oldDate);
    const result = run();
    expect(dbPorts()).toEqual(['S1_port-client']);
    expect(result.dtDeleted).toBe(1);
  });

  it('does not touch memory when the SQLite delete fails (tx → memory order)', () => {
    writeCache({ S1: { cachedAt: Date.now(), bw: {}, ports: {} } });
    db.prepare("INSERT INTO daily_traffic VALUES (?, ?, '')").run('S1_port-gone', oldDate);
    memory['S1_port-gone'] = { [oldDate]: {} };
    db.exec("CREATE TRIGGER fail_del BEFORE DELETE ON daily_traffic BEGIN SELECT RAISE(ABORT, 'boom'); END");
    const result = run();
    expect(result.error).toBe('boom');
    // Транзакция откачена, память не тронута — стороны согласованы.
    expect(dbPorts()).toEqual(['S1_port-gone']);
    expect(Object.keys(memory)).toEqual(['S1_port-gone']);
  });

  it('protects an ambiguous key when the longer server prefix is not authoritative', () => {
    // S1 живой, S1_X недоступен: S1_X_port нельзя приписывать S1.
    writeCache({
      S1: { cachedAt: Date.now(), bw: {}, ports: {} },
      S1_X: { cachedAt: Date.now() - 86400000, bw: {}, ports: {} },
    });
    db.prepare("INSERT INTO daily_traffic VALUES (?, ?, '')").run('S1_X_port', oldDate);
    db.prepare("INSERT INTO daily_traffic VALUES (?, ?, '')").run('S1_gone', oldDate);
    memory['S1_X_port'] = { [oldDate]: {} };
    memory['S1_gone'] = { [oldDate]: {} };
    const result = run();
    expect(result.error).toBeUndefined();
    expect(dbPorts()).toEqual(['S1_X_port']);
    expect(Object.keys(memory)).toEqual(['S1_X_port']);
  });
});
