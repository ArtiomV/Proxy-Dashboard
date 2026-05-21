'use strict';
//
// src/routes/simulator.js — load-simulator HTTP surface (Stage 3).
//
// 19 routes covering: test-pool management, profile CRUD, run lifecycle,
// per-sample / per-modem / time-series reads, breaking-point detection,
// CSV+JSON export, SSE live stream. All admin-only.
//
// SQL for these routes was already extracted into src/db/simulator.js
// during Stage 2 — this file only owns the HTTP wrapping + the
// _resolveProxyUrls helper that maps target modems to live proxy URLs.

const express = require('express');

module.exports = function createSimulatorRouter(deps) {
  const {
    db, logger, authMiddleware, adminMiddleware,
    simulator, simulatorDb,
    fetchAllServersDataCached, SERVER_COUNTRIES,
    auditLog,
  } = deps;
  const r = express.Router();

// ─── Load Simulator ────────────────────────────────────────────────────────────
//
// Endpoints for the synthetic-load simulator. All admin-only.
// The engine is a singleton; only one run can be active at a time.

// Build {server,nick} → proxyUrl map from the live ProxySmart cache.
// Reused by /run (to resolve target modems before handing them to engine.start).
async function _resolveProxyUrls(targets) {
  const results = await fetchAllServersDataCached();
  const proxyMap = {};
  for (const data of results) {
    const srv = data.serverName || '';
    const sc = SERVER_COUNTRIES[srv] || {};
    const serverIp = sc.serverIp || '';
    if (!serverIp) continue;
    const statusArr = Array.isArray(data.status) ? data.status : [];
    const portsMap = data.ports || {};
    const nickByImei = {};
    for (const m of statusArr) {
      const md = m.modem_details || {};
      if (md.IMEI && md.NICK) nickByImei[md.IMEI] = md.NICK;
    }
    for (const [imei, portList] of Object.entries(portsMap)) {
      const nick = nickByImei[imei];
      if (!nick) continue;
      for (const p of portList) {
        if (!p.HTTP_PORT || !p.LOGIN || !p.PASSWORD) continue;
        proxyMap[nick + '|' + srv] = {
          server: srv, nick,
          proxyUrl: `http://${p.LOGIN}:${p.PASSWORD}@${serverIp}:${p.HTTP_PORT}`,
        };
        break;
      }
    }
  }
  const resolved = [];
  const missing = [];
  for (const t of targets) {
    const key = (t.nick || '') + '|' + (t.server || '');
    if (proxyMap[key]) resolved.push(proxyMap[key]);
    else missing.push(t);
  }
  return { resolved, missing };
}

// Toggle is_test_pool flag for a modem. Upserts modem_meta if needed.
r.post('/api/admin/modem/test-pool', authMiddleware, adminMiddleware, (req, res) => {
  try {
    const { server, nick, enabled } = req.body || {};
    if (!server || !nick) return res.status(400).json({ error: 'server и nick обязательны' });
    const want = simulatorDb.setTestPoolFlag(server, nick, enabled);
    auditLog(req.user.login, 'modem_test_pool_toggle', { server, nick, enabled: !!want });
    res.json({ ok: true, enabled: !!want });
  } catch (e) {
    logger.error('[Simulator/TestPool] toggle error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// All live modems across all servers, annotated with current is_test_pool flag.
// Used by the simulator page to manage the pool inline without jumping to the
// modem detail modal.
r.get('/api/admin/simulator/all-modems', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const pool = simulatorDb.testPoolKeySet();
    let live = [];
    try { live = await fetchAllServersDataCached(); } catch (e) { logger.warn('[Simulator/AllModems] fetchAllServersDataCached threw: ' + e.message); }
    const items = [];
    const seen = new Set();
    for (const data of live) {
      const srv = data.serverName || '';
      const downSet = new Set();
      // (We don't surface "server down" specifically — just per-modem online below.)
      for (const m of (data.status || [])) {
        const md = m.modem_details || {};
        const nick = md.NICK;
        if (!nick) continue;
        const key = srv + '|' + nick;
        if (seen.has(key)) continue;
        seen.add(key);
        const operatorRaw = (m.net_details && m.net_details.CELLOP) || '';
        const isOnline = !m._cached && m.net_details && m.net_details.IS_ONLINE === 'yes';
        items.push({
          server: srv,
          nick,
          imei: md.IMEI || '',
          operator: operatorRaw,
          model: md.MODEL_SHOWN || md.MODEL || '',
          phone: md.PHONE_NUMBER || '',
          online: !!isOnline,
          in_pool: pool.has(key),
        });
      }
    }
    // Also include modem_meta rows flagged in pool but not live (so they don't
    // silently disappear from the management UI).
    const ghostRows = simulatorDb.listTestPool();
    for (const g of ghostRows) {
      const key = g.server_name + '|' + g.nick;
      if (seen.has(key)) continue;
      items.push({
        server: g.server_name, nick: g.nick, imei: '',
        operator: g.operator || '', model: g.model || '', phone: g.phone || '',
        online: false, in_pool: true, _ghost: true,
      });
    }
    items.sort((a,b) => a.server.localeCompare(b.server) || a.nick.localeCompare(b.nick));
    res.json({ ok: true, items });
  } catch (e) {
    logger.error('[Simulator/AllModems] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// List all modems flagged is_test_pool=1, with live status info.
r.get('/api/admin/simulator/test-pool', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const flagged = simulatorDb.listTestPool();
    // Annotate with live status (online/offline) from cache so the UI can warn
    // if a flagged modem isn't currently reachable.
    let live = [];
    try { live = await fetchAllServersDataCached(); } catch (_) { /* best-effort: error intentionally swallowed */ }
    const liveByKey = {};
    for (const data of live) {
      const srv = data.serverName || '';
      for (const m of (data.status || [])) {
        const md = m.modem_details || {};
        if (md.NICK) liveByKey[md.NICK + '|' + srv] = { online: m.online !== false };
      }
    }
    const items = flagged.map(r => ({
      server: r.server_name, nick: r.nick, operator: r.operator,
      model: r.model, phone: r.phone,
      online: (liveByKey[r.nick + '|' + r.server_name] || {}).online === true,
    }));
    res.json({ ok: true, items });
  } catch (e) {
    logger.error('[Simulator/TestPool] list error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── Profiles CRUD ──────────────────────────────────────────────────────────
r.get('/api/admin/simulator/profiles', authMiddleware, adminMiddleware, (req, res) => {
  try {
    const rows = simulatorDb.listProfiles();
    const items = rows.map(r => ({
      id: r.id, name: r.name, description: r.description,
      config: JSON.parse(r.config_json), created_at: r.created_at,
      created_by: r.created_by, updated_at: r.updated_at,
    }));
    res.json({ ok: true, items });
  } catch (e) {
    logger.error('[Simulator/Profiles] list error:', e.message);
    res.status(500).json({ error: e.message });
  }
});
r.post('/api/admin/simulator/profiles', authMiddleware, adminMiddleware, (req, res) => {
  try {
    const { name, description, config } = req.body || {};
    if (!name || typeof name !== 'string') return res.status(400).json({ error: 'name обязателен' });
    if (!config || typeof config !== 'object') return res.status(400).json({ error: 'config обязателен' });
    const r = simulatorDb.createProfile({
      name, description, configJson: JSON.stringify(config), createdBy: req.user.login,
    });
    auditLog(req.user.login, 'sim_profile_create', { id: r.id, name });
    res.json({ ok: true, id: r.id });
  } catch (e) {
    if (/UNIQUE/i.test(e.message)) return res.status(409).json({ error: 'Профиль с таким именем уже есть' });
    logger.error('[Simulator/Profiles] create error:', e.message);
    res.status(500).json({ error: e.message });
  }
});
r.patch('/api/admin/simulator/profiles/:id', authMiddleware, adminMiddleware, (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { name, description, config } = req.body || {};
    const cur = simulatorDb.getProfile(id);
    if (!cur) return res.status(404).json({ error: 'Профиль не найден' });
    simulatorDb.updateProfile({
      id,
      name: name || cur.name,
      description: description != null ? description : cur.description,
      configJson: config ? JSON.stringify(config) : cur.config_json,
    });
    auditLog(req.user.login, 'sim_profile_update', { id });
    res.json({ ok: true });
  } catch (e) {
    logger.error('[Simulator/Profiles] update error:', e.message);
    res.status(500).json({ error: e.message });
  }
});
r.delete('/api/admin/simulator/profiles/:id', authMiddleware, adminMiddleware, (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const r = simulatorDb.deleteProfile(id);
    if (r.changes === 0) return res.status(404).json({ error: 'Профиль не найден' });
    auditLog(req.user.login, 'sim_profile_delete', { id });
    res.json({ ok: true });
  } catch (e) {
    logger.error('[Simulator/Profiles] delete error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── Runs ───────────────────────────────────────────────────────────────────
r.post('/api/admin/simulator/run', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    let profile = req.body && req.body.profile;
    const profileId = req.body && req.body.profile_id;
    if (!profile && profileId) {
      const row = simulatorDb.getProfileForRun(profileId);
      if (!row) return res.status(404).json({ error: 'Профиль не найден' });
      profile = { id: row.id, name: row.name, ...JSON.parse(row.config_json) };
    }
    if (!profile) return res.status(400).json({ error: 'Передайте profile или profile_id' });

    // Resolve proxy URLs for the target modems from the live cache.
    const { resolved, missing } = await _resolveProxyUrls(profile.target_modems || []);
    if (missing.length) {
      return res.status(400).json({
        error: 'Не удалось зарезолвить прокси для модемов',
        missing: missing.map(m => `${m.server}/${m.nick}`),
      });
    }

    const runId = simulator.start(profile, {
      resolvedModems: resolved,
      startedBy: req.user.login,
    });
    auditLog(req.user.login, 'sim_run_start', { run_id: runId, profile: profile.name });
    res.json({ ok: true, run_id: runId });
  } catch (e) {
    logger.error('[Simulator/Run] start error:', e.message);
    res.status(400).json({ error: e.message });
  }
});

r.post('/api/admin/simulator/run/:id/abort', authMiddleware, adminMiddleware, (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    simulator.abort(id);
    auditLog(req.user.login, 'sim_run_abort', { run_id: id });
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

r.get('/api/admin/simulator/active', authMiddleware, adminMiddleware, (req, res) => {
  res.json({ ok: true, active: simulator.getActive() });
});

r.get('/api/admin/simulator/runs', authMiddleware, adminMiddleware, (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 50, 500);
    const offset = Math.max(0, parseInt(req.query.offset) || 0);
    const rows = simulatorDb.listRuns({ limit, offset });
    const items = rows.map(r => ({
      id: r.id, profile_id: r.profile_id, profile_name: r.profile_name,
      started_at: r.started_at, ended_at: r.ended_at, status: r.status,
      summary: r.summary_json ? JSON.parse(r.summary_json) : null,
      started_by: r.started_by, error_msg: r.error_msg,
    }));
    res.json({ ok: true, items });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

r.get('/api/admin/simulator/run/:id', authMiddleware, adminMiddleware, (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const r = simulatorDb.getRun(id);
    if (!r) return res.status(404).json({ error: 'Run не найден' });
    res.json({
      ok: true, run: {
        id: r.id, profile_id: r.profile_id, profile_name: r.profile_name,
        started_at: r.started_at, ended_at: r.ended_at, status: r.status,
        config: JSON.parse(r.config_json),
        summary: r.summary_json ? JSON.parse(r.summary_json) : null,
        started_by: r.started_by, error_msg: r.error_msg,
      }
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

r.get('/api/admin/simulator/run/:id/samples', authMiddleware, adminMiddleware, (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const limit = Math.min(parseInt(req.query.limit) || 500, 5000);
    const offset = Math.max(0, parseInt(req.query.offset) || 0);
    const rows = simulatorDb.listSamples({ runId: id, limit, offset });
    const total = simulatorDb.countSamples(id);
    res.json({ ok: true, items: rows, total });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Per-modem aggregate: which modems hog the timeouts, which have the worst
// connect time, etc. Computed from all samples — for big runs the percentiles
// require sorting per-group so we cap at 100 modems (which would be a lot).
r.get('/api/admin/simulator/run/:id/by-modem', authMiddleware, adminMiddleware, (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    // We need percentiles per modem → can't do in pure SQL without window funcs.
    // Pull all sample rows (small per-run; bounded by duration × rps).
    const rows = simulatorDb.allSamplesForRun(id);
    const byKey = {};
    for (const r of rows) {
      const k = r.server_name + '|' + r.modem_nick;
      if (!byKey[k]) byKey[k] = {
        modem_nick: r.modem_nick, server_name: r.server_name,
        total: 0, success: 0, timeout: 0, http_error: 0, conn_error: 0,
        lats: [], connects: [], ttfbs: [],
      };
      const g = byKey[k];
      g.total++;
      g[r.status] = (g[r.status] || 0) + 1;
      g.lats.push(r.total_ms);
      if (r.connect_ms) g.connects.push(r.connect_ms);
      if (r.ttfb_ms) g.ttfbs.push(r.ttfb_ms);
    }
    const pct = (arr, p) => arr.length ? arr[Math.min(arr.length-1, Math.floor(arr.length*p))] : 0;
    const avg = (arr) => arr.length ? Math.round(arr.reduce((s,v)=>s+v,0) / arr.length) : 0;
    const items = Object.values(byKey).map(g => {
      g.lats.sort((a,b)=>a-b); g.connects.sort((a,b)=>a-b); g.ttfbs.sort((a,b)=>a-b);
      return {
        modem_nick: g.modem_nick, server_name: g.server_name,
        total: g.total,
        success_pct: g.total ? Math.round(g.success/g.total*1000)/10 : 0,
        timeout_pct: g.total ? Math.round(g.timeout/g.total*1000)/10 : 0,
        error_pct: g.total ? Math.round((g.http_error + g.conn_error)/g.total*1000)/10 : 0,
        p50_ms: pct(g.lats, 0.5),
        p95_ms: pct(g.lats, 0.95),
        avg_connect_ms: avg(g.connects),
        avg_ttfb_ms: avg(g.ttfbs),
      };
    });
    // Sort: worst timeout rate first — that's what the client cares about.
    items.sort((a,b) => b.timeout_pct - a.timeout_pct || b.p95_ms - a.p95_ms);
    res.json({ ok: true, items });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Time-bucketed series for charts (rps + P95 per N-second bucket).
// Defaults: 2-second buckets. Caps at 1200 buckets (40 min @ 2s).
r.get('/api/admin/simulator/run/:id/series', authMiddleware, adminMiddleware, (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const bucketSec = Math.max(1, Math.min(60, parseInt(req.query.bucket) || 2));
    const bucketMs = bucketSec * 1000;
    const rows = simulatorDb.samplesSeries(id);
    const buckets = {};
    for (const r of rows) {
      const b = Math.floor(r.ts_ms / bucketMs);
      if (!buckets[b]) buckets[b] = { count: 0, success: 0, timeout: 0, lats: [] };
      buckets[b].count++;
      if (r.status === 'success') buckets[b].success++;
      if (r.status === 'timeout') buckets[b].timeout++;
      buckets[b].lats.push(r.total_ms);
    }
    const keys = Object.keys(buckets).map(Number).sort((a,b)=>a-b);
    const series = keys.map(k => {
      const g = buckets[k];
      g.lats.sort((a,b)=>a-b);
      const p50 = g.lats.length ? g.lats[Math.floor(g.lats.length/2)] : 0;
      const p95 = g.lats.length ? g.lats[Math.min(g.lats.length-1, Math.floor(g.lats.length*0.95))] : 0;
      return {
        t_sec: k * bucketSec,
        rps: Math.round(g.count / bucketSec * 10) / 10,
        timeout_pct: g.count ? Math.round(g.timeout/g.count*1000)/10 : 0,
        p50_ms: p50,
        p95_ms: p95,
      };
    });
    res.json({ ok: true, bucket_sec: bucketSec, series });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Side-by-side comparison of multiple runs (max 5). Returns per-run summary + key metrics.
r.get('/api/admin/simulator/compare', authMiddleware, adminMiddleware, (req, res) => {
  try {
    const ids = String(req.query.run_ids || '').split(',').map(s => parseInt(s,10)).filter(Boolean).slice(0, 5);
    if (ids.length < 2) return res.status(400).json({ error: 'Передайте 2-5 run_ids' });
    const items = ids.map(id => {
      const r = simulatorDb.getRun(id);
      if (!r) return { id, error: 'not found' };
      const cfg = JSON.parse(r.config_json);
      const sum = r.summary_json ? JSON.parse(r.summary_json) : null;
      return {
        id: r.id, profile_name: r.profile_name, status: r.status,
        started_at: r.started_at, ended_at: r.ended_at,
        concurrency: cfg.concurrency, duration_ms: cfg.duration_ms, timeout_ms: cfg.timeout_ms,
        target_modems_count: (cfg.target_modems||[]).length,
        targets_count: (cfg.targets||[]).length,
        summary: sum,
      };
    });
    res.json({ ok: true, items });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Breaking-point detector for ramp runs: find the worker count at which
// timeout_pct first crosses 5% OR p95 doubles vs. the first stable bucket.
// Returns null if no breaking point (run was too short / stable throughout).
r.get('/api/admin/simulator/run/:id/breaking-point', authMiddleware, adminMiddleware, (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const run = simulatorDb.getRunConfigJson(id);
    if (!run) return res.status(404).json({ error: 'Run не найден' });
    const cfg = JSON.parse(run.config_json);
    if (!cfg.concurrency || cfg.concurrency.mode !== 'ramp') {
      return res.json({ ok: true, applicable: false, reason: 'Breaking-point detection works only on ramp runs' });
    }
    const start = cfg.concurrency.start || 1;
    const end = cfg.concurrency.end || 20;
    const rampSec = cfg.concurrency.ramp_seconds || 30;

    const rows = simulatorDb.samplesForBreakingPoint(id);
    if (rows.length < 10) return res.json({ ok: true, applicable: true, breaking_point: null, reason: 'Слишком мало сэмплов' });

    // Bucket every 2 seconds → compute timeout_pct and P95
    const bucketMs = 2000;
    const buckets = {};
    for (const r of rows) {
      const b = Math.floor(r.ts_ms / bucketMs);
      if (!buckets[b]) buckets[b] = { count: 0, timeout: 0, lats: [] };
      buckets[b].count++;
      if (r.status === 'timeout') buckets[b].timeout++;
      buckets[b].lats.push(r.total_ms);
    }
    const keys = Object.keys(buckets).map(Number).sort((a,b)=>a-b);
    // Use first 3 buckets as baseline (assumes stable behavior at start of ramp)
    const baseline = keys.slice(0, 3).map(k => {
      const g = buckets[k];
      g.lats.sort((a,b)=>a-b);
      return { p95: g.lats[Math.floor(g.lats.length*0.95)] || 0, to: g.count ? g.timeout/g.count : 0 };
    });
    const baseP95 = Math.max(1, baseline.reduce((s,b)=>s+b.p95,0) / Math.max(1, baseline.length));

    // Scan forward — flag first bucket where:
    //   timeout_pct >= 5%  OR  p95 >= 2x baseline_p95
    let bpBucket = null;
    for (const k of keys.slice(3)) {
      const g = buckets[k];
      g.lats.sort((a,b)=>a-b);
      const p95 = g.lats[Math.floor(g.lats.length*0.95)] || 0;
      const to = g.count ? g.timeout/g.count : 0;
      if (to >= 0.05 || p95 >= baseP95 * 2) {
        bpBucket = { t_sec: k * (bucketMs/1000), p95_ms: p95, timeout_pct: Math.round(to*1000)/10, base_p95_ms: Math.round(baseP95) };
        break;
      }
    }
    let bpWorkers = null;
    if (bpBucket) {
      // Convert ramp time back to worker count: at t_sec into the ramp,
      // workers = start + (end-start) * t_sec / rampSec  (clamped at end after rampSec)
      if (bpBucket.t_sec >= rampSec) bpWorkers = end;
      else bpWorkers = Math.round(start + (end - start) * (bpBucket.t_sec / rampSec));
      bpBucket.workers = bpWorkers;
    }
    res.json({ ok: true, applicable: true, breaking_point: bpBucket, baseline_p95_ms: Math.round(baseP95) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// CSV / JSON export of samples for a run.
r.get('/api/admin/simulator/run/:id/export', authMiddleware, adminMiddleware, (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const format = (req.query.format || 'json').toLowerCase();
    const rows = simulatorDb.exportSamples(id);
    if (format === 'csv') {
      const cols = ['ts_ms','worker_id','modem_nick','server_name','status','http_status',
                    'total_ms','connect_ms','ttfb_ms','bytes','url','error_msg'];
      const esc = (v) => {
        if (v == null) return '';
        const s = String(v);
        return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
      };
      const lines = [cols.join(',')].concat(rows.map(r => cols.map(c => esc(r[c])).join(',')));
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="simulator-run-${id}.csv"`);
      res.send(lines.join('\n'));
    } else {
      res.setHeader('Content-Disposition', `attachment; filename="simulator-run-${id}.json"`);
      res.json({ ok: true, run_id: id, samples: rows });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// SSE: live event stream for a specific run.
r.get('/api/admin/simulator/run/:id/stream', authMiddleware, adminMiddleware, (req, res) => {
  const id = parseInt(req.params.id, 10);
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders && res.flushHeaders();
  const send = (event) => {
    try { res.write(`data: ${JSON.stringify(event)}\n\n`); } catch (_) { /* best-effort: error intentionally swallowed */ }
  };
  // Heartbeat to detect dead clients (and prevent NGINX idle close).
  const hb = setInterval(() => { try { res.write(': hb\n\n'); } catch (_) { /* best-effort: error intentionally swallowed */ } }, 25000);
  const unsub = simulator.subscribe(id, send);
  req.on('close', () => { clearInterval(hb); unsub(); });
});

  return r;
};
