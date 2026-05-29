// Stage 19 — failover engine unit tests.
//
// The engine is dependency-injected, so we test it in isolation with an
// in-memory SQLite + fake ProxySmart helpers (recording calls) rather than
// booting the whole app. Covers: spare selection, the move_port teleport,
// and the auto-mode safeguards (disabled / dry-run / cooldown / rate-limit /
// no-spare).

import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { createRequire } from 'module';

const cjsRequire = createRequire(import.meta.url);

function freshEngine() {
  // Re-require fresh each time so module-level cooldown/rate state resets.
  delete cjsRequire.cache[cjsRequire.resolve('../src/jobs/failover.js')];
  return cjsRequire('../src/jobs/failover.js');
}

function makeDeps(overrides) {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE failover_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT DEFAULT (datetime('now')),
    server_name TEXT, client_port_name TEXT, dead_imei TEXT, dead_nick TEXT,
    dead_port_id TEXT, spare_imei TEXT, spare_nick TEXT, mode TEXT,
    trigger_reason TEXT, result TEXT, error TEXT, dry_run INTEGER DEFAULT 0);
    CREATE TABLE proxy_checks (id INTEGER PRIMARY KEY, server_name TEXT, nick TEXT, error TEXT, total_ms INTEGER, checked_at TEXT);`);

  const nowIso = new Date().toISOString();
  // knownModems: DEAD (bound, has client port) + SPARE (unbound, online) + BUSY (bound)
  const knownModems = {
    S2: {
      'portDEAD':  { imei: 'IMEI_DEAD',  nick: 'RO_DEAD',  portName: 'WildBox' },
      'portSPARE': { imei: 'IMEI_SPARE', nick: 'RO_SPARE', portName: '' },
      'portBUSY':  { imei: 'IMEI_BUSY',  nick: 'RO_BUSY',  portName: 'OtherClient' },
    },
  };
  const uptimeTracking = {
    'S2_IMEI_DEAD':  { total_checks: 100, online_checks: 90, last_online_check: new Date(Date.now() - 60*60*1000).toISOString() }, // offline 60 min
    'S2_IMEI_SPARE': { total_checks: 100, online_checks: 99, last_online_check: nowIso }, // online now
    'S2_IMEI_BUSY':  { total_checks: 100, online_checks: 99, last_online_check: nowIso },
  };
  const calls = { editPort: [], applyPort: [] };

  // LIVE data (Stage 19.1) — spares are discovered from here, NOT known_modems.
  // SPARE is online + unbound; BUSY is online + bound; DEAD is offline + bound.
  function liveData() {
    return [{
      serverName: 'S2',
      status: [
        { modem_details: { IMEI: 'IMEI_SPARE', NICK: 'RO_SPARE' }, net_details: { IS_ONLINE: 'yes' } },
        { modem_details: { IMEI: 'IMEI_BUSY',  NICK: 'RO_BUSY'  }, net_details: { IS_ONLINE: 'yes' } },
        { modem_details: { IMEI: 'IMEI_DEAD',  NICK: 'RO_DEAD'  }, net_details: { IS_ONLINE: 'no'  } },
      ],
      ports: {
        // bound ports carry a non-empty portName; spare has none
        'IMEI_BUSY': [{ portID: 'portBUSY', portName: 'OtherClient' }],
        'IMEI_DEAD': [{ portID: 'portDEAD', portName: 'WildBox' }],
      },
    }];
  }

  const deps = {
    logger: { info(){}, warn(){}, error(){}, debug(){} },
    db,
    appSettings: { failover_enabled: true, failover_dry_run: false, failover_offline_min: 15, failover_cooldown_h: 6, failover_max_per_hour: 5 },
    apiServers: [{ name: 'S2' }],
    findServer: (n) => (n === 'S2' ? { name: 'S2' } : null),
    fetchAllServersDataCached: async () => liveData(),
    // Mirror server.js mergeServerData: prefix IMEIs S<n>_, stamp _server,
    // re-key ports by prefixed imei. The engine's spare discovery consumes
    // this merged shape (same as the Модемы table).
    mergeServerData: (all) => {
      const status = [], ports = {};
      (all || []).forEach(d => {
        const pre = d.serverName + '_';
        (d.status || []).forEach(s => {
          status.push({ ...s, _server: d.serverName, modem_details: { ...s.modem_details, IMEI: pre + s.modem_details.IMEI } });
        });
        Object.entries(d.ports || {}).forEach(([imei, list]) => { ports[pre + imei] = list; });
      });
      return { status, ports };
    },
    knownModems,
    uptimeTracking,
    getStaleNicks: () => new Set(),
    fetchApiRaw: async () => ({ buffer: Buffer.from('<input name="portName" value="WildBox"><input name="http_port" value="8001">') }),
    parseHtmlInputFields: () => ({ portName: 'WildBox', http_port: '8001', IMEI: 'IMEI_DEAD' }),
    fetchApi: async (server, path) => {
      if (path.startsWith('/apix/apply_port')) { calls.applyPort.push(path); return {}; }
      if (path === '/apix/list_ports_json') return {};
      return {};
    },
    postFormApi: async (server, path, formData) => { calls.editPort.push({ path, IMEI: formData.IMEI }); return {}; },
    proxySmart: { invalidateCache(){} },
    logActivity: () => {},
    alerts: { trigger: () => true },
    _calls: calls,
  };
  Object.assign(deps, overrides || {});
  return deps;
}

describe('failover engine', () => {
  it('findSpare picks the healthy unbound online modem', async () => {
    const eng = freshEngine();
    const deps = makeDeps();
    eng.init(deps);
    const spare = await eng.findSpare('S2', new Set(['IMEI_DEAD']));
    expect(spare).toBeTruthy();
    expect(spare.imei).toBe('IMEI_SPARE');  // not BUSY (bound), not DEAD (excluded)
  });

  it('findSpare returns null when no unbound online modem', async () => {
    const eng = freshEngine();
    const deps = makeDeps();
    // Live data: mark the only spare as bound → no spares left.
    deps.fetchAllServersDataCached = async () => ([{
      serverName: 'S2',
      status: [{ modem_details: { IMEI: 'IMEI_SPARE', NICK: 'RO_SPARE' }, net_details: { IS_ONLINE: 'yes' } }],
      ports: { 'IMEI_SPARE': [{ portID: 'p', portName: 'SomeClient' }] },
    }]);
    eng.init(deps);
    expect(await eng.findSpare('S2', new Set(['IMEI_DEAD']))).toBeNull();
  });

  it('excludes an unstable modem from spares (uptime below threshold)', async () => {
    const eng = freshEngine();
    const deps = makeDeps();
    // SPARE is the only candidate — make it flappy (50% uptime, enough samples).
    deps.uptimeTracking['S2_IMEI_SPARE'] = { total_checks: 100, online_checks: 50, last_online_check: new Date().toISOString() };
    eng.init(deps);
    expect(await eng.findSpare('S2', new Set(['IMEI_DEAD']))).toBeNull();  // flappy spare not offered
  });

  it('still offers a spare with too few samples to judge (benefit of the doubt)', async () => {
    const eng = freshEngine();
    const deps = makeDeps();
    // Low ratio BUT only 4 checks → not enough to condemn it → still eligible.
    deps.uptimeTracking['S2_IMEI_SPARE'] = { total_checks: 4, online_checks: 1, last_online_check: new Date().toISOString() };
    eng.init(deps);
    const spare = await eng.findSpare('S2', new Set(['IMEI_DEAD']));
    expect(spare && spare.imei).toBe('IMEI_SPARE');
  });

  it('manualFailover executes move_port: edit_port IMEI swap + apply_port + logs ok', async () => {
    const eng = freshEngine();
    const deps = makeDeps();
    eng.init(deps);
    const res = await eng.manualFailover('S2', 'IMEI_DEAD', 'RO_DEAD');
    expect(res.ok).toBe(true);
    expect(deps._calls.editPort.length).toBe(1);
    expect(deps._calls.editPort[0].IMEI).toBe('IMEI_SPARE'); // teleported to spare
    expect(deps._calls.applyPort.length).toBe(1);
    const row = deps.db.prepare("SELECT * FROM failover_log WHERE result='ok'").get();
    expect(row).toBeTruthy();
    expect(row.spare_nick).toBe('RO_SPARE');
    expect(row.dry_run).toBe(0);
  });

  it('auto scan does nothing when failover_enabled=false', async () => {
    const eng = freshEngine();
    const deps = makeDeps({ appSettings: { failover_enabled: false } });
    eng.init(deps);
    await eng.scanAndFailover();
    expect(deps._calls.editPort.length).toBe(0);
    expect(deps.db.prepare('SELECT COUNT(*) c FROM failover_log').get().c).toBe(0);
  });

  it('auto scan in dry-run logs intent but does NOT move', async () => {
    const eng = freshEngine();
    const deps = makeDeps({ appSettings: { failover_enabled: true, failover_dry_run: true, failover_offline_min: 15, failover_cooldown_h: 6, failover_max_per_hour: 5 } });
    eng.init(deps);
    await eng.scanAndFailover();
    expect(deps._calls.editPort.length).toBe(0);  // no real move
    const row = deps.db.prepare("SELECT * FROM failover_log WHERE result='dry_run'").get();
    expect(row).toBeTruthy();
    expect(row.dry_run).toBe(1);
    expect(row.spare_nick).toBe('RO_SPARE');
  });

  it('auto scan executes real move for hard-offline client modem', async () => {
    const eng = freshEngine();
    const deps = makeDeps(); // enabled, dry_run false, DEAD is offline 60min
    eng.init(deps);
    await eng.scanAndFailover();
    expect(deps._calls.editPort.length).toBe(1);
    expect(deps._calls.editPort[0].IMEI).toBe('IMEI_SPARE');
    expect(deps.db.prepare("SELECT COUNT(*) c FROM failover_log WHERE result='ok'").get().c).toBe(1);
  });

  it('cooldown blocks a second auto-failover of the same modem', async () => {
    const eng = freshEngine();
    const deps = makeDeps();
    eng.init(deps);
    await eng.scanAndFailover();              // first move ok
    const after1 = deps._calls.editPort.length;
    // DEAD is still offline; spare still there (test knownModems unchanged) → but cooldown should block
    await eng.scanAndFailover();
    expect(deps._calls.editPort.length).toBe(after1); // no additional move
  });

  describe('glitch detection: N consecutive failures (not error% over a window)', () => {
    const insChecks = (db, nick, seq) => {
      // seq newest-first: true = error, false = ok. Spaced 1 min apart, most recent now.
      const ins = db.prepare('INSERT INTO proxy_checks (server_name, nick, error, total_ms, checked_at) VALUES (?,?,?,?,?)');
      const now = Date.now();
      seq.forEach((bad, i) => ins.run('S2', nick, bad ? 'boom' : null, bad ? null : 800, new Date(now - i * 60 * 1000).toISOString()));
    };

    it('fires when the last 3 checks all errored', () => {
      const eng = freshEngine(); const deps = makeDeps(); eng.init(deps);
      insChecks(deps.db, 'RO_X', [true, true, true, false, false]);  // XXXoo (newest-first)
      expect(eng._consecutiveFailGlitch('S2', 'RO_X', 3)).toBeTruthy();
    });

    it('does NOT fire on a single recent blip (the 83%-false-positive case)', () => {
      const eng = freshEngine(); const deps = makeDeps(); eng.init(deps);
      insChecks(deps.db, 'RO_X', [true, false, true, true, true]);  // XoXXX — newest ok breaks the streak
      expect(eng._consecutiveFailGlitch('S2', 'RO_X', 3)).toBeNull();
    });

    it('does NOT fire on slow-but-successful checks (latency is ignored)', () => {
      const eng = freshEngine(); const deps = makeDeps(); eng.init(deps);
      const ins = deps.db.prepare('INSERT INTO proxy_checks (server_name, nick, error, total_ms, checked_at) VALUES (?,?,?,?,?)');
      const now = Date.now();
      // 3 consecutive unusably-slow (9s) but ERROR-FREE checks → must NOT trigger.
      [9000, 9000, 9000].forEach((ms, i) => ins.run('S2', 'RO_X', null, ms, new Date(now - i * 60000).toISOString()));
      expect(eng._consecutiveFailGlitch('S2', 'RO_X', 3)).toBeNull();
    });

    it('ignores stale data (most recent check older than 90 min)', () => {
      const eng = freshEngine(); const deps = makeDeps(); eng.init(deps);
      const ins = deps.db.prepare('INSERT INTO proxy_checks (server_name, nick, error, total_ms, checked_at) VALUES (?,?,?,?,?)');
      const old = Date.now() - 3 * 3600 * 1000;
      for (let i = 0; i < 3; i++) ins.run('S2', 'RO_X', 'boom', null, new Date(old - i * 60000).toISOString());
      expect(eng._consecutiveFailGlitch('S2', 'RO_X', 3)).toBeNull();
    });

    it('previewCandidates never offers one spare to two modems', async () => {
      const eng = freshEngine(); const deps = makeDeps(); eng.init(deps);
      // BUSY is online+bound → make it glitchy (3 consecutive errors). DEAD is
      // offline 60 min → hard_offline. Only ONE spare (SPARE) exists.
      insChecks(deps.db, 'RO_BUSY', [true, true, true]);
      const cand = await eng.previewCandidates();
      const dead = cand.find(c => c.nick === 'RO_DEAD');
      const busy = cand.find(c => c.nick === 'RO_BUSY');
      expect(dead.spare).toBe('RO_SPARE');        // the only spare goes to the first candidate
      expect(busy.reason).toBe('glitch_errors');
      expect(busy.spare).toBeNull();              // NOT RO_SPARE again — no double-book in the preview
    });
  });

  it('does not reuse a just-assigned spare for a second modem (RO2_30 double-book regression)', async () => {
    const eng = freshEngine();
    const deps = makeDeps();
    eng.init(deps);
    // First failover consumes the only spare (DEAD → SPARE), real move.
    const r1 = await eng.manualFailover('S2', 'IMEI_DEAD', 'RO_DEAD');
    expect(r1.ok).toBe(true);
    expect(deps._calls.editPort.length).toBe(1);
    expect(deps._calls.editPort[0].IMEI).toBe('IMEI_SPARE');
    const after1 = deps._calls.editPort.length;
    // Second failover of a DIFFERENT modem against the SAME (cached, unchanged)
    // snapshot — SPARE still looks free, but the guard must refuse to reuse it,
    // otherwise both clients would share one modem (the live RO2_30 bug).
    const r2 = await eng.manualFailover('S2', 'IMEI_BUSY', 'RO_BUSY');
    expect(r2.ok).toBe(true);
    expect(deps._calls.editPort.length).toBe(after1);   // NO second move — spare not reused
    expect(deps.db.prepare("SELECT COUNT(*) c FROM failover_log WHERE result='skipped_no_spare'").get().c).toBe(1);
  });

  it('scanAndFailover skips a second concurrent pass (P0-3 re-entrancy guard)', async () => {
    const eng = freshEngine();
    const deps = makeDeps();
    let release;
    const gate = new Promise(r => { release = r; });
    let fetches = 0;
    deps.fetchAllServersDataCached = async () => { fetches++; await gate; return []; };
    eng.init(deps);
    const p1 = eng.scanAndFailover();             // hangs inside _getMerged
    await new Promise(r => setTimeout(r, 5));
    await eng.scanAndFailover();                   // must bail out immediately
    expect(fetches).toBe(1);                       // second pass never fetched
    release();
    await p1;
    await eng.scanAndFailover();                   // guard released → runs again
    expect(fetches).toBe(2);
  });

  it('serializes concurrent failover of the same modem (P1-4 per-IMEI lock)', async () => {
    const eng = freshEngine();
    const deps = makeDeps();
    let release;
    const gate = new Promise(r => { release = r; });
    deps.postFormApi = async (server, path, formData) => {
      deps._calls.editPort.push({ path, IMEI: formData.IMEI });
      await gate;                                   // hold the move open
      return {};
    };
    eng.init(deps);
    const p1 = eng.manualFailover('S2', 'IMEI_DEAD', 'RO_DEAD');  // takes the lock
    await new Promise(r => setTimeout(r, 5));
    const r2 = await eng.manualFailover('S2', 'IMEI_DEAD', 'RO_DEAD');  // blocked
    expect(r2.ok).toBe(false);
    expect(r2.error).toBe('already moving');
    release();
    const r1 = await p1;
    expect(r1.ok).toBe(true);
    expect(deps._calls.editPort.length).toBe(1);   // exactly one move executed
  });

  it('no-spare path logs skipped_no_spare', async () => {
    const eng = freshEngine();
    const deps = makeDeps();
    // Live data: only DEAD exists (offline, bound) — no spare available.
    deps.fetchAllServersDataCached = async () => ([{
      serverName: 'S2',
      status: [{ modem_details: { IMEI: 'IMEI_DEAD', NICK: 'RO_DEAD' }, net_details: { IS_ONLINE: 'no' } }],
      ports: { 'IMEI_DEAD': [{ portID: 'portDEAD', portName: 'WildBox' }] },
    }]);
    eng.init(deps);
    const res = await eng.manualFailover('S2', 'IMEI_DEAD', 'RO_DEAD');
    expect(res.ok).toBe(true);
    expect(deps._calls.editPort.length).toBe(0);
    const row = deps.db.prepare("SELECT * FROM failover_log WHERE result='skipped_no_spare'").get();
    expect(row).toBeTruthy();
  });
});
