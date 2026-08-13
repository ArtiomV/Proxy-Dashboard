'use strict';
//
// src/jobs/retail-guard.js — B2C Этап 2: конвейер автоблока розницы.
// Цикл 10 минут (src/boot/startup.js), работает ТОЛЬКО при retail_enabled=true;
// флаг проверяется на каждом прогоне — включение настройки подхватывается
// без рестарта. При выключенном флаге конвейером владеет legacy debt-block.
//
// Население: физики (client_type != 'legal') с allow_debt = 0 и portName.
// Юрлица — НИКОГДА.
//
// Механика (ТЗ «B2C», консолидированное 10.08):
//   1. balance ≤ 0 → фиксируем balance_negative_since, grace
//      (retail_grace_hours, дефолт 24ч): порт РАБОТАЕТ, клиенту — уведомление.
//   2. grace истёк → «дата до» = сегодня для всех портов клиента
//      (setPortValidBefore, src/services/port-validity.js); строки пула
//      leased → blocked с hold_until = now + hold_ttl_days
//      (per-клиент; NULL в clients → retail_hold_days=7; -1 → hold_until=NULL,
//      порт НИКОГДА не удаляется).
//   3. hold_until прошёл → delete_port на боксе + DELETE строки пула + audit.
//      Legacy-клиентам (порт без строки пула) дедлайн считается от
//      balance_negative_since + grace + hold — порт удаляется так же.
//      Фейл удаления → error-лог, повтор в следующем цикле.
//   4. balance > 0 (и есть долговой след) → восстановление: «дата до» =
//      сегодня + floor(balance / avgDailyCharge7d) дн (avg=0 → 30 дн),
//      более поздний ручной срок не укорачиваем; blocked → leased,
//      balance_negative_since/legacy-флаг debt_blocked сбрасываются.
//   5. Предупреждения за 3 и 1 день до hold_until (дедуп kv по дате).
//   6. Low-balance: runway = balance / (price/дней_в_месяце) ≤ 3/1 дн
//      → уведомление (дедуп kv по дате, фактически 1/сутки).
//   7. Тест-день: leased с test_expires_at < now → отвязка порта
//      (пустой portName, B6) → строка в free + admin-алерт.
//
// Дедуп уведомлений: kv_store, ключ guard:dedup:{clientId}:{kind}:{YYYY-MM-DD}.

