import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';
const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const cleanup = require('../src/jobs/cleanup');

describe('stale port cleanup authority', () => {
  it('keeps an unreachable server and recognizes ports absent from bandwidth', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cleanup-authority-'));
    const cache = path.join(dir, 'cache.json');
    const old = new Date(Date.now() - 5 * 86400000).toISOString().slice(0, 10);
    fs.writeFileSync(cache, JSON.stringify({
      S1: { cachedAt: Date.now(), bw: {}, ports: { imei: [{ portID: 'port-live' }] } },
      S4: { cachedAt: Date.now() - 86400000, bw: {}, ports: {} },
    }));
    const db = new Database(':memory:');
    db.exec("CREATE TABLE daily_traffic(port_name TEXT, date TEXT, client_name TEXT NOT NULL DEFAULT '')");
    db.prepare("INSERT INTO daily_traffic VALUES (?, ?, ''), (?, ?, '')")
      .run('S1_port-live', old, 'S4_port-old', old);
    const memory = { 'S1_port-live': { [old]: {} }, 'S4_port-old': { [old]: {} } };
    const result = cleanup.create({ db, fs, SERVER_CACHE_FILE: cache,
      appSettings: {}, dailyTraffic: memory, logger: { info() {}, error() {} }, logActivity() {} })
      .cleanupStalePortMappings();
    expect(result.skippedSrv).toEqual(['S4']);
    expect(db.prepare('SELECT port_name FROM daily_traffic ORDER BY port_name').all().map(r => r.port_name))
      .toEqual(['S1_port-live', 'S4_port-old']);
    expect(Object.keys(memory).sort()).toEqual(['S1_port-live', 'S4_port-old']);
    db.close(); fs.rmSync(dir, { recursive: true, force: true });
  });
});
