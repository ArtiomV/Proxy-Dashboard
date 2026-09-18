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
  const restoring = new Set();

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
      if (client.billingPaused) continue;               // учёт отключён (политика Б, 2026-09-11): «дата до» снимается при паузе, конвейер срок не ставит
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
        // DEEP-08 (§15.1): фиксируем ожидаемый набор восстановления ДО того,
        // как операция может частично завершиться, — отсутствие сервера в фиде
        // при retry не должно «уменьшать» набор до вернувшихся портов.
        client.debtRestorePorts = ports.map(pt => ({ server: pt.server.name, portId: pt.portId }));
        // Миграция 073: от этой метки джоба автоудаления отсчитывает hold
        // (retail_hold_days) до удаления портов. Не перезаписываем, если
        // клиент уже был заблокирован ранее (например, вручную) — hold
        // тикает от первой блокировки.
        if (!client.blockedSince) client.blockedSince = new Date().toISOString();
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
    if (dirty && saveClients(clients) === false) {
      // DEEP-10: отказ записи — явная ошибка persistence; debtBlocked и набор
      // ожидаемых портов не подтверждены БД, следующий прогон повторит.
      logger.error('[DebtBlock] saveClients: состояние блокировки НЕ сохранено — повтор в след. прогоне');
      logActivity('billing', 'error', 'debt_block_persist_error', 'system',
        'Автоблок: ошибка сохранения состояния клиентов в БД', {});
    }
  }

  // ── Восстановление после оплаты (вызывается по событию client-credit) ──
  async function _restoreAfterCredit(client) {
    if (_retailGuardOwns()) return false;   // Э2: восстановлением владеет retail-guard
    if (!client || !client.debtBlocked) return false;   // гасили не мы — не трогаем
    // DEEP-07 (§15.1): повторный допуск перед действием — ручная/антифрод-блок
    // или тарифная пауза, выставленные ПОСЛЕ долга, отменяют авто-восстановление;
    // такой клиент НЕ получает success и сброс debtBlocked.
    if (client.blocked) return false;
    if (client.billingPaused) return false;   // политика Б: на паузе срок не ставим
    if ((client.balance || 0) <= 0) return false;

    const results = await fetchAllServersDataCached();
    const livePorts = _clientPorts(client, results);
    const feedServers = new Set((results || []).map(r => r && r.serverName).filter(Boolean));

    let untilStr = client.debtRestoreUntil;
    // Цель из прошлого (retry после долгого простоя) продлевала бы порт
    // задним числом — пересчитываем от сегодня и пересохраняем.
    if (untilStr && untilStr <= _today()) untilStr = null;
    let needPersist = false;
    if (!untilStr) {
      const until = new Date(getMoscowNow().getTime() + RESTORE_DAYS * 86400000);
      untilStr = _mskDateStr(until);
      client.debtRestoreUntil = untilStr;
      needPersist = true;
    }
    // DEEP-08: durable-набор ожидаемых пар server+portID (миграция 092).
    // Для клиентов, заблокированных до фикса, набор отсутствует — собираем
    // из текущего фида и сохраняем; дальше отсутствие сервера в фиде
    // трактуется как pending, а не как успех.
    if (!Array.isArray(client.debtRestorePorts) || client.debtRestorePorts.length === 0) {
      client.debtRestorePorts = livePorts.map(pt => ({ server: pt.server.name, portId: pt.portId }));
      needPersist = true;
    }
    // DEEP-10 (§15.1): цель и ожидаемый набор должны быть durable ДО сетевых
    // действий. saveClients возвращает false при отказе записи — сеть не трогаем.
    if (needPersist && saveClients(clients) === false) {
      logger.error(`[DebtBlock] ${client.name}: цель восстановления не сохранена — сетевые действия отменены, повтор позже`);
      logActivity('billing', 'error', 'debt_restore_persist_error', client.name,
        'Восстановление: не удалось сохранить цель/набор портов в БД — retry отложен', { client_id: client.id });
      return false;
    }

    const liveByKey = new Map(livePorts.map(pt => [`${pt.server.name}:${pt.portId}`, pt]));
    const seen = new Set();
    const items = [];
    for (const ep of client.debtRestorePorts) {
      const key = `${ep.server}:${ep.portId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      items.push({ key, ep, pt: liveByKey.get(key) || null });
    }
    // Порты, появившиеся у клиента ПОСЛЕ блокировки, тоже восстанавливаем.
    for (const pt of livePorts) {
      const key = `${pt.server.name}:${pt.portId}`;
      if (!seen.has(key)) { seen.add(key); items.push({ key, ep: null, pt }); }
    }

    let restored = 0, pending = 0;
    const stillExpected = [];
    for (const item of items) {
      const pt = item.pt;
      if (!pt) {
        if (!feedServers.has(item.ep.server)) {
          // Сервер не отвечает: порт нельзя ни продлить, ни подтвердить — retry.
          pending++;
          stillExpected.push(item.ep);
          continue;
        }
        // Сервер в фиде, порта нет — удалён снаружи: снимаем с ожидания
        // (явная отмена по политике, отдельный результат — не «успех»).
        logger.warn(`[DebtBlock] ${client.name}: порт ${item.ep.server}/${item.ep.portId} отсутствует на отвечающем сервере — исключён из восстановления`);
        logActivity('billing', 'warn', 'debt_restore_port_gone', client.name,
          `Восстановление: порт ${item.ep.server}/${item.ep.portId} не найден на сервере — исключён`, { client_id: client.id, server: item.ep.server, port_id: item.ep.portId });
        continue;
      }
      // Не укорачиваем более поздний срок (ручной override «продлить до…»).
      if (pt.validBefore && pt.validBefore > untilStr) { restored++; continue; }
      try {
        // DEEP-09: владелец перепроверяется свежим чтением до POST и после apply.
        await setPortValidBefore(pt.server, pt.portId, untilStr, { expectedPortName: client.portName });
        restored++;
      } catch (e) {
        pending++;
        if (item.ep) stillExpected.push(item.ep);
        logger.error(`[DebtBlock] ${client.name}: не удалось продлить порт ${pt.portId}: ${e.message}`);
        logActivity('billing', 'error', 'debt_restore_error', client.name,
          `Восстановление: порт ${pt.portId} не продлён: ${e.message}`, { client_id: client.id, port_id: pt.portId });
      }
    }
    if (items.length === 0 || pending > 0) {
      // Частичный успех: сохраняем укороченный набор ожидания (подтверждённые
      // и внешне удалённые порты из него убраны), долговой след НЕ стираем.
      client.debtRestorePorts = stillExpected;
      saveClients(clients);
      logger.warn(`[DebtBlock] ${client.name}: восстановлено ${restored}/${items.length}, повтор будет выполнен позже`);
      return false;
    }
    client.debtBlocked = false;
    client.debtRestoreUntil = null;
    client.debtRestorePorts = null;
    if (!client.blocked) client.blockedSince = null;   // долг погашен, ручного блока нет — hold отменяется
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

  async function restoreAfterCredit(client) {
    if (!client || restoring.has(client.id)) return false;
    restoring.add(client.id);
    try { return await _restoreAfterCredit(client); }
    finally { restoring.delete(client.id); }
  }

  async function retryPendingRestores() {
    let restored = 0, pending = 0;
    for (const client of clients) {
      if (!client.debtBlocked || (client.balance || 0) <= 0) continue;
      // DEEP-07: ручной/антифрод-блок и тарифная пауза — не retry, а чужая
      // политика; не считаем таких ни восстановленными, ни pending-должниками.
      if (client.blocked || client.billingPaused) continue;
      if (await restoreAfterCredit(client)) restored++;
      else pending++;
    }
    return { restored, pending };
  }

  return { runAfterDailyBilling, restoreAfterCredit, retryPendingRestores, setPortValidBefore, avgDailyCharge7d };
}

module.exports = { create };
