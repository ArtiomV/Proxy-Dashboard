'use strict';
//
// src/jobs/domain-guard.js — WP2: доменный контроль для боксов со снятой
// hfilter-фильтрацией (box4/RO2). Постфактум-детект, не блокировка: раз в
// сутки берём свежий top_hosts-снапшот (его собирает джоба TopHosts в 03:00
// UTC), пишем суточную историю по guard-серверам и матчим домены против
// бан-листа config/blocked-domains.json (реальный Ban-сет hfilter, снятый с
// RO2). Совпадение с ПРИРОСТОМ хитов → телеграм-алерт.
//
// Почему дельта, а не абсолют: счётчики top_hosts у ProxySmart кумулятивные
// (копятся до ResetCounters), абсолютные значения алертили бы каждый день по
// давно остывшему хиту. Первый прогон даёт baseline: всё существующее
// алертится один раз, дальше — только новые обращения. Сброс счётчика на
// боксе (count < prev) трактуем как «всё текущее — новое».
//
// Ретрай-контракт (как в WP1): источник данных здесь локальный (снапшот
// TopHosts), поэтому «фейл запроса» = несвежий/пустой снапшот. Ждём и
// перепроверяем ещё 2 раза с охлаждением, после чего алертим
// domain_guard_failed — молчаливых дыр в контроле не бывает.

const fs = require('fs');
const path = require('path');

