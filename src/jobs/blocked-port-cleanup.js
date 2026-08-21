'use strict';
//
// src/jobs/blocked-port-cleanup.js — автоудаление портов заблокированных
// клиентов после истечения срока хранения (21.08).
//
// Зачем: раньше порт заблокированного клиента (ручная блок админом или
// долговой debt-block) гасился («дата до» = сегодня), но НИКОГДА не удалялся
// с бокса — модемы висели мёртвым грузом неделями (flint019, ltespace).
// RetailGuard умеет удалять, но он а) выключен на проде (retail_enabled=false),
// б) осознанно пропускает client.blocked (антифрод WP7: разблокировка только
// руками). Эта джоба закрывает дыру независимо от розничного конвейера.
//
// Механика:
//   • население: клиенты с blocked=1 (ручная) ИЛИ debt_blocked=1 (долговая),
//     у которых blocked_since (миграция 073) старше retail_hold_days дней.
//     Юрлица (client_type='legal') — НИКОГДА: им базово разрешён минус
//     (allow_debt=1), порты не блокируются и не удаляются автоматически.
//   • действие: delete_port на боксе для каждого порта клиента (порты уже
//     погашены — удаление освобождает модем для перепродажи). Фейл → error-лог,
//     повтор в следующем цикле (идемпотентно: удалённый порт просто не
//     резолвится из serverResults).
//   • после удаления всех портов клиент перестаёт иметь модемы → попадает
//     во вкладку «Неактивные» (UI страницы «Клиенты»), из основных списков
//     скрывается. portName НЕ чистим — остаётся для истории/аудита.
//   • клиенту — уведомление, админу — TG-алерт, в audit — запись.
//
// Дедлайн: blocked_since + retail_hold_days (та же настройка, что «Hold до
// удаления порта» в Настройки → Розница). blocked_since проставляется при
// ручной блокировке (routes/clients.js) и при долговой (jobs/debt-block.js);
// снятие блока / оплата долга сбрасывает метку → джоба клиента не трогает.

function create(deps) {
  const {
    logger, logActivity, auditLog, alerts,
    proxyConf, saveClients, getMoscowNow,
    fetchAllServersDataCached,
    clients, getSetting,
    notifyClient,
  } = deps;

  const portValidity = require('../services/port-validity').create(deps);

  const DAY_MS = 86400000;

  function _holdDays() {
    const v = Number(getSetting('retail_hold_days', 7));
    return Number.isFinite(v) && v >= 1 ? v : 7;
  }

  let running = false;   // re-entrancy: прогон один за раз

  async function runOnce() {
    if (running) return { skipped: 'already_running' };
    running = true;
    const stats = { deleted: [], failed: [], candidates: 0 };
    try {
      const holdMs = _holdDays() * DAY_MS;
      const nowMs = getMoscowNow().getTime();
      const targets = clients.filter(c =>
        (c.blocked || c.debtBlocked) &&
        c.clientType !== 'legal' &&           // юрлица — никогда
        c.blockedSince &&
        nowMs - Date.parse(c.blockedSince) >= holdMs
      );
      if (!targets.length) return stats;
      stats.candidates = targets.length;
      const serverResults = await fetchAllServersDataCached();
      for (const client of targets) {
        const ports = portValidity.clientPorts(client, serverResults);
        if (!ports.length) continue;   // портов на боксах уже нет — нечего удалять
        let ok = 0;
        for (const pt of ports) {
          try {
            const del = await proxyConf.getConfAction(pt.server, `/conf/delete_port/${encodeURIComponent(pt.portId)}`);
            if (!del.ok) {
              stats.failed.push(pt.portId);
              logger.error(`[BlockedCleanup] ${client.login}: delete_port ${pt.portId} failed: ${del.reason} — повтор в след. цикле`);
              continue;
            }
            ok++;
            stats.deleted.push(pt.portId);
            logger.warn(`[BlockedCleanup] ${client.login}: порт ${pt.server.name}/${pt.portId} удалён (blocked_since ${client.blockedSince}, hold ${_holdDays()} дн)`);
            try { auditLog('system', 'blocked_port_deleted', { clientId: client.id, clientName: client.name, server: pt.server.name, portId: pt.portId, blockedSince: client.blockedSince }); } catch (_) { /* audit best-effort */ }
          } catch (e) {
            stats.failed.push(pt.portId);
            logger.error(`[BlockedCleanup] ${client.login}: delete_port ${pt.portId}: ${e.message}`);
          }
        }
        if (ok > 0) {
          logActivity('billing', 'warn', 'blocked_ports_deleted', client.login,
            `Срок хранения истёк — удалено портов: ${ok}${stats.failed.length ? `, ошибок: ${stats.failed.length}` : ''}`,
            { client_id: client.id, deleted: ok });
          try {
            alerts.trigger('blocked_ports_deleted', {
              client_id: client.id, client: client.name || client.login, ports: ok,
              blocked_since: client.blockedSince,
            });
          } catch (_) { /* alert best-effort */ }
          try {
            await notifyClient(client,
              'Срок хранения истёк — прокси-порты удалены. После пополнения баланса выдадим новые автоматически.',
              { action: 'blocked_ports_deleted', details: { client_id: client.id, deleted: ok } });
          } catch (e) { logger.warn(`[BlockedCleanup] notify ${client.login}: ${e.message}`); }
        }
      }
      return stats;
    } finally {
      running = false;
    }
  }

  return { runOnce };
}

module.exports = { create };
