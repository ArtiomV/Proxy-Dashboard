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
//
// WP7 (B2C Э5): антифрод розницы. Хит по бан-листу на порту РОЗНИЧНОГО
// клиента (порт в retail_pool в статусе leased/blocked, либо portName
// принадлежит клиенту clientType='individual') при delta ≥ порога
// (domain_guard_suspend_hits, дефолт 1; 0 = выкл) → авто-саспенд:
//   • механизм — «дата до» = сегодня (setPortValidBefore), как в конвейере
//     retail-guard, а НЕ отвязка пустым portName: порт остаётся привязанным
//     и видимым в пуле/у клиента, реабилитация админом симметрична
//     восстановлению после долга;
//   • строка пула leased → blocked с hold_until=NULL (∞ hold: авто-удаление
//     по hold её не тронет — порт ждёт решения админа);
//   • kv-маркер abuse_hold:{clientId} — retail-guard НЕ восстанавливает
//     такие порты автоматически после пополнения (разблокировка только
//     админом, §8 ТЗ);
//   • abuse_strikes++ → при strikes ≥ abuse_strikes_block (дефолт 2):
//     blocked=1 + kill всех сессий (deleteSessionsByLogin);
//   • клиенту — notifyClient, админу — alerts.trigger('retail_abuse_suspend').
// B2B-порты авто-саспендом НЕ трогаем — для них поведение прежнее (алерт).
// Дедуп: kv abuse_susp:{clientId}:{server}:{portId} — повторные хиты по уже
// приостановленному порту второй strike не начисляют.

const fs = require('fs');
const path = require('path');

