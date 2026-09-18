// FIX-05/06 + DEEP-12/13 (2026-09-18): сквозные тесты единой модели свежести
// нативных пингов ProxySmart — цепочка ingest → БД → computeProxyIssues →
// auto-reboot на настоящих модулях и SQLite, без подмены политики заглушками.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const pingMod = require('../src/jobs/modem-ping.js');
const issuesMod = require('../src/services/proxy-issues.js');
const rebootMod = require('../src/jobs/auto-reboot.js');

const NOW = Date.parse('2026-09-18T06:00:00.000Z');
let db;

function mkSchema() {
  db = new Database(':memory:');
  db.exec(`
    CREATE TABLE modem_ping (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL, server TEXT NOT NULL, nick TEXT NOT NULL,
      latency_ms INTEGER, loss_pct INTEGER, ok INTEGER, measured_at TEXT
    );
    CREATE TABLE modem_ping_state (
      server TEXT NOT NULL, nick TEXT NOT NULL, imei TEXT,
      quality TEXT NOT NULL, latency_ms INTEGER, loss_pct INTEGER, ok INTEGER,
      observed_at TEXT NOT NULL, measured_at TEXT, updated_at TEXT NOT NULL,
      PRIMARY KEY (server, nick)
    );
    CREATE TABLE known_modems (server_name TEXT, data TEXT, updated_at TEXT);
    CREATE TABLE modem_meta (server_name TEXT, nick TEXT, operator TEXT, updated_at TEXT);
    CREATE TABLE auto_reboot_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      server_name TEXT, nick TEXT, imei TEXT, reason TEXT, status TEXT, error TEXT,
      rebooted_at TEXT DEFAULT (datetime('now'))
    );
  `);
}

function mkPing(settings = {}) {
  return pingMod.create({
    db,
    logger: { info() {}, warn() {}, error() {} },
    alerts: { trigger() {} },
    getSetting: (k, dflt) => (k in settings ? settings[k] : dflt),
  });
}

function mkIssues(appSettings = {}) {
  return issuesMod.create({
    db,
    appSettings: { proxy_alert_window_min: 60, proxy_alert_error_pct: 5, ping_loss_dead_pct: 100, ...appSettings },
    logger: { error() {} },
  }).computeProxyIssues;
}

// auto-reboot с управляемым fetchAllServersDataCached (Promise-барьер, без sleep)
function mkReboot({ computeProxyIssues, fetchAllServersDataCached, appSettings = {} }) {
  const calls = { reboots: [], activity: [] };
  const job = rebootMod.create({
    db,
    appSettings: {
      auto_reboot_enabled: true,
      random_modem_reboot_enabled: false,
      auto_reboot_min_interval_min: 60,
      ...appSettings,
    },
    logger: { info() {}, warn() {}, error() {} },
    logActivity: (...a) => calls.activity.push(a),
    computeProxyIssues,
    fetchAllServersDataCached,
    findServer: (name) => ({ name }),
    fetchApi: async (server, path) => { calls.reboots.push({ server: server.name, path }); return {}; },
  });
  return { job, calls };
}

function statusEntry(imei, nick, pingStats, online = 'yes') {
  return {
    modem_details: { IMEI: imei, NICK: nick },
    net_details: { IS_ONLINE: online, ping_stats: pingStats },
  };
}

const liveFeed = (imei, nick) => async () => [{
  serverName: 'S1',
  status: [{ modem_details: { IMEI: imei, NICK: nick }, net_details: {} }],
}];

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); mkSchema(); });
afterEach(() => { vi.useRealTimers(); db.close(); });

