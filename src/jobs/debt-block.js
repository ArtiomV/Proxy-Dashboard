'use strict';
//
// src/jobs/debt-block.js — B3 (Р13): автоматическая блокировка должников-физиков
// через «дата до» (PROXY_VALID_BEFORE) ProxySmart.
//
// Механика (FUNCTIONAL-SPEC §2.9):
//   • после DailyBilling: физик (client_type != 'legal') с balance ≤ 0 и
//     allow_debt = 0 → для всех его портов «дата до» = сегодня, ProxySmart
//     гасит порт при apply_port. Юрлица — никогда (явная проверка).
//     allow_debt = 1 — не трогаем. per_modem физики блокируются так же (Р25).
//   • прогноз «за 3 дня»: 0 < balance ≤ 3 × среднесуточное списание за 7 дн
//     → предупреждение (TG-правило client_block_warning + портал-баннер).
//   • восстановление: оплата (любой atomicCredit-путь: ручной платёж, webhook,
//     sync) → balance > 0 → продление «дата до» на +30 дней от сегодня
//     (дефолт; ручной override в UI — произвольная дата, стандартного срока
//     в коде нет). Задержка до ~30 мин для банковского sync (цикл TochkaSync).
//
// Запись «дата до» идёт тем же путём, что ручной save_port_config: читаем
// форму /conf/edit_port целиком (обход логин-стены S2 через proxyConf),
// меняем только PROXY_VALID_BEFORE, POST обратно + apply_port.
// B2C Э2: механика вынесена в src/services/port-validity.js (переиспользует
// retail-guard); здесь остались только условия и оркестрация.
//
// Взаимодействие с retail-guard (Э2): при retail_enabled=true конвейером
// владеет retail-guard (grace → block+hold → delete), поэтому ОБА входа
// этой джобы — no-op (иначе двойная блокировка без grace). При выключенном
// флаге — прежнее поведение.
//
// Факт автоблока персистируется в clients.debt_blocked (миграция 056) — после
// рестарта восстановление по-прежнему знает, что порт гасили мы, а не оператор
// руками (ручной override «продлить до…» флаг не ставит и не снимает).