function create(deps) {
  const {
    logger, logActivity, auditLog, alerts,
    proxyConf, findServer,
    saveClients, getMoscowNow,
    fetchAllServersDataCached,
    clients, retailPoolDb, tariffsDb, getSetting,
    notifyClient,
    kvGet, kvSet,
  } = deps;

  const portValidity = require('../services/port-validity').create(deps);

  const DAY_MS = 86400000;

  function _nowMs() { return getMoscowNow().getTime(); }
  function _today() { return getMoscowNow().toLocaleDateString('en-CA'); }   // YYYY-MM-DD
  function _iso(ms) { return new Date(ms).toISOString(); }
  function _graceHours() { return Number(getSetting('retail_grace_hours', 24)) || 24; }
  // per-клиент hold_ttl_days (Р33): NULL → дефолт из настройки; -1 → ∞ hold.
  function _holdDays(client) {
    return client.holdTtlDays != null ? client.holdTtlDays : (Number(getSetting('retail_hold_days', 7)) || 7);
  }

  // ── дедуп уведомлений по дате ──
  function _dedupKey(clientId, kind) { return `guard:dedup:${clientId}:${kind}:${_today()}`; }
  async function _notifyOnce(client, kind, text, details) {
    try {
      const row = kvGet(_dedupKey(client.id, kind));
      if (row && row.value) return false;
      kvSet(_dedupKey(client.id, kind), '1');
    } catch (_) { /* kv недоступен — шлём без дедупа */ }
    try { await notifyClient(client, text, { details }); } catch (e) {
      logger.warn(`[RetailGuard] notify ${client.login}: ${e.message}`);
    }
    return true;
  }

  // Цена для runway — та же логика, что billing.getClientPrice (Р36):
  // price_override → тариф → legacy clients.price.
  function _clientPrice(client) {
    if (typeof client.priceOverride === 'number' && client.priceOverride > 0) return client.priceOverride;
    if (client.tariffId != null && tariffsDb) {
      const t = tariffsDb.byId(client.tariffId);
      if (t && t.active && t.price > 0) return t.price;
    }
    return client.price || 0;
  }

  // Дедлайн удаления порта (hold): по blocked-строкам пула, а для legacy —
  // balance_negative_since + grace + hold. NULL = ∞ (hold_ttl_days = -1).
  function _holdDeadlineMs(client) {
    const holdDays = _holdDays(client);
    if (holdDays === -1) return null;
    const rows = retailPoolDb.byClient(client.id)
      .filter(r => r.status === 'blocked' && r.hold_until);
    if (rows.length) return Math.min(...rows.map(r => Date.parse(r.hold_until)));
    if (client.balanceNegativeSince) {
      return Date.parse(client.balanceNegativeSince) + _graceHours() * 3600000 + holdDays * DAY_MS;
    }
    return null;
  }

  // ── шаг 2: grace истёк → гасим порты + leased → blocked ──
  async function _blockClient(client, serverResults, stats) {
    const today = _today();
    const holdDays = _holdDays(client);
    const holdUntil = holdDays === -1 ? null : _iso(_nowMs() + holdDays * DAY_MS);

    let blockedPorts = 0;
    for (const pt of portValidity.clientPorts(client, serverResults)) {
      // Уже погашен (в т.ч. нами на прошлых циклах) — не перезаписываем.
      const vbMs = Date.parse(pt.validBefore);
      if (!isNaN(vbMs) && pt.validBefore && pt.validBefore <= today) continue;
      try {
        await portValidity.setPortValidBefore(pt.server, pt.portId, today);
        blockedPorts++;
      } catch (e) {
        logger.error(`[RetailGuard] ${client.login}: порт ${pt.portId} не погашен: ${e.message}`);
        logActivity('billing', 'error', 'retail_block_error', client.login,
          `Автоблок: порт ${pt.portId} не погашен: ${e.message}`, { client_id: client.id, port_id: pt.portId });
      }
    }

    let blockedRows = 0;
    for (const row of retailPoolDb.byClient(client.id)) {
      if (row.status !== 'leased') continue;   // reserved — провижининг в полёте, не трогаем
      retailPoolDb.block(row.id, holdUntil);
      blockedRows++;
    }
    if (blockedPorts === 0 && blockedRows === 0) return;

    stats.blocked.push(client.id);
    logger.warn(`[RetailGuard] ${client.login}: баланс ${client.balance} ₽ — портов погашено: ${blockedPorts}, строк пула blocked: ${blockedRows}`);
    try { auditLog('system', 'retail_block', { clientId: client.id, clientName: client.name, balance: client.balance, portsBlocked: blockedPorts, rowsBlocked: blockedRows, holdUntil }); } catch (_) { /* audit best-effort */ }
    await _notifyOnce(client, 'blocked',
      `Прокси отключён по неоплате (баланс ${client.balance} ₽). ` +
      (holdDays === -1
        ? 'Порт сохраняется за вами бессрочно'
        : `Порт храним ${holdDays} дн., затем он будет удалён`) +
      '. После пополнения доступ восстановится автоматически.',
      { client_id: client.id, hold_until: holdUntil });
  }

  // ── шаг 4: balance > 0 → восстановление ──
  async function _restoreClient(client, serverResults, blockedRows, stats) {
    const balance = client.balance || 0;
    const avg = portValidity.avgDailyCharge7d(client.id);
    // avg = 0 → 30 дн дефолт; floor=0 (баланса < сутки) — минимум 1 день,
    // иначе «дата до» = сегодня и порт умирал бы сразу после восстановления.
    const days = avg > 0 ? Math.max(1, Math.floor(balance / avg)) : 30;
    const until = getMoscowNow();
    until.setDate(until.getDate() + days);
    const untilStr = until.toLocaleDateString('en-CA');

    let restored = 0;
    for (const pt of portValidity.clientPorts(client, serverResults)) {
      // Не укорачиваем более поздний срок (ручной override «продлить до…»).
      if (pt.validBefore && pt.validBefore > untilStr) continue;
      try {
        await portValidity.setPortValidBefore(pt.server, pt.portId, untilStr);
        restored++;
      } catch (e) {
        logger.error(`[RetailGuard] ${client.login}: порт ${pt.portId} не продлён: ${e.message}`);
        logActivity('billing', 'error', 'retail_restore_error', client.login,
          `Восстановление: порт ${pt.portId} не продлён: ${e.message}`, { client_id: client.id, port_id: pt.portId });
      }
    }
    for (const row of blockedRows) retailPoolDb.unblock(row.id);
    client.balanceNegativeSince = null;
    client.debtBlocked = false;   // сброс legacy-флага (миграция 056)

    stats.restored.push(client.id);
    logger.info(`[RetailGuard] ${client.login}: восстановлен (${balance} ₽) — «дата до» = ${untilStr}, портов: ${restored}, строк unblock: ${blockedRows.length}`);
    try { auditLog('system', 'retail_restore', { clientId: client.id, clientName: client.name, balance, portsRestored: restored, validBefore: untilStr, avgDaily: avg }); } catch (_) { /* audit best-effort */ }
    await _notifyOnce(client, 'restored',
      `Оплата получена — сервис восстановлен. Прокси продлён до ${untilStr}.`,
      { client_id: client.id, valid_before: untilStr });
    return true;   // клиент мутирован → saveClients
  }

  // ── шаг 5: предупреждения за 3 и 1 день до hold_until ──
  async function _holdWarnings(client) {
    const dl = _holdDeadlineMs(client);
    if (!dl) return;
    const left = dl - _nowMs();
    if (left <= 0) return;
    if (left <= DAY_MS) {
      await _notifyOnce(client, 'hold_warn_1d',
        'До удаления порта остались сутки. Пополните баланс — порт сохранится и включится автоматически.',
        { client_id: client.id, hold_until: _iso(dl) });
    } else if (left <= 3 * DAY_MS) {
      await _notifyOnce(client, 'hold_warn_3d',
        `До удаления порта осталось ${Math.ceil(left / DAY_MS)} дн. Пополните баланс — порт сохранится и включится автоматически.`,
        { client_id: client.id, hold_until: _iso(dl) });
    }
  }

  // ── шаг 6: low-balance (runway ≤ 3/1 дн, дедуп по дате) ──
  async function _lowBalanceCheck(client) {
    const price = _clientPrice(client);
    if (price <= 0) return;
    const now = getMoscowNow();
    const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    const runway = (client.balance || 0) / (price / daysInMonth);
    if (runway <= 1) {
      await _notifyOnce(client, 'low_balance_1d',
        `Баланс ${client.balance} ₽ — хватит меньше чем на сутки. Пополните, чтобы прокси не отключился.`,
        { client_id: client.id, runway_days: Math.round(runway * 10) / 10 });
    } else if (runway <= 3) {
      await _notifyOnce(client, 'low_balance_3d',
        `Баланс ${client.balance} ₽ — хватит примерно на ${Math.floor(runway)} дн. Пополните, чтобы прокси не отключился.`,
        { client_id: client.id, runway_days: Math.round(runway * 10) / 10 });
    }
  }

  // ── шаг 3 (legacy): hold прошёл у клиента БЕЗ строк пула → удаляем порт ──
  async function _deleteLegacyPorts(client, serverResults, stats) {
    if (retailPoolDb.byClient(client.id).length) return;   // не legacy — владеет фаза по строкам
    if (_holdDays(client) === -1) return;                  // ∞ hold — НИКОГДА
    const dl = _holdDeadlineMs(client);
    if (!dl || _nowMs() < dl) return;
    for (const pt of portValidity.clientPorts(client, serverResults)) {
      const del = await proxyConf.getConfAction(pt.server, `/conf/delete_port/${encodeURIComponent(pt.portId)}`);
      if (!del.ok) {
        logger.error(`[RetailGuard] ${client.login}: delete_port ${pt.portId} failed: ${del.reason} — повтор в след. цикле`);
        continue;
      }
      stats.deleted.push(pt.portId);
      logger.warn(`[RetailGuard] ${client.login}: legacy-порт ${pt.portId} удалён (hold истёк)`);
      try { auditLog('system', 'retail_port_deleted', { clientId: client.id, clientName: client.name, server: pt.server.name, portId: pt.portId, legacy: true }); } catch (_) { /* audit best-effort */ }
      await _notifyOnce(client, 'deleted',
        'Срок хранения истёк — порт удалён. После пополнения баланса выдадим новый автоматически.',
        { client_id: client.id, port_id: pt.portId });
    }
  }

  // ── пер-клиентский конвейер (шаги 1–6) ──
  async function _processClient(client, serverResults, stats) {
    const balance = client.balance || 0;

    if (balance > 0) {
      const blockedRows = retailPoolDb.byClient(client.id).filter(r => r.status === 'blocked');
      if (client.balanceNegativeSince || blockedRows.length) {
        return await _restoreClient(client, serverResults, blockedRows, stats);
      }
      await _lowBalanceCheck(client);
      return false;
    }

    // balance ≤ 0
    if (!client.balanceNegativeSince) {
      // шаг 1: вход в grace — порт РАБОТАЕТ, только фиксируем и предупреждаем.
      client.balanceNegativeSince = _iso(_nowMs());
      stats.grace.push(client.id);
      await _notifyOnce(client, 'grace',
        `Баланс закончился (${balance} ₽). Прокси будет отключён через ${_graceHours()} ч. — пополните баланс в личном кабинете.`,
        { client_id: client.id, balance });
      return true;
    }
    if (_nowMs() < Date.parse(client.balanceNegativeSince) + _graceHours() * 3600000) {
      return false;   // grace ещё идёт
    }
    // grace истёк: блокируем (идемпотентно), дальше — hold-фаза.
    await _blockClient(client, serverResults, stats);
    await _holdWarnings(client);
    await _deleteLegacyPorts(client, serverResults, stats);
    return false;
  }

  // ── фаза по строкам пула: hold истёк → удалить порт + строку (шаг 3) ──
  async function _processExpiredHolds(stats) {
    for (const row of retailPoolDb.byStatus('blocked')) {
      if (!row.hold_until) continue;                       // ∞ hold (-1) — НИКОГДА
      if (Date.parse(row.hold_until) > _nowMs()) continue;
      const server = findServer(row.server);
      if (!server) {
        logger.error(`[RetailGuard] pool#${row.id}: сервер ${row.server} не найден — повтор в след. цикле`);
        continue;
      }
      const del = await proxyConf.getConfAction(server, `/conf/delete_port/${encodeURIComponent(row.port_id)}`);
      if (!del.ok) {
        logger.error(`[RetailGuard] pool#${row.id} (${row.server}/${row.port_id}): delete_port failed: ${del.reason} — повтор в след. цикле`);
        continue;
      }
      retailPoolDb.remove(row.id);
      stats.deleted.push(row.port_id);
      logger.warn(`[RetailGuard] Порт ${row.server}/${row.port_id} удалён (hold истёк), строка пула убрана`);
      try { auditLog('system', 'retail_port_deleted', { clientId: row.client_id, server: row.server, portId: row.port_id, holdUntil: row.hold_until }); } catch (_) { /* audit best-effort */ }
      const client = clients.find(c => c.id === row.client_id);
      if (client) {
        await _notifyOnce(client, 'deleted',
          'Срок хранения истёк — порт удалён. После пополнения баланса выдадим новый автоматически.',
          { client_id: client.id, port_id: row.port_id });
      }
    }
  }

  // ── фаза тест-дня: leased с test_expires_at < now → вернуть в пул (шаг 7) ──
  async function _processExpiredTestDays(stats) {
    for (const row of retailPoolDb.byStatus('leased')) {
      if (!row.test_expires_at) continue;
      if (Date.parse(row.test_expires_at) > _nowMs()) continue;
      const server = findServer(row.server);
      const client = clients.find(c => c.id === row.client_id) || null;
      try {
        // Отвязка пустым portName (B6) — порт выключается и ждёт следующей выдачи.
        if (server) await portValidity.setPortName(server, row.port_id, '');
        retailPoolDb.release(row.id);
        stats.testDayEnded.push(row.port_id);
        logger.info(`[RetailGuard] Тест-день завершён: ${row.server}/${row.port_id} → free`);
        try { auditLog('system', 'retail_test_day_ended', { clientId: row.client_id, server: row.server, portId: row.port_id }); } catch (_) { /* audit best-effort */ }
        try { alerts.trigger('retail_test_day_ended', { client: client ? client.login : row.client_id, client_id: row.client_id, server: row.server, port_id: row.port_id }); } catch (_) { /* alert best-effort */ }
        if (client) {
          try {
            await notifyClient(client,
              'Тест-день завершён — прокси возвращён в пул. Оформите подписку в личном кабинете, чтобы продолжить.',
              { action: 'retail_test_day_ended', details: { client_id: client.id, port_id: row.port_id } });
          } catch (_) { /* notify best-effort */ }
        }
      } catch (e) {
        logger.error(`[RetailGuard] test-day return ${row.server}/${row.port_id}: ${e.message} — повтор в след. цикле`);
      }
    }
  }

  let running = false;   // re-entrancy: прогон один за раз

  async function runOnce() {
    if (!getSetting('retail_enabled', false)) return { skipped: 'retail_disabled' };
    if (running) return { skipped: 'already_running' };
    running = true;
    const stats = { grace: [], blocked: [], restored: [], deleted: [], testDayEnded: [] };
    try {
      const serverResults = await fetchAllServersDataCached();
      let dirty = false;
      for (const client of clients) {
        if (client.clientType === 'legal') continue;   // юрлица — НИКОГДА
        if (client.allowDebt) continue;                // allow_debt = 1 — не трогаем
        if (!client.portName) continue;
        try {
          if (await _processClient(client, serverResults, stats)) dirty = true;
        } catch (e) {
          logger.error(`[RetailGuard] ${client.login || client.id}: ${e.message}`);
        }
      }
      if (dirty) saveClients(clients);
      await _processExpiredHolds(stats);
      await _processExpiredTestDays(stats);
      return stats;
    } finally {
      running = false;
    }
  }

  return { runOnce };
}

module.exports = { create };
