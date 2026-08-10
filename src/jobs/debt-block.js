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
//
// Факт автоблока персистируется в clients.debt_blocked (миграция 056) — после
// рестарта восстановление по-прежнему знает, что порт гасили мы, а не оператор
// руками (ручной override «продлить до…» флаг не ставит и не снимает).

function create(deps) {
  const {
    logger, logActivity, alerts, auditLog,
    proxyConf, fetchApi, parseHtmlInputFields, findServer, proxySmart,
    ledgerDb, saveClients, getMoscowNow,
    fetchAllServersDataCached,
    clients,
  } = deps;

  const RESTORE_DAYS = 30;   // продление при восстановлении: сегодня + 30 дн

  function _mskDateStr(d) { return d.toLocaleDateString('en-CA'); }   // YYYY-MM-DD
  function _today() { return _mskDateStr(getMoscowNow()); }

  // Среднесуточное списание за 7 дн (charge-строки ledger за [today-7 .. today-1] / 7)
  // — тот же критерий, что в портале (billing_history.summary.avgDailyCharge7d).
  function avgDailyCharge7d(clientId) {
    const today = _today();
    const d7 = getMoscowNow();
    d7.setDate(d7.getDate() - 7);
    const from = _mskDateStr(d7);
    const total = (ledgerDb.listByClient(clientId) || [])
      .filter(e => e.type === 'charge' && e.date && e.date > from && e.date < today)
      .reduce((s, e) => s + (e.cost || 0), 0);
    return Math.round((total / 7) * 100) / 100;
  }

  // Все порты клиента по всем серверам (из уже загруженных server data).
  function _clientPorts(client, serverResults) {
    const ports = [];
    for (const data of serverResults || []) {
      for (const list of Object.values(data.ports || {})) {
        for (const p of list || []) {
          if (p && p.portName && p.portName === client.portName) {
            ports.push({
              server: findServer(data.serverName),
              portId: p.portID,
              validBefore: p.PROXY_VALID_BEFORE || ''
            });
          }
        }
      }
    }
    return ports.filter(pt => pt.server && pt.portId);
  }

  // Тот же путь, что POST /api/admin/save_port_config (proxies-ports.js):
  // форма целиком → правка одного поля → POST → apply_port.
  async function setPortValidBefore(server, portId, dateStr) {
    const form = await proxyConf.getConfForm(server, `/conf/edit_port/${portId}`);
    if (!form.ok) throw new Error(`edit_port form: ${form.reason}`);
    const formData = parseHtmlInputFields(form.html);
    if (!formData.proxy_password) {
      const portsData = await fetchApi(server, '/apix/list_ports_json');
      for (const plist of Object.values(portsData || {})) {
        for (const port of plist || []) {
          if (port.portID === portId && port.PASSWORD) { formData.proxy_password = port.PASSWORD; break; }
        }
        if (formData.proxy_password) break;
      }
    }
    formData.PROXY_VALID_BEFORE = dateStr;
    const posted = await proxyConf.postConfForm(server, `/conf/edit_port/${portId}`, formData);
    if (!posted.ok) throw new Error(`edit_port post: ${posted.reason}`);
    await fetchApi(server, `/apix/apply_port?arg=${encodeURIComponent(portId)}`);
    if (proxySmart && typeof proxySmart.invalidateCache === 'function') proxySmart.invalidateCache();
  }

  // ── Пост-биллинговый проход: блокировка должников + прогноз «за 3 дня» ──
  async function runAfterDailyBilling(clients, serverResults) {
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
