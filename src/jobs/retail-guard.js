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
//      (пустой portName, B6, подтверждается свежим чтением) → строка в free +
//      admin-алерт. Неизвестный сервер / невалидный дедлайн / неподтверждённая
//      отвязка → НЕ free: durable-маркер pending_release, повтор в след. цикле
//      (DEEP-15, §15.2).
//
// Дедуп уведомлений: kv_store, ключ guard:dedup:{clientId}:{kind}:{YYYY-MM-DD}.

function create(deps) {
  const {
    logger, logActivity, auditLog, alerts,
    proxyConf, findServer,
    fetchApi,                // WP7 (Э5): монитор уникальности IP (unique_ips_json)
    saveClients, getMoscowNow,
    fetchAllServersDataCached,
    clients, retailPoolDb, retailPurchasesDb, tariffsDb, getSetting,
    atomicDebit,             // DEEP-22: досписание charge_failed по purchase_id
    notifyClient,
    kvGet, kvSet,
  } = deps;

  const portValidity = require('../services/port-validity').create(deps);

  const DAY_MS = 86400000;
  let pendingRestoreRows = new Set();

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
      // DEEP-47 (2026-09-24): архивный тариф (active=0) действует для
      // существующих назначений — то же решение, что billing.getClientPrice.
      if (t && t.price > 0) return t.price;
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
  async function _blockClient(client, portsIndex, stats) {
    const today = _today();
    const holdDays = _holdDays(client);
    const holdUntil = holdDays === -1 ? null : _iso(_nowMs() + holdDays * DAY_MS);

    let blockedPorts = 0;
    for (const pt of portValidity.clientPortsFromIndex(client, portsIndex)) {
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
  // DEEP-09 (§15.1): unblock строки пула — условный UPDATE (status='blocked').
  // changes=0 означает, что строку уже изменил другой писатель (переаренда,
  // ручной unblock) — это конфликт, а не подтверждённое восстановление.
  function _confirmUnblock(row, client) {
    const res = retailPoolDb.unblock(row.id);
    if (res && res.changes === 0) {
      logger.warn(`[RetailGuard] ${client.login}: pool#${row.id} (${row.server}/${row.port_id}) — конфликт unblock (строка уже изменена), порт остаётся pending`);
      logActivity('billing', 'warn', 'retail_restore_conflict', client.login,
        `Восстановление: строка пула ${row.server}/${row.port_id} изменена конкурентно — повтор в след. цикле`,
        { client_id: client.id, port_id: row.port_id });
      return false;
    }
    return true;
  }

  async function _restoreClient(client, portsIndex, blockedRows, stats) {
    // WP7 (Э5): порты, замороженные антифродом (kv-маркер abuse_hold из
    // domain-guard), НЕ воскрешаем автоматически — разблокировка только
    // админом («Реабилитировать порт»). Долговой конвейер такого клиента
    // оставляем как есть (баланс плюсовой — гасить нечего).
    try {
      const marker = kvGet(`abuse_hold:${client.id}`);
      if (marker && marker.value && JSON.parse(marker.value).length) return false;
    } catch (_) { /* маркер битый/нет kv — не блокируем восстановление по долгу */ }
    const balance = client.balance || 0;
    const avg = portValidity.avgDailyCharge7d(client.id);
    // avg = 0 → 30 дн дефолт; floor=0 (баланса < сутки) — минимум 1 день,
    // иначе «дата до» = сегодня и порт умирал бы сразу после восстановления.
    const days = avg > 0 ? Math.max(1, Math.floor(balance / avg)) : 30;
    let untilStr = blockedRows.map(r => r.restore_until).filter(Boolean).sort()[0] || null;
    // DEEP-14 (§15.1): legacy-клиент без строк пула тоже получает ФИКСИРОВАННУЮ
    // цель — иначе ежедневный retry пересчитывал «дата до» от сегодня и
    // бесконечно сдвигал срок вперёд. Храним в clients.debt_restore_until
    // (миграция 089), как legacy debt-block.
    if (!untilStr && blockedRows.length === 0) untilStr = client.debtRestoreUntil || null;
    // Цель из прошлого (retry после долгого простоя) продлевала бы порт
    // задним числом — пересчитываем от сегодня и пересохраняем.
    if (untilStr && untilStr <= _today()) untilStr = null;
    if (!untilStr) {
      const until = getMoscowNow();
      until.setDate(until.getDate() + days);
      untilStr = until.toLocaleDateString('en-CA');
      if (blockedRows.length) {
        for (const row of blockedRows) {
          if (typeof retailPoolDb.setRestoreUntil === 'function') retailPoolDb.setRestoreUntil(row.id, untilStr);
          row.restore_until = untilStr;
        }
      } else {
        // DEEP-10: цель legacy-восстановления должна быть durable ДО сетевых
        // действий; отказ записи → отмена попытки, повтор в следующем цикле.
        client.debtRestoreUntil = untilStr;
        if (saveClients(clients) === false) {
          client.debtRestoreUntil = null;
          logger.error(`[RetailGuard] ${client.login}: цель восстановления не сохранена — сетевые действия отменены`);
          logActivity('billing', 'error', 'retail_restore_persist_error', client.login,
            'Восстановление: не удалось сохранить цель retry в БД — попытка отменена', { client_id: client.id });
          return false;
        }
      }
    }

    const livePorts = portValidity.clientPortsFromIndex(client, portsIndex);
    // DEEP-14: смешанный набор pool+legacy — порты клиента, не имеющие строки
    // пула, включаем в восстановление как legacy-элементы (раньше при наличии
    // blockedRows они молча пропускались и оставались погашенными).
    const pooledKeys = new Set(retailPoolDb.byClient(client.id).map(r => `${r.server}:${r.port_id}`));
    const legacyPorts = livePorts.filter(pt => pt.server && !pooledKeys.has(`${pt.server.name}:${pt.portId}`));
    const required = [
      ...blockedRows.map(row => ({ row, pt: livePorts.find(pt => pt.server && pt.server.name === row.server && pt.portId === row.port_id) })),
      ...legacyPorts.map(pt => ({ row: null, pt })),
    ];
    let restored = 0;
    let pending = 0;
    for (const item of required) {
      const pt = item.pt;
      if (!pt) { pending++; continue; }
      // Не укорачиваем более поздний срок (ручной override «продлить до…»).
      if (pt.validBefore && pt.validBefore > untilStr) {
        if (item.row && !_confirmUnblock(item.row, client)) { pending++; continue; }
        restored++;
        continue;
      }
      try {
        // DEEP-09: владелец перепроверяется свежим чтением до POST и после
        // apply — retry не должен продлить порт, уже переданный другому.
        await portValidity.setPortValidBefore(pt.server, pt.portId, untilStr, { expectedPortName: client.portName });
        if (item.row && !_confirmUnblock(item.row, client)) { pending++; continue; }
        restored++;
      } catch (e) {
        pending++;
        logger.error(`[RetailGuard] ${client.login}: порт ${pt.portId} не продлён: ${e.message}`);
        logActivity('billing', 'error', 'retail_restore_error', client.login,
          `Восстановление: порт ${pt.portId} не продлён: ${e.message}`, { client_id: client.id, port_id: pt.portId });
      }
    }
    if (pending > 0 || required.length === 0) {
      for (const item of required) if (item.row && (!item.pt || item.row.status === 'blocked')) pendingRestoreRows.add(item.row.id);
      logger.warn(`[RetailGuard] ${client.login}: восстановлено ${restored}/${required.length}, pending=${pending || required.length}`);
      return false;
    }
    client.balanceNegativeSince = null;
    client.debtBlocked = false;   // сброс legacy-флага (миграция 056)
    client.debtRestoreUntil = null;   // DEEP-14: фиксированная цель legacy retry отработала

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
  async function _deleteLegacyPorts(client, portsIndex, stats) {
    if (retailPoolDb.byClient(client.id).length) return;   // не legacy — владеет фаза по строкам
    if (_holdDays(client) === -1) return;                  // ∞ hold — НИКОГДА
    const dl = _holdDeadlineMs(client);
    if (!dl || _nowMs() < dl) return;
    for (const pt of portValidity.clientPortsFromIndex(client, portsIndex)) {
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
  async function _processClient(client, portsIndex, stats) {
    const balance = client.balance || 0;

    // Клиент без портов (свежая регистрация, порты удалены по hold) —
    // нечего продлевать/блокировать: grace- и low-balance-уведомления не шлём.
    const ownsPorts = retailPoolDb.byClient(client.id).length > 0
      || portValidity.clientPortsFromIndex(client, portsIndex).length > 0;
    if (!ownsPorts) return false;

    if (balance > 0) {
      const blockedRows = retailPoolDb.byClient(client.id).filter(r => r.status === 'blocked');
      if (client.balanceNegativeSince || blockedRows.length) {
        return await _restoreClient(client, portsIndex, blockedRows, stats);
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
    await _blockClient(client, portsIndex, stats);
    await _holdWarnings(client);
    await _deleteLegacyPorts(client, portsIndex, stats);
    return false;
  }

  // ── фаза по строкам пула: hold истёк → удалить порт + строку (шаг 3) ──
  async function _processExpiredHolds(stats) {
    for (const row of retailPoolDb.byStatus('blocked')) {
      if (pendingRestoreRows.has(row.id)) continue;
      if (!row.hold_until) continue;                       // ∞ hold (-1) — НИКОГДА
      if (Date.parse(row.hold_until) > _nowMs()) continue;
      // FIX-03 п.9 / DEEP-06 (§15.1): незавершённое восстановление защищено и
      // после рестарта — in-memory pendingRestoreRows недостаточно. Durable-
      // маркер restore_until у клиента с положительным балансом = retry в
      // полёте: порт по старому hold_until НЕ удаляем. При balance ≤ 0
      // блок-фаза начнёт новый цикл и сбросит маркер (block() обнуляет
      // restore_until) — удаление снова разрешено.
      if (row.restore_until) {
        const owner = clients.find(c => c.id === row.client_id);
        if (owner && (owner.balance || 0) > 0) continue;
      }
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
    // 2026-09-18 · DEEP-15 (§15.2): leased → free только после ПОДТВЕРЖДЁННОЙ
    // отвязки. Неизвестный/недоступный сервер, невалидный дедлайн или apply без
    // фактической смены portName НЕ переводят порт в free — иначе он продавался
    // бы с живым доступом прежнего клиента. Такая строка хранит durable-маркер
    // pending_release (миграция 095) и повторяется в следующих циклах.
    const _pending = (row, reason) => {
      if (typeof retailPoolDb.markPendingRelease === 'function') retailPoolDb.markPendingRelease(row.id, reason);
      logger.error(`[RetailGuard] test-day return ${row.server}/${row.port_id}: ${reason} — порт НЕ возвращён в free, повтор в след. цикле`);
    };
    for (const row of retailPoolDb.byStatus('leased')) {
      if (!row.test_expires_at && !row.pending_release) continue;
      const dlMs = row.test_expires_at ? Date.parse(row.test_expires_at) : NaN;
      if (!Number.isFinite(dlMs)) {
        // Битая дата — диагностируемое состояние; в free не переводим.
        _pending(row, 'invalid_deadline');
        continue;
      }
      if (dlMs > _nowMs() && !row.pending_release) continue;
      const server = findServer(row.server);
      if (!server) {
        // Сервер удалён из конфигурации/недоступен — отвязать и подтвердить
        // нечем; строка остаётся leased (порт недоступен для продажи).
        _pending(row, 'server_unknown');
        continue;
      }
      const client = clients.find(c => c.id === row.client_id) || null;
      try {
        // Отвязка пустым portName (B6) — порт выключается и ждёт следующей
        // выдачи; setPortName подтверждает сохранённое назначение свежим чтением.
        await portValidity.setPortName(server, row.port_id, '');
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
        _pending(row, 'unbind_unconfirmed');
        logger.error(`[RetailGuard] test-day return ${row.server}/${row.port_id}: ${e.message} — повтор в след. цикле`);
      }
    }
  }

  // ── WP5: пул на исходе — «свободных < retail_pool_min_free» СУММАРНО по
  // всем боксам розницы (20.08: раньше алерт шёл по каждому серверу раз в
  // час — шумно; суть метрики — «в пуле в принципе есть что продавать»).
  // Проверка в тике покрывает и покупки, и возвраты/удаления; дедуп +
  // cooldown сутки — внутри alerts.trigger (правило retail_pool_low).
  function _checkPoolLow() {
    try {
      const minFree = Number(getSetting('retail_pool_min_free', 3));
      const servers = String(getSetting('retail_pool_servers', '')).split(',').map(s => s.trim()).filter(Boolean);
      if (!servers.length) return;
      const freeRows = retailPoolDb.byStatus('free');
      const perServer = servers.map(srv => ({ server: srv, free: freeRows.filter(r => r.server === srv).length }));
      const totalFree = perServer.reduce((a, s) => a + s.free, 0);
      if (totalFree < minFree) {
        alerts.trigger('retail_pool_low', {
          free: totalFree, min: minFree,
          breakdown: perServer.map(s => `${s.server}: ${s.free}`).join(', '),
        });
      }
    } catch (e) { logger.warn('[RetailGuard] pool_low check: ' + e.message); }
  }

  // ── WP7 (Э5): монитор качества пула — деградация уникальности IP на
  // розничных боксах. Метрика существующая: /apix/unique_ips_json
  // (UNIQUE_IPS_PERCENT за 14 дней, та же, что в карточках серверов). Тик
  // 10 мин — как UI-кэш servers.js; дедуп/cooldown по серверу — в alerts.js.
  // retail_min_unique_ips = 0 → монитор выключен.
  async function _checkPoolIpQuality() {
    try {
      const minUniq = Number(getSetting('retail_min_unique_ips', 50));
      if (!minUniq) return;
      const servers = String(getSetting('retail_pool_servers', '')).split(',').map(s => s.trim()).filter(Boolean);
      for (const srv of servers) {
        const server = findServer(srv);
        if (!server) continue;
        let uniq = null;
        try { uniq = await fetchApi(server, '/apix/unique_ips_json', 12000); } catch (e) {
          logger.warn(`[RetailGuard] unique_ips ${srv}: ${e.message}`);
          continue;
        }
        const pct = uniq && Number(uniq.UNIQUE_IPS_PERCENT);
        if (Number.isFinite(pct) && pct < minUniq) {
          alerts.trigger('retail_pool_ip_degraded', { server: srv, uniqueIps: pct, min: minUniq });
        }
      }
    } catch (e) { logger.warn('[RetailGuard] ip_quality check: ' + e.message); }
  }

  // ── 2026-09-18 · DEEP-22 (§ FIX-SPEC): recovery durable-покупок ──
  // Три durable-состояния требуют исполнителя после рестарта/сбоя:
  //   charge_failed — порт выдан, списание не прошло → досписываем по
  //     purchase_id (idx_ledger_purchase_unique делает повтор duplicate);
  //   quarantine — исход сети неизвестен → reconcile по СВЕЖЕМУ владельцу
  //     порта: пустой portName = подтверждённая отвязка (порт → free), логин
  //     клиента = порт фактически выдан (lease + досписание), чужой логин —
  //     ручная сверка, порт НЕ free;
  //   истёкшие reserved — само истечение TTL не доказывает отсутствие
  //     выданного порта: владелец проверяется свежим чтением реестра бокса.
  // created_at хранится в SQLite-UTC; дата списания — в зоне биллинга (МСК),
  // как у buy_proxy (getMoscowNow).
  function _mskDateOfUtc(sqliteTs) {
    const ms = Date.parse(String(sqliteTs || '').replace(' ', 'T') + 'Z');
    if (!Number.isFinite(ms)) return _today();
    return new Date(ms + 3 * 3600e3).toISOString().slice(0, 10);
  }
  // Свежий владелец порта на боксе: null — порт не найден/бокс недоступен
  // (состояние неизвестно — НЕ основание для free).
  async function _freshPortOwner(serverName, portId) {
    const server = findServer(serverName);
    if (!server) return null;
    let portsData;
    try { portsData = await fetchApi(server, '/apix/list_ports_json'); } catch (_) { return null; }
    for (const plist of Object.values(portsData || {})) {
      for (const p of plist || []) {
        if (p && p.portID === portId) return String(p.portName || '').trim();
      }
    }
    return null;
  }
  function _retryCharge(p, client) {
    const res = atomicDebit(client.id, p.amount, {
      date: _mskDateOfUtc(p.created_at),
      type: 'charge',
      note: p.test_day ? 'test_day' : 'first_day',
      cost: p.amount,
      purchase_id: p.id,
    }, { minBalance: 0 });
    return res;
  }
  async function _processPurchaseRecovery(stats) {
    if (!retailPurchasesDb || !atomicDebit) return;
    // 1) charge_failed → досписание. INSUFFICIENT_BALANCE — ждём пополнения
    // (статус сохраняется, in-flight блокирует новые покупки до сверки).
    for (const p of retailPurchasesDb.recoverableCharges()) {
      const client = clients.find(c => c.id === p.client_id);
      if (!client) {
        retailPurchasesDb.setStatus(p.id, 'quarantine', 'client_gone');
        continue;
      }
      try {
        _retryCharge(p, client);   // duplicate = уже списано этим purchase_id
        retailPurchasesDb.setStatus(p.id, 'charged');
        stats.purchaseCharged.push(p.id);
        logger.info(`[RetailGuard] recovery: покупка ${p.id} досписана (${p.amount} ₽, ${client.login})`);
        saveClients(clients);
      } catch (e) {
        if (e && e.code === 'INSUFFICIENT_BALANCE') {
          logger.warn(`[RetailGuard] recovery: ${p.id} — недостаточно средств, ждём пополнения (${client.login})`);
        } else {
          logger.error(`[RetailGuard] recovery: ${p.id} — ${e.message}`);
        }
      }
    }
    // 2) quarantine → reconcile по свежему владельцу.
    for (const p of retailPurchasesDb.quarantined()) {
      const owner = await _freshPortOwner(p.server, p.port_id);
      if (owner === null) continue;   // неизвестно — повтор в след. цикле
      const row = p.pool_row_id != null ? retailPoolDb.byId(p.pool_row_id) : null;
      const client = clients.find(c => c.id === p.client_id);
      if (!owner) {
        if (row && row.status !== 'free') retailPoolDb.release(row.id);
        retailPurchasesDb.setStatus(p.id, 'failed', 'unbind_confirmed');
        logger.info(`[RetailGuard] recovery: ${p.id} — отвязка подтверждена, ${p.server}/${p.port_id} → free`);
        continue;
      }
      if (client && owner === client.login) {
        if (row && row.status === 'reserved') retailPoolDb.lease(row.id);
        // Порт фактически выдан — доводим через ветку досписания.
        retailPurchasesDb.setStatus(p.id, 'charge_failed', 'reconcile_issued');
        logger.warn(`[RetailGuard] recovery: ${p.id} — порт ${p.server}/${p.port_id} выдан ${client.login}, досписание в этом/след. цикле`);
        continue;
      }
      logger.error(`[RetailGuard] recovery: ${p.id} — ${p.server}/${p.port_id} занят чужим portName «${owner}», требуется ручная сверка; порт НЕ free`);
      logActivity('billing', 'error', 'retail_purchase_reconcile', null,
        `Покупка ${p.id}: порт ${p.server}/${p.port_id} занят «${owner}» вместо ожидаемого — ручная сверка`,
        { purchase_id: p.id, client_id: p.client_id, owner });
    }
    // 3) Истёкшие reserved. Grace 2× TTL: строку, захваченную < 10 минут
    // назад, может ещё обслуживать живой запрос buy_proxy — не трогаем.
    const graceMs = 10 * 60e3;
    const _exp = retailPoolDb.expiredReservations();
    for (const row of _exp) {
      if (Date.parse(row.reserved_until) > _nowMs() - graceMs) continue;
      const p = retailPurchasesDb.byPoolRow ? retailPurchasesDb.byPoolRow(row.id) : null;
      if (p && (p.status === 'quarantine' || p.status === 'charge_failed')) continue;   // свои ветки выше
      if (p && p.status === 'charged') {
        retailPoolDb.lease(row.id);   // списание прошло, lease не дошёл
        continue;
      }
      const owner = await _freshPortOwner(row.server, row.port_id);
      if (owner === null) {
        logger.error(`[RetailGuard] pool#${row.id} (${row.server}/${row.port_id}): владелец не подтверждён (бокс недоступен/порт не найден) — НЕ free, повтор в след. цикле`);
        continue;
      }
      const client = clients.find(c => c.id === row.client_id);
      if (!owner) {
        retailPoolDb.release(row.id);
        if (p && ['reserved', 'provisioning', 'provisioned'].includes(p.status)) {
          retailPurchasesDb.setStatus(p.id, 'failed', 'reservation_expired_unbound');
        }
        logger.info(`[RetailGuard] pool#${row.id} (${row.server}/${row.port_id}): резерв истёк, portName пуст → free`);
        continue;
      }
      if (client && owner === client.login) {
        // Порт выдан, процесс умер до lease/списания — доводим, не free.
        retailPoolDb.lease(row.id);
        if (p && ['reserved', 'provisioning', 'provisioned'].includes(p.status)) {
          retailPurchasesDb.setStatus(p.id, 'charge_failed', 'reconcile_issued');
        }
        logger.warn(`[RetailGuard] pool#${row.id} (${row.server}/${row.port_id}): резерв истёк, но порт выдан ${client.login} — lease + досписание`);
        continue;
      }
      logger.error(`[RetailGuard] pool#${row.id} (${row.server}/${row.port_id}): занят чужим portName «${owner}» — ручная сверка, НЕ free`);
      if (p && ['reserved', 'provisioning', 'provisioned'].includes(p.status)) {
        retailPurchasesDb.setStatus(p.id, 'quarantine', 'owner_mismatch');
      }
    }
  }

  let running = false;   // re-entrancy: прогон один за раз

  async function runOnce() {
    if (!getSetting('retail_enabled', false)) return { skipped: 'retail_disabled' };
    if (running) return { skipped: 'already_running' };
    running = true;
    pendingRestoreRows = new Set();
    const stats = { grace: [], blocked: [], restored: [], deleted: [], testDayEnded: [], purchaseCharged: [] };
    try {
      const serverResults = await fetchAllServersDataCached();
      // §17.3.4: индекс portName → порты ОДИН раз на проход (раньше — полный
      // скан фида на каждого клиента и каждый вызов clientPorts).
      const portsIndex = portValidity.clientPortsIndex(serverResults);
      let dirty = false;
      for (const client of clients) {
        if (client.clientType === 'legal') continue;   // юрлица — НИКОГДА
        if (client.allowDebt) continue;                // allow_debt = 1 — не трогаем
        if (client.billingPaused) continue;            // учёт отключён (политика Б, 2026-09-11): порты бессрочные, конвейер не трогает
        if (client.blocked) continue;                  // WP7: антифрод-блок — конвейер на паузе, разблокировка только админом
        if (!client.portName) continue;
        try {
          if (await _processClient(client, portsIndex, stats)) dirty = true;
        } catch (e) {
          logger.error(`[RetailGuard] ${client.login || client.id}: ${e.message}`);
        }
      }
      if (dirty && saveClients(clients) === false) {
        // DEEP-10: отказ записи виден как ошибка persistence, а не тихий успех.
        logger.error('[RetailGuard] saveClients: состояние клиентов НЕ сохранено — изменения будут повторены в след. цикле');
        logActivity('billing', 'error', 'retail_guard_persist_error', 'system',
          'RetailGuard: ошибка сохранения состояния клиентов в БД', {});
      }
      await _processExpiredHolds(stats);
      await _processExpiredTestDays(stats);
      await _processPurchaseRecovery(stats);   // DEEP-22: durable-покупки и истёкшие резервы
      _checkPoolLow();   // WP5: алерт «свободных < retail_pool_min_free» (дедуп по серверу в alerts.js)
      await _checkPoolIpQuality();   // WP7 (Э5): деградация уникальности IP розничных боксов
      return stats;
    } finally {
      running = false;
    }
  }

  return { runOnce };
}

module.exports = { create };