const RETRY_ATTEMPTS = 3;
const RETRY_COOLDOWN_MS = 3 * 60 * 1000;
const SNAPSHOT_MAX_AGE_H = 26;  // TopHosts суточная: старше 26ч = не отработала
const BLOCKLIST_PATH = path.join(__dirname, '..', '..', 'config', 'blocked-domains.json');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function create(deps) {
  const { db, logger, getSetting, alerts, logActivity, getMoscowToday } = deps;
  // WP7: deps антифрода — опциональны (старые вызовы create() без них просто
  // не получат авто-саспенд; в server.js они подключены всегда).
  const {
    auditLog, clients, saveClients, retailPoolDb, deleteSessionsByLogin,
    kvGet, kvSet, notifyClient,
  } = deps;
  const portValidity = require('../services/port-validity').create(deps);

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

  // ── WP7: розничность порта ──
  // Порт розничный, если строка пула (leased/blocked/reserved) с client_id
  // ведёт на живого клиента, либо client_name (portName на боксе) принадлежит
  // клиенту clientType='individual'. Всё остальное — B2B: только алерт.
  function _resolveRetailClient(hit) {
    if (retailPoolDb && hit.portId) {
      const pr = retailPoolDb.byPort(hit.server, hit.portId);
      if (pr && pr.client_id && pr.status !== 'free') {
        const c = (clients || []).find(x => x.id === pr.client_id);
        if (c) return c;
      }
    }
    if (!hit.clientName) return null;
    const c = (clients || []).find(x => x.portName && x.portName === hit.clientName);
    return (c && c.clientType === 'individual') ? c : null;
  }

  function _abuseHoldKey(clientId) { return `abuse_hold:${clientId}`; }
  function _suspDedupKey(clientId, server, portId) { return `abuse_susp:${clientId}:${server}:${portId}`; }

  // Маркер антифрод-заморозки: список портов, погашенных за AUP. Его читает
  // retail-guard (не восстанавливать автоматически) и «Реабилитировать порт».
  function _abuseHoldAdd(clientId, entry) {
    try {
      const row = kvGet(_abuseHoldKey(clientId));
      const list = row && row.value ? JSON.parse(row.value) : [];
      if (!list.some(p => p.server === entry.server && p.port_id === entry.port_id)) list.push(entry);
      kvSet(_abuseHoldKey(clientId), JSON.stringify(list));
    } catch (e) { logger.warn('[DomainGuard] abuse_hold marker: ' + e.message); }
  }

  // Авто-саспенд одного порта розницы: «дата до» = сегодня + пул → blocked
  // (∞ hold) + strike + (при пороге strikes) blocked=1 + kill сессий.
  async function _suspendRetailPort(client, hit, date, stats) {
    const today = date;   // getMoscowToday() прогона
    const server = deps.findServer(hit.server);
    if (!server) {
      logger.error(`[DomainGuard] ${client.login}: сервер ${hit.server} не найден — саспенд отложен`);
      return;
    }
    await portValidity.setPortValidBefore(server, hit.portId, today);
    const pr = retailPoolDb && retailPoolDb.byPort(hit.server, hit.portId);
    if (pr && (pr.status === 'leased' || pr.status === 'reserved')) retailPoolDb.block(pr.id, null);
    _abuseHoldAdd(client.id, { server: hit.server, port_id: hit.portId, host: hit.host, date });
    try { kvSet(_suspDedupKey(client.id, hit.server, hit.portId), '1'); } catch (_) { /* best-effort */ }

    client.abuseStrikes = (client.abuseStrikes || 0) + 1;
    const blockThreshold = Number(getSetting('abuse_strikes_block', 2)) || 2;
    const blockNow = client.abuseStrikes >= blockThreshold && !client.blocked;
    if (blockNow) client.blocked = true;
    stats.dirty = true;

    logger.warn(`[DomainGuard] ${client.login}: AUP-саспенд ${hit.server}/${hit.portId} (хост ${hit.host}), strikes=${client.abuseStrikes}${blockNow ? ' → BLOCKED' : ''}`);
    try { auditLog('system', 'retail_abuse_suspend', { clientId: client.id, login: client.login, server: hit.server, portId: hit.portId, host: hit.host, strikes: client.abuseStrikes, blocked: !!client.blocked }); } catch (_) { /* audit best-effort */ }
    try {
      await notifyClient(client,
        `Обнаружено нарушение правил использования (AUP): обращение к запрещённому ресурсу ${hit.host}. Порт приостановлен.` +
        (blockNow ? ' Аккаунт заблокирован — свяжитесь с поддержкой.' : ' Повторное нарушение приведёт к блокировке аккаунта.'),
        { action: 'retail_abuse_suspend', details: { client_id: client.id, port_id: hit.portId, host: hit.host } });
    } catch (e) { logger.warn(`[DomainGuard] notify ${client.login}: ${e.message}`); }
    if (blockNow) {
      try { deleteSessionsByLogin(client.login); } catch (_) { /* best-effort */ }
      try { auditLog('system', 'retail_abuse_block', { clientId: client.id, login: client.login, strikes: client.abuseStrikes }); } catch (_) { /* audit best-effort */ }
    }
    try {
      alerts.trigger('retail_abuse_suspend', {
        client: client.login, client_id: client.id, server: hit.server,
        port_id: hit.portId, host: hit.host, strikes: client.abuseStrikes, blocked: !!client.blocked,
      });
    } catch (_) { /* alert best-effort */ }
    stats.suspended.push(hit.portId);
  }

  // Проход по хитам прогона: розничные порты с delta ≥ порога → саспенд.
  async function _enforceRetailSuspends(hits, date) {
    const stats = { suspended: [], dirty: false };
    if (!getSetting('retail_enabled', false)) return stats;
    const threshold = Number(getSetting('domain_guard_suspend_hits', 1));
    if (!threshold) return stats;   // 0 = авто-саспенд выключен
    if (!clients || !saveClients || !retailPoolDb || !notifyClient) return stats;   // deps не подключены (старые вызовы)
    for (const hit of hits) {
      if (hit.delta < threshold) continue;
      const client = _resolveRetailClient(hit);
      if (!client) continue;                       // B2B/неизвестный — только алерт (выше)
      if (client.blocked) continue;                // уже заблокирован — всё сделано
      try {
        const seen = kvGet(_suspDedupKey(client.id, hit.server, hit.portId));
        if (seen && seen.value) continue;          // порт уже приостановлен за AUP
      } catch (_) { /* kv недоступен — идём дальше, setPortValidBefore идемпотентен по дате */ }
      try {
        await _suspendRetailPort(client, hit, date, stats);
      } catch (e) {
        logger.error(`[DomainGuard] ${client.login}: саспенд ${hit.server}/${hit.portId} failed: ${e.message}`);
        logActivity('system', 'error', 'retail_abuse_suspend_error', client.login,
          `Антифрод-саспенд порта ${hit.portId} не удался: ${e.message}`, { client_id: client.id, port_id: hit.portId });
      }
    }
    if (stats.dirty) saveClients(clients);
    return stats;
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
          hits.push({ server: r.server_name, portId: r.port_id, clientName: r.client_name || '', client: r.client_name || r.nick || r.port_id, host: r.host, delta, total: r.count || 0 });
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
      // WP7 (B2C Э5): авто-саспенд розницы ПОСЛЕ общего алерта — даже при
      // фейле саспенда админ уже знает о хите.
      const enf = await _enforceRetailSuspends(hits, date);
      if (enf.suspended.length) {
        logger.warn(`[DomainGuard] Антифрод: приостановлено портов розницы: ${enf.suspended.length}`);
        logActivity('system', 'warning', 'retail_abuse_suspend', null,
          `Антифрод: авто-саспенд портов розницы за ${date}: ${enf.suspended.join(', ')}`,
          { date, ports: enf.suspended });
      }
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
