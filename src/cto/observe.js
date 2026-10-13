'use strict';
//
// src/cto/observe.js — снимок состояния для осмотра ИИ-директором.
// Компактный (единицы КБ): агрегаты и топы, без сырых строк. Каждая секция
// независима — сбой одной не ломает осмотр. Источники только те, что уже
// собирает дашборд; тяжёлые запросы (пинги за сутки) идут через
// ai_insights.buildDayContextOffThread — в worker-потоке.

const statScope = require('../modems/stat-scope');
const { SETTINGS } = require('./boundaries');
const fs = require('fs');
const path = require('path');

const NOTES_FILE = path.join(__dirname, '..', '..', 'docs', 'cto-notes.md');
const NOTES_MAX = 4000;

const rotTs = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', '@');
const sqlTs = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');

function create(deps) {
  const { db, logger, getSetting, aiInsights, knownModems, kvGet } = deps;

  function section(name, fn, out) {
    try { out[name] = fn(); }
    catch (e) { out[name] = { error: e.message }; logger.warn(`[CTO] observe.${name}: ${e.message}`); }
  }

  async function snapshot() {
    const now = Date.now();
    const out = { generated_at: new Date(now).toISOString(), now_utc_hour: new Date(now).toISOString().slice(0, 13), window: 'последние 24 ч, если не указано иное' };

    // Сутки по серверам: пинги (потери ≥ порога), HTTP, ротации, трафик — как в утренней сводке.
    try {
      const yesterday = new Date(now - 86400000 + 3 * 3600000).toISOString().slice(0, 10);   // МСК-дата последних полных суток
      const ctx = await aiInsights.buildDayContextOffThread(yesterday);
      out.last_full_day_msk = yesterday;
      out.servers = ctx.servers;
      out.problem_modems = ctx.problem_modems;
      out.http_errors = (ctx.http_errors || []).slice(0, 15);
      out.ping_failure_definition = ctx.ping_failure_definition;
      out.baseline_7d = ctx.baseline_7d;
    } catch (e) { out.servers = { error: e.message }; }

    // Ротации модемов С клиентами: застрявшие и доля неуспехов (критерии — stat-scope).
    section('rotations_client_modems', () => {
      const sc = statScope.boundClause('server_name', 'nick', knownModems);
      const since = rotTs(now - 86400000);
      const rows = db.prepare(`
        SELECT server_name AS server, nick, COUNT(*) AS total,
               SUM(CASE WHEN ${statScope.rotFailedSql()} THEN 1 ELSE 0 END) AS failed
          FROM rotation_log
         WHERE started_at >= ? AND ${statScope.rotCountedSql()}${sc.clause}
         GROUP BY server_name, nick HAVING total >= 5
         ORDER BY failed * 1.0 / total DESC LIMIT 12`).all(since, ...sc.params);
      return rows.filter(r => r.failed > 0).map(r => ({ ...r, fail_pct: Math.round(r.failed * 1000 / r.total) / 10 }));
    }, out);

    // Правило «ротация выключена у модемов без клиента»: сколько модемов им управляется.
    section('idle_rotation_rule', () => {
      let prev = {};
      try { const r = kvGet('idle_rotation_prev'); if (r && r.value) prev = JSON.parse(r.value); } catch (_) { /* пусто */ }
      return { enabled: !!getSetting('idle_modem_rotation_off', true), modems_switched_off: Object.keys(prev).length };
    }, out);

    // Журнал: предупреждения/ошибки по типам, лаги event loop, падения.
    section('system_log_24h', () => {
      const since = sqlTs(now - 86400000);
      const rows = db.prepare(`SELECT action, level, COUNT(*) AS n FROM system_log
        WHERE timestamp >= ? AND level IN ('warn','error','critical') GROUP BY action, level ORDER BY n DESC LIMIT 20`).all(since);
      let lagMax = 0, lagCount = 0;
      const lagRecent = [];
      for (const r of db.prepare(`SELECT timestamp, message FROM system_log WHERE action = 'eventloop_lag' AND timestamp >= ? ORDER BY id DESC`).all(since)) {
        lagCount++; const m = /max=(\d+)ms/.exec(r.message || '');
        if (m) lagMax = Math.max(lagMax, +m[1]);
        if (lagRecent.length < 8) lagRecent.push({ at_utc: r.timestamp, max_ms: m ? +m[1] : null });
      }
      // Время последнего события каждого типа — чтобы отличить давний сбой от рецидива после исправления.
      const lastAt = {};
      for (const r of db.prepare(`SELECT action, MAX(timestamp) AS last_at FROM system_log
        WHERE timestamp >= ? AND level IN ('warn','error','critical') GROUP BY action`).all(sqlTs(now - 3 * 86400000))) lastAt[r.action] = r.last_at;
      for (const r of rows) r.last_event_utc = lastAt[r.action] || null;
      return { by_action: rows, eventloop_lag: { events: lagCount, max_ms_in_24h: lagMax, recent_events_newest_first: lagRecent } };
    }, out);

    // Трафик: сомнительные часы и карантин.
    section('traffic_quality_24h', () => {
      const since = sqlTs(now - 86400000);
      const rows = db.prepare(`SELECT uncertain, COUNT(*) AS n, ROUND(SUM(bytes_in + bytes_out) / 1e9, 2) AS gb
        FROM traffic_hourly WHERE hour_start >= ? AND uncertain > 0 GROUP BY uncertain`).all(since);
      const names = { 1: 'gap_filled', 2: 'counter_disagree_kept', 3: 'smoothed', 4: 'quarantined' };
      return rows.map(r => ({ kind: names[r.uncertain] || String(r.uncertain), hours: r.n, gb: r.gb }));
    }, out);

    // Спидтесты: сбои по серверам за 3 дня.
    section('speedtest_failures_3d', () => db.prepare(`
      SELECT server, COUNT(*) AS runs, SUM(ok = 0) AS failed,
             GROUP_CONCAT(DISTINCT CASE WHEN ok = 0 THEN substr(error, 1, 40) END) AS errors
        FROM speed_monitor WHERE ts >= ? GROUP BY server`).all(new Date(now - 3 * 86400000).toISOString()), out);

    // Нагрузка боксов: последняя метрика по каждому.
    section('box_metrics_latest', () => db.prepare(`
      SELECT m.server_name AS server, m.collected_at, m.cpu_pct, m.load1, m.mem_used_pct, m.disk_used_pct, m.usb_errors, m.box_time_drift_sec
        FROM server_metrics m JOIN (SELECT server_name, MAX(id) AS id FROM server_metrics GROUP BY server_name) x ON x.id = m.id`).all(), out);

    // Текущие значения настроек, которые агент вправе менять.
    section('tunable_settings', () => {
      const o = {};
      for (const k of Object.keys(SETTINGS)) o[k] = getSetting(k, null);
      return o;
    }, out);

    // Заметки оператора: что уже исправлено и что сделано намеренно (docs/cto-notes.md).
    section('operator_notes', () => {
      try { return fs.readFileSync(NOTES_FILE, 'utf8').slice(0, NOTES_MAX); } catch (_) { return ''; }
    }, out);

    // История предложений: чтобы не повторяться и учиться на результатах.
    section('recent_proposals', () => db.prepare(`
      SELECT id, substr(created_at,1,10) AS day, title, action_type, status, substr(COALESCE(verify_json,''),1,160) AS verify
        FROM cto_proposals WHERE created_at >= datetime('now','-30 days') ORDER BY id DESC LIMIT 40`).all(), out);

    return out;
  }

  return { snapshot };
}

module.exports = { create };