describe('DEEP-12: missing/invalid инвалидирует текущее состояние в БД', () => {
  it('failed → missing: кандидат на reboot исчезает, в т.ч. после пересоздания job', () => {
    const ping = mkPing();
    const computeProxyIssues = mkIssues();
    ping.ingest('S1', [statusEntry('i1', 'M', '900ms, 100% loss')], NOW - 60000);
    ping.ingest('S1', [statusEntry('i1', 'M', '900ms, 100% loss')], NOW);
    expect(computeProxyIssues().map(i => i.nick)).toEqual(['M']);   // dead-кандидат есть

    ping.ingest('S1', [statusEntry('i1', 'M', '')], NOW + 60000);   // ping_stats пропал
    expect(ping.alive('S1', 'i1')).toBeNull();
    const st = db.prepare('SELECT quality, ok FROM modem_ping_state WHERE server=? AND nick=?').get('S1', 'M');
    expect(st).toMatchObject({ quality: 'missing', ok: null });
    // Старая failed-строка истории больше не держит кандидата
    expect(computeProxyIssues()).toEqual([]);

    // То же после «рестарта»: новая память, та же БД
    const ping2 = mkPing();
    expect(ping2.alive('S1', 'i1')).toBeNull();
    expect(mkIssues()()).toEqual([]);
  });

  it('битый ping_stats → quality=invalid, текущий результат unknown', () => {
    const ping = mkPing();
    ping.ingest('S1', [statusEntry('i1', 'M', '20ms, 0% loss')], NOW);
    ping.ingest('S1', [statusEntry('i1', 'M', 'garbage!')], NOW + 60000);
    expect(ping.alive('S1', 'i1')).toBeNull();
    expect(db.prepare('SELECT quality FROM modem_ping_state').get()).toMatchObject({ quality: 'invalid' });
    expect(mkIssues()()).toEqual([]);
    // В историю недостоверные наблюдения не пишутся — проценты не размываются
    expect(db.prepare('SELECT COUNT(*) n FROM modem_ping').get().n).toBe(1);
  });
});

describe('DEEP-13: dead-порог не привязан к порогу качества', () => {
  it('постоянные 40% потерь при dead=100% и errLimit=5% — degraded в списке, reboot не вызывается', async () => {
    const ping = mkPing();
    const computeProxyIssues = mkIssues();
    for (let i = 4; i >= 0; i--) {
      ping.ingest('S1', [statusEntry('i1', 'M', '300ms, 40% loss')], NOW - i * 60000);
    }
    const issues = computeProxyIssues();
    expect(issues.length).toBe(1);
    expect(issues[0]).toMatchObject({ nick: 'M', dead: false, severity: 'degraded', errorPct: 40 });

    const { job, calls } = mkReboot({ computeProxyIssues, fetchAllServersDataCached: liveFeed('i1', 'M') });
    await job.runAutoReboot();
    expect(calls.reboots).toEqual([]);
  });
});