function create(deps) {
  const {
    logger, logActivity, alerts, auditLog,
    saveClients, getMoscowNow,
    fetchAllServersDataCached,
    clients,
    getSetting,   // B2C Э2: retail_enabled — retail-guard владеет конвейером
  } = deps;

  const portValidity = require('../services/port-validity').create(deps);
  const setPortValidBefore = portValidity.setPortValidBefore;
  const avgDailyCharge7d = portValidity.avgDailyCharge7d;
  const _clientPorts = portValidity.clientPorts;

  const RESTORE_DAYS = 30;   // продление при восстановлении: сегодня + 30 дн

  function _mskDateStr(d) { return d.toLocaleDateString('en-CA'); }   // YYYY-MM-DD
  function _today() { return _mskDateStr(getMoscowNow()); }

  // B2C Э2: розничный конвейер активен → debt-block полностью отступает.
  function _retailGuardOwns() {
    return typeof getSetting === 'function' && !!getSetting('retail_enabled', false);
  }

  // ── Пост-биллинговый проход: блокировка должников + прогноз «за 3 дня» ──
  async function runAfterDailyBilling(clients, serverResults) {
    if (_retailGuardOwns()) return;   // Э2: конвейером владеет retail-guard
    const today = _today();
    let dirty = false;
    for (const client of clients) {
      if (!client.portName) continue;
      if (client.clientType === 'legal') continue;      // юрлица — никогда
      if (client.allowDebt) continue;                   // allow_debt = 1 — не трогаем
      const balance = client.balance || 0;

      if (balance <= 0) {
        if (client.debtBlocked) continue;               // уже заблокирован ранее
        const ports = _clientPorts(client, serverResults);
        if (ports.length === 0) continue;               // блокировать нечего
        let blocked = 0;
        for (const pt of ports) {
          // Уже истёк/погашен (в т.ч. ручным override в прошлое) — не трогаем.
          const vbMs = Date.parse(pt.validBefore);
          if (!isNaN(vbMs) && pt.validBefore && pt.validBefore <= today) continue;
          try {
            await setPortValidBefore(pt.server, pt.portId, today);
            blocked++;
          } catch (e) {
            logger.error(`[DebtBlock] ${client.name}: не удалось погасить порт ${pt.portId}: ${e.message}`);
            logActivity('billing', 'error', 'debt_block_error', client.name,
              `Автоблок: порт ${pt.portId} не погашен: ${e.message}`, { client_id: client.id, port_id: pt.portId });
          }
        }
        if (blocked === 0) continue;                    // ничего не погасили — повторим завтра
        client.debtBlocked = true;
        dirty = true;
        logger.warn(`[DebtBlock] ${client.name}: баланс ${balance} ₽ — погашено портов: ${blocked} («дата до» = ${today})`);
        logActivity('billing', 'warn', 'debt_block', client.name,
          `Автоблок по долгу: баланс ${balance} ₽, погашено портов: ${blocked}`, { client_id: client.id, balance, blocked });
        try { auditLog('system', 'debt_block', { clientId: client.id, clientName: client.name, balance, portsBlocked: blocked, validBefore: today }); } catch (_) { /* audit best-effort */ }
        try {
          alerts.trigger('client_blocked_debt', {
            client_id: client.id, client: client.name, balance, ports: blocked, validBefore: today,
          });
        } catch (_) { /* alert best-effort */ }
      } else {
        // Прогноз «за 3 дня»: баланс покрывает ≤ 3 суток списаний.
        const avg = avgDailyCharge7d(client.id);
        if (avg > 0 && balance <= 3 * avg) {
          try {
            alerts.trigger('client_block_warning', {
              client_id: client.id, client: client.name, balance,
              daysLeft: Math.floor(balance / avg), avgDaily: avg,
            });
          } catch (_) { /* alert best-effort */ }
        }
      }
    }
    if (dirty) saveClients(clients);
  }

  // ── Восстановление после оплаты (вызывается по событию client-credit) ──
  async function restoreAfterCredit(client) {
    if (_retailGuardOwns()) return false;   // Э2: восстановлением владеет retail-guard
    if (!client || !client.debtBlocked) return false;   // гасили не мы — не трогаем
    if ((client.balance || 0) <= 0) return false;
    const until = new Date(getMoscowNow().getTime() + RESTORE_DAYS * 86400000);
    const untilStr = _mskDateStr(until);

    const results = await fetchAllServersDataCached();
    const ports = _clientPorts(client, results);
    let restored = 0;
    for (const pt of ports) {
      // Не укорачиваем более поздний срок (ручной override «продлить до…»).
      if (pt.validBefore && pt.validBefore > untilStr) continue;
      try {
        await setPortValidBefore(pt.server, pt.portId, untilStr);
        restored++;
      } catch (e) {
        logger.error(`[DebtBlock] ${client.name}: не удалось продлить порт ${pt.portId}: ${e.message}`);
        logActivity('billing', 'error', 'debt_restore_error', client.name,
          `Восстановление: порт ${pt.portId} не продлён: ${e.message}`, { client_id: client.id, port_id: pt.portId });
      }
    }
    client.debtBlocked = false;
    saveClients(clients);
    logger.info(`[DebtBlock] ${client.name}: баланс восстановлен (${client.balance} ₽) — «дата до» продлена до ${untilStr}, портов: ${restored}`);
    logActivity('billing', 'info', 'debt_restore', client.name,
      `Восстановление после оплаты: «дата до» = ${untilStr}, портов: ${restored}`, { client_id: client.id, balance: client.balance, restored });
    try { auditLog('system', 'debt_unblock', { clientId: client.id, clientName: client.name, balance: client.balance, portsRestored: restored, validBefore: untilStr }); } catch (_) { /* audit best-effort */ }
    try {
      alerts.trigger('client_unblocked_debt', {
        client_id: client.id, client: client.name, balance: client.balance, ports: restored, validBefore: untilStr,
      });
    } catch (_) { /* alert best-effort */ }
    return true;
  }

  return { runAfterDailyBilling, restoreAfterCredit, setPortValidBefore, avgDailyCharge7d };
}

module.exports = { create };
