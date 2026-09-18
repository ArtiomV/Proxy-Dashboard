import { describe, it, expect, vi, afterEach } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const createIssues = require('../src/services/proxy-issues').create;

// FIX-05/06 + DEEP-12/13 (2026-09-18): текущий статус и reboot-кандидаты
// читаются из modem_ping_state; история modem_ping — только валидные замеры
// для окна. Строки со stale/missing/invalid наблюдением не дают кандидатов.
function mkDb() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE modem_ping(server TEXT,nick TEXT,ts TEXT,loss_pct REAL,ok INTEGER,measured_at TEXT);
    CREATE TABLE modem_ping_state(server TEXT,nick TEXT,imei TEXT,quality TEXT,latency_ms INTEGER,loss_pct REAL,ok INTEGER,observed_at TEXT,measured_at TEXT,updated_at TEXT,PRIMARY KEY(server,nick));
    CREATE TABLE known_modems(server_name TEXT,data TEXT,updated_at TEXT);
    CREATE TABLE modem_meta(server_name TEXT,nick TEXT,operator TEXT,updated_at TEXT);`);
  return db;
}
const insHist = (db, nick, ts, loss, ok) =>
  db.prepare('INSERT INTO modem_ping VALUES (?,?,?,?,?,NULL)').run('S1', nick, ts, loss, ok);
const insState = (db, nick, quality, loss, ok, observedAt) =>
  db.prepare('INSERT INTO modem_ping_state (server,nick,imei,quality,latency_ms,loss_pct,ok,observed_at,measured_at,updated_at) VALUES (?,?,?,?,?,?,?,?,NULL,?)')
    .run('S1', nick, 'i_' + nick, quality, null, loss, ok, observedAt, observedAt);

afterEach(() => vi.useRealTimers());
describe('proxy issue freshness', () => {
  it('requires a fresh valid current state; stale and recovered are excluded', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-13T12:00:00Z'));
    const db = mkDb();
    // old: свежих наблюдений нет — state протух (20 мин > TTL 10)
    insHist(db, 'old', '2026-09-13T11:40:00Z', 100, 0);
    insState(db, 'old', 'valid', 100, 0, '2026-09-13T11:40:00Z');
    // recovered: в окне были провалы, но текущий замер свежий и успешный
    insHist(db, 'recovered', '2026-09-13T11:55:00Z', 100, 0);
    insHist(db, 'recovered', '2026-09-13T11:59:00Z', 0, 1);
    insState(db, 'recovered', 'valid', 0, 1, '2026-09-13T11:59:00Z');
    // bad: свежий подтверждённый dead (последний замер 100%, ≥2 failed за TTL)
    insHist(db, 'bad', '2026-09-13T11:58:00Z', 100, 0);
    insHist(db, 'bad', '2026-09-13T11:59:00Z', 100, 0);
    insState(db, 'bad', 'valid', 100, 0, '2026-09-13T11:59:00Z');
    const issues = createIssues({ db, appSettings: { proxy_alert_window_min: 60 }, logger: { error() {} } }).computeProxyIssues();
    expect(issues.map(i => i.nick)).toEqual(['bad']);
    expect(issues[0]).toMatchObject({ dead: true, severity: 'dead', errorPct: 100 });
    db.close();
  });

  it('DEEP-13: свежие 40% потерь при dead=100% — degraded, а не «нет проблемы»', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-13T12:00:00Z'));
    const db = mkDb();
    for (let m = 50; m <= 59; m += 3) insHist(db, 'flaky', `2026-09-13T11:${m}:00Z`, 40, 1);
    insState(db, 'flaky', 'valid', 40, 1, '2026-09-13T11:59:00Z');
    const issues = createIssues({ db, appSettings: { proxy_alert_window_min: 60, proxy_alert_error_pct: 5 }, logger: { error() {} } }).computeProxyIssues();
    expect(issues.length).toBe(1);
    expect(issues[0]).toMatchObject({ nick: 'flaky', dead: false, severity: 'degraded', errorPct: 40 });
    db.close();
  });

  it('одиночный failed-замер — не dead (нет устойчивости), но виден как degraded', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-13T12:00:00Z'));
    const db = mkDb();
    insHist(db, 'blip', '2026-09-13T11:59:00Z', 100, 0);
    insState(db, 'blip', 'valid', 100, 0, '2026-09-13T11:59:00Z');
    const issues = createIssues({ db, appSettings: { proxy_alert_window_min: 60 }, logger: { error() {} } }).computeProxyIssues();
    expect(issues.length).toBe(1);
    expect(issues[0].dead).toBe(false);
    db.close();
  });
});
