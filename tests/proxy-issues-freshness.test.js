import { describe, it, expect, vi, afterEach } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const createIssues = require('../src/services/proxy-issues').create;

afterEach(() => vi.useRealTimers());
describe('proxy issue freshness', () => {
  it('requires the latest ping to be failed and fresh', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-13T12:00:00Z'));
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE modem_ping(server TEXT,nick TEXT,ts TEXT,loss_pct REAL,ok INTEGER);
      CREATE TABLE known_modems(server_name TEXT,data TEXT,updated_at TEXT);
      CREATE TABLE modem_meta(server_name TEXT,nick TEXT,operator TEXT,updated_at TEXT);`);
    const insert = db.prepare('INSERT INTO modem_ping VALUES (?,?,?,?,?)');
    insert.run('S1', 'old', '2026-09-13T11:40:00Z', 100, 0);
    insert.run('S1', 'recovered', '2026-09-13T11:55:00Z', 100, 0);
    insert.run('S1', 'recovered', '2026-09-13T11:59:00Z', 0, 1);
    insert.run('S1', 'bad', '2026-09-13T11:59:00Z', 100, 0);
    const issues = createIssues({ db, appSettings: { proxy_alert_window_min: 60 }, logger: { error() {} } }).computeProxyIssues();
    expect(issues.map(i => i.nick)).toEqual(['bad']);
    db.close();
  });
});
