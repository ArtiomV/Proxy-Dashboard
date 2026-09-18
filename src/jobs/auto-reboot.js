'use strict';
//
// src/jobs/auto-reboot.js — авто-перезагрузка «хромающих» модемов.
// Срабатывает, когда модем попадает в proxyIssues с подтверждённым
// устойчивым dead-отказом пинга (FIX-05, 2026-09-18: degraded-записи и
// неподтверждённые/протухшие данные reboot не вызывают — только
// диагностика). Троттлинг: не чаще auto_reboot_min_interval_min на модем.
// Opt-in через appSettings.auto_reboot_enabled. Extracted from server.js
// (Stage 9).

function create(deps) {
  const {
    db, appSettings, logger, logActivity,
    computeProxyIssues, fetchAllServersDataCached, findServer, fetchApi,
  } = deps;

  const _autoRebootInsert = (() => {
    try {
      return db.prepare(`INSERT INTO auto_reboot_log
        (server_name, nick, imei, reason, status, error)
        VALUES (?, ?, ?, ?, ?, ?)`);
    } catch (_) { return null; }
  })();

  async function runAutoReboot() {
    // 20.08: random-ник = сбойный ре-енум модема (NICK вида «random####») —
    // такой модем лечится только перезагрузкой. Обрабатываем независимо от
    // auto_reboot_enabled: отдельный флаг random_modem_reboot_enabled (on по
    // умолчанию), тот же троттлинг по auto_reboot_log.
    await _rebootRandomModems();
    if (!appSettings.auto_reboot_enabled) return;
    const minInterval = Math.max(15, parseInt(appSettings.auto_reboot_min_interval_min) || 60);

    // FIX-05 (2026-09-18): reboot — только по dead-кандидатам: подтверждённый
    // устойчивый текущий отказ источника (свежий валидный замер за dead-порогом,
    // ≥2 failed за TTL-окно — см. proxy-issues.js). Degraded-модемы (DEEP-13)
    // остаются в списке проблем UI и в диагностических modem_ping_*-алертах,
    // но без подтверждённого отказа автоматически не перезагружаются.
    const allIssues = computeProxyIssues();
    const candidates = allIssues.filter(it => it.dead === true);
    const degraded = allIssues.length - candidates.length;
    if (degraded > 0) {
      logger.info(`[AutoReboot] ${degraded} degraded-модем(а) без подтверждённого dead-отказа — только диагностика, reboot не выполняется`);
    }
    if (candidates.length === 0) return;

    // Build IMEI lookup: nick + server_name → imei (need IMEI for reboot API)
    let live;
    try { live = await fetchAllServersDataCached(); } catch (e) { live = []; }
    const imeiMap = {};   // server|nick → imei
    for (const data of live) {
      const srv = data.serverName;
      if (!Array.isArray(data.status)) continue;
      for (const m of data.status) {
        const md = m.modem_details || {};
        if (md.NICK && md.IMEI) imeiMap[srv + '|' + md.NICK] = md.IMEI;
      }
    }

    // Throttle check via DB — last reboot timestamp per modem
    const sinceExpr = `datetime('now', '-${minInterval} minutes')`;
    const recent = db.prepare(`
      SELECT server_name, nick, MAX(rebooted_at) AS last
        FROM auto_reboot_log
       WHERE rebooted_at >= ${sinceExpr}
       GROUP BY server_name, nick
    `).all();
    const recentSet = new Set(recent.map(r => r.server_name + '|' + r.nick));

    // FIX-05 §16.2 (2026-09-18): пока ждали IMEI-lookup (await выше), кандидат
    // мог восстановиться или данные протухнуть — пересчитываем и ребутим
    // только тех, кто ВСЁ ЕЩЁ подтверждённо лежит.
    const stillDead = new Set(
      computeProxyIssues().filter(it => it.dead === true).map(it => it.server + '|' + it.nick)
    );

    let attempted = 0, succeeded = 0;
    for (const it of candidates) {
      const key = it.server + '|' + it.nick;
      if (recentSet.has(key)) continue; // already rebooted recently
      if (!stillDead.has(key)) {
        logger.info(`[AutoReboot] ${it.server}/${it.nick} — отказ не подтвердился после lookup, reboot отменён`);
        continue;
      }
      const imei = imeiMap[key];
      if (!imei) {
        logger.warn(`[AutoReboot] no IMEI for ${it.server}/${it.nick}, skipping`);
        continue;
      }
      const server = findServer(it.server);
      if (!server) continue;
      attempted++;
      try {
        await fetchApi(server, `/apix/reboot_modem_by_imei?IMEI=${encodeURIComponent(imei)}`);
        if (_autoRebootInsert) _autoRebootInsert.run(it.server, it.nick, imei, it.detail, 'success', null);
        logger.warn(`[AutoReboot] ${it.server}/${it.nick} IMEI=${imei} reason="${it.detail}"`);
        logActivity('modem', 'warn', 'auto_reboot', it.nick,
          `Auto-reboot triggered: ${it.detail}`,
          { server: it.server, nick: it.nick, imei, reasons: it.reasons });
        succeeded++;
      } catch (e) {
        if (_autoRebootInsert) _autoRebootInsert.run(it.server, it.nick, imei, it.detail, 'failed', e.message);
        logger.error(`[AutoReboot] ${it.server}/${it.nick} failed:`, e.message);
      }
    }
    if (attempted > 0) {
      logger.info(`[AutoReboot] cycle: ${succeeded}/${attempted} reboots, ${candidates.length - attempted} throttled`);
    }
  }

  // Модемы с NICK «random####» — сбойная ре-енумерация хаба; ребутим по IMEI.
  // Троттлинг: не чаще 30 мин на модем (своя причина 'random_nick' в логе).
  async function _rebootRandomModems() {
    const enabled = appSettings.random_modem_reboot_enabled !== false;   // default on
    if (!enabled) return;
    let live;
    try { live = await fetchAllServersDataCached(); } catch (e) { return; }
    const sinceExpr = `datetime('now', '-30 minutes')`;
    const recent = db.prepare(`
      SELECT server_name, nick, MAX(rebooted_at) AS last
        FROM auto_reboot_log
       WHERE rebooted_at >= ${sinceExpr}
       GROUP BY server_name, nick
    `).all();
    const recentSet = new Set(recent.map(r => r.server_name + '|' + r.nick));
    for (const data of live) {
      if (!Array.isArray(data.status) || data._cached) continue;
      const srv = data.serverName;
      for (const m of data.status) {
        const md = m.modem_details || {};
        const nick = (md.NICK || '').trim();
        if (!/^random/i.test(nick) || !md.IMEI) continue;
        if (recentSet.has(srv + '|' + nick)) continue;
        const server = findServer(srv);
        if (!server) continue;
        try {
          await fetchApi(server, `/apix/reboot_modem_by_imei?IMEI=${encodeURIComponent(md.IMEI)}`);
          if (_autoRebootInsert) _autoRebootInsert.run(srv, nick, md.IMEI, 'random_nick', 'success', null);
          logger.warn(`[AutoReboot] ${srv}/${nick} IMEI=${md.IMEI} — random-ник, reboot`);
          logActivity('modem', 'warn', 'auto_reboot', nick,
            'Auto-reboot: модем ре-енумерился с random-ником',
            { server: srv, nick, imei: md.IMEI, reasons: ['random_nick'] });
        } catch (e) {
          if (_autoRebootInsert) _autoRebootInsert.run(srv, nick, md.IMEI, 'random_nick', 'failed', e.message);
          logger.error(`[AutoReboot] random ${srv}/${nick} failed:`, e.message);
        }
      }
    }
  }

  return { runAutoReboot };
}

module.exports = { create };