const RETRY_ATTEMPTS = 3;
const RETRY_COOLDOWN_MS = 3 * 60 * 1000;
const SNAPSHOT_MAX_AGE_H = 26;  // TopHosts суточная: старше 26ч = не отработала
const BLOCKLIST_PATH = path.join(__dirname, '..', '..', 'config', 'blocked-domains.json');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function create(deps) {
  const { db, logger, getSetting, alerts, logActivity, getMoscowToday } = deps;

  const _dailyUpsert = db.prepare(`INSERT INTO top_hosts_daily
    (date, server_name, port_id, nick, client_name, host, count)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(date, server_name, port_id, host) DO UPDATE SET
      nick = excluded.nick, client_name = excluded.client_name, count = excluded.count`);
  const _prevCount = db.prepare(`SELECT count FROM top_hosts_daily
    WHERE server_name = ? AND port_id = ? AND host = ? AND date < ?
    ORDER BY date DESC LIMIT 1`);
  const _hitUpsert = db.prepare(`INSERT INTO domain_guard_hits
    (date, server_name, client_name, nick, host, matched_domain, hits_delta, total)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(date, server_name, client_name, host) DO UPDATE SET
      hits_delta = excluded.hits_delta, total = excluded.total, created_at = datetime('now')`);

  function loadBlocklist() {
    const cfg = JSON.parse(fs.readFileSync(BLOCKLIST_PATH, 'utf8'));
    const all = [...(cfg.domains || []), ...(cfg.custom || [])]
      .map(d => String(d).toLowerCase().trim()).filter(Boolean);
    return [...new Set(all)];
  }

  // Суффикс-матч: host равен домену или является его поддоменом.
  function matchDomain(host, blocklist) {
    const h = String(host).toLowerCase();
    for (const d of blocklist) {
      if (h === d || h.endsWith('.' + d)) return d;
    }
    return null;
  }

  function snapshotFreshRows(guardServers) {
    const row = db.prepare('SELECT MAX(snapshot_at) AS at FROM top_hosts_detail').get();
    if (!row || !row.at) return { fresh: false, reason: 'снапшот top_hosts пуст' };
    const ageH = (Date.now() - Date.parse(row.at)) / 3600e3;
    if (!(ageH < SNAPSHOT_MAX_AGE_H)) return { fresh: false, reason: `снапшот top_hosts устарел (${ageH.toFixed(0)}ч)` };
    const rows = db.prepare(`SELECT server_name, port_id, nick, client_name, host, count
      FROM top_hosts_detail WHERE server_name IN (${guardServers.map(() => '?').join(',')})`).all(...guardServers);
    if (!rows.length) return { fresh: false, reason: 'в снапшоте нет строк по guard-серверам' };
    return { fresh: true, rows };
  }

  async function runDomainGuard() {
    const date = getMoscowToday();
    const guardServers = String(getSetting('domain_guard_servers', 'S2,S4'))
      .split(',').map(s => s.trim()).filter(Boolean);
    if (!guardServers.length) { logger.info('[DomainGuard] guard-серверы не заданы — пропуск'); return { skipped: true }; }

    let blocklist;
    try { blocklist = loadBlocklist(); }
    catch (e) {
      logger.error('[DomainGuard] бан-лист не загружен:', e.message);
      alerts.trigger('domain_guard_failed', { error: `бан-лист не загружен: ${e.message}`, date });
      return { failed: true };
    }
    logger.info(`[DomainGuard] Старт: ${date}, серверы [${guardServers.join(', ')}], бан-лист ${blocklist.length} доменов`);

    // Ретраи по свежести снапшота (TopHosts в 03:00 может ещё дорабатывать).
    let snap = snapshotFreshRows(guardServers);
    for (let pass = 2; pass <= RETRY_ATTEMPTS && !snap.fresh; pass++) {
      logger.info(`[DomainGuard] ${snap.reason} — попытка ${pass}/${RETRY_ATTEMPTS} после охлаждения`);
      await sleep(RETRY_COOLDOWN_MS);
      snap = snapshotFreshRows(guardServers);
    }
    if (!snap.fresh) {
      logger.error(`[DomainGuard] контроль не отработал: ${snap.reason}`);
      alerts.trigger('domain_guard_failed', { error: snap.reason, date });
      logActivity('system', 'error', 'domain_guard_failed', null, `Доменный контроль не отработал: ${snap.reason}`, { date });
      return { failed: true };
    }

    const hits = [];
    const writeAll = db.transaction(() => {
      for (const r of snap.rows) {
        _dailyUpsert.run(date, r.server_name, r.port_id, r.nick || '', r.client_name || '', r.host, r.count || 0);
        const matched = matchDomain(r.host, blocklist);
        if (!matched) continue;
        const prev = _prevCount.get(r.server_name, r.port_id, r.host, date);
        // Кумулятивный счётчик: нет истории → всё новое; упал → был сброс.
        const delta = !prev ? (r.count || 0)
          : (r.count >= prev.count ? r.count - prev.count : r.count);
        if (delta > 0) {
          _hitUpsert.run(date, r.server_name, r.client_name || '', r.nick || '', r.host, matched, delta, r.count || 0);
          hits.push({ server: r.server_name, client: r.client_name || r.nick || r.port_id, host: r.host, delta, total: r.count || 0 });
        }
      }
      // Ретеншен истории — здесь же, отдельная джоба не нужна.
      const keepDays = Number(getSetting('retention_top_hosts_daily', 90)) || 90;
      db.prepare(`DELETE FROM top_hosts_daily WHERE date < date('now', ?)`).run(`-${keepDays} days`);
      db.prepare(`DELETE FROM domain_guard_hits WHERE date < date('now', ?)`).run(`-${keepDays} days`);
    });
    writeAll();

    if (hits.length) {
      hits.sort((a, b) => b.delta - a.delta);
      alerts.trigger('domain_guard_hit', { date, count: hits.length, top: hits.slice(0, 8) });
    }
    logger.info(`[DomainGuard] Готово: ${snap.rows.length} строк истории, совпадений с бан-листом: ${hits.length}`);
    logActivity('system', hits.length ? 'warning' : 'info', 'domain_guard',
      null, `Доменный контроль за ${date}: ${hits.length} совпадений с бан-листом (${snap.rows.length} строк)`,
      { date, rows: snap.rows.length, hits: hits.length });
    return { date, rows: snap.rows.length, hits: hits.length };
  }

  return { runDomainGuard };
}

module.exports = { create };