describe('FIX-05: auto-reboot только по подтверждённому устойчивому отказу', () => {
  it('устойчивый свежий dead → reboot выполняется и логируется', async () => {
    const ping = mkPing();
    const computeProxyIssues = mkIssues();
    ping.ingest('S1', [statusEntry('i1', 'M', '900ms, 100% loss')], NOW - 60000);
    ping.ingest('S1', [statusEntry('i1', 'M', '900ms, 100% loss')], NOW);
    const { job, calls } = mkReboot({ computeProxyIssues, fetchAllServersDataCached: liveFeed('i1', 'M') });
    await job.runAutoReboot();
    expect(calls.reboots).toEqual([{ server: 'S1', path: '/apix/reboot_modem_by_imei?IMEI=i1' }]);
    expect(db.prepare('SELECT status FROM auto_reboot_log').all()).toEqual([{ status: 'success' }]);
  });

  it('восстановление во время IMEI-lookup отменяет reboot (Promise-барьер)', async () => {
    const ping = mkPing();
    const computeProxyIssues = mkIssues();
    ping.ingest('S1', [statusEntry('i1', 'M', '900ms, 100% loss')], NOW - 60000);
    ping.ingest('S1', [statusEntry('i1', 'M', '900ms, 100% loss')], NOW);

    let release;
    const barrier = new Promise(res => { release = res; });
    const feed = async () => { await barrier; return liveFeed('i1', 'M')(); };
    const rb = mkReboot({ computeProxyIssues, fetchAllServersDataCached: feed });
    const calls = rb.calls;
    const run = rb.job.runAutoReboot();
    // Пока lookup висит на барьере, модем восстановился
    ping.ingest('S1', [statusEntry('i1', 'M', '20ms, 0% loss')], NOW + 30000);
    release();
    await run;
    expect(calls.reboots).toEqual([]);
    expect(db.prepare('SELECT COUNT(*) n FROM auto_reboot_log').get().n).toBe(0);
  });

  it('одиночный failed-замер (без устойчивости) reboot не вызывает', async () => {
    const ping = mkPing();
    const computeProxyIssues = mkIssues();
    ping.ingest('S1', [statusEntry('i1', 'M', '900ms, 100% loss')], NOW);
    const { job, calls } = mkReboot({ computeProxyIssues, fetchAllServersDataCached: liveFeed('i1', 'M') });
    await job.runAutoReboot();
    expect(calls.reboots).toEqual([]);
  });

  it('протухшее состояние (опрос прекратился) — нет кандидата и reboot', async () => {
    const ping = mkPing();
    ping.ingest('S1', [statusEntry('i1', 'M', '900ms, 100% loss')], NOW - 25 * 3600000);
    ping.ingest('S1', [statusEntry('i1', 'M', '900ms, 100% loss')], NOW - 24 * 3600000);
    expect(ping.alive('S1', 'i1')).toBeNull();           // TTL истёк на чтении
    expect(mkIssues()()).toEqual([]);
    const { job, calls } = mkReboot({ computeProxyIssues: mkIssues(), fetchAllServersDataCached: liveFeed('i1', 'M') });
    await job.runAutoReboot();
    expect(calls.reboots).toEqual([]);
  });

  it('timestamp из будущего недостоверен — кандидата нет', () => {
    const future = new Date(NOW + 3600000).toISOString();
    db.prepare(`INSERT INTO modem_ping_state (server,nick,imei,quality,latency_ms,loss_pct,ok,observed_at,measured_at,updated_at)
                VALUES ('S1','M','i1','valid',900,100,0,?,NULL,?)`).run(future, future);
    db.prepare(`INSERT INTO modem_ping (ts,server,nick,latency_ms,loss_pct,ok) VALUES (?,'S1','M',900,100,0)`).run(future);
    db.prepare(`INSERT INTO modem_ping (ts,server,nick,latency_ms,loss_pct,ok) VALUES (?,'S1','M',900,100,0)`).run(future);
    expect(mkIssues()()).toEqual([]);
  });
});

describe('FIX-SPEC §16.2: клоны IMEI', () => {
  it('одинаковый IMEI у разных nick: слоты не затирают друг друга, alive консервативен', () => {
    const ping = mkPing();
    ping.ingest('S1', [statusEntry('i1', 'M1', '20ms, 0% loss')], NOW);
    ping.ingest('S1', [statusEntry('i1', 'M2', '900ms, 100% loss')], NOW);
    // Оба слота видны в latest по своим nick
    const snap = ping.latest();
    expect(snap.S1_M1).toMatchObject({ ok: true, fresh: true });
    expect(snap.S1_M2).toMatchObject({ ok: false, fresh: true });
    // Свежий отказ любого слота с этим IMEI → модем «не жив»
    expect(ping.alive('S1', 'i1')).toBe(false);
    // Оба слота молчат → не влияем
    ping.ingest('S1', [statusEntry('i1', 'M1', '')], NOW + 60000);
    ping.ingest('S1', [statusEntry('i1', 'M2', '')], NOW + 60000);
    expect(ping.alive('S1', 'i1')).toBeNull();
  });
});
