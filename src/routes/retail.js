'use strict';
//
// src/routes/retail.js — B2C покупка прокси (WP2, ТЗ 10.08).
//
//   POST /api/client/buy_proxy { tariff_id } — автовыдача из пула:
//     проверки → durable-покупка (retail_purchases, DEEP-22) → reserve
//     (атомарно) → assign_modem(portName=login) → save_port_config лимитов →
//     leased → tariff_id → списание первых суток ПОСЛЕДНИМ шагом.
//     Статусная машина покупки: reserved → provisioning → provisioned →
//     charged; failed (отвязка ПОДТВЕРЖДЕНА свежим чтением, деньги не
//     тронуты), charge_failed (порт выдан, списание не прошло — recovery
//     досписывает по purchase_id), quarantine (исход сети неизвестен — порт
//     НЕ возвращается в free вслепую). Списание идемпотентно по purchase_id
//     (миграция 097), вторая покупка в день — независимая (DEEP-20/21).
//   Тест-день: тариф duration_hours=24, разовое списание retail_test_day_price,
//     1 раз на аккаунт (test_used + durable UNIQUE idx_retail_purchases_testday),
//     daily billing его НЕ трогает; возврат в пул через 24ч — retail-guard.
//   POST /api/admin/retail/client/rehabilitate { client_id } — Э5 (WP7):
//     возврат портов, замороженных антифродом (только админом, auditLog).
//
// Лимита портов на аккаунт НЕТ (решение 10.08) — контур защиты: WP7 анти-мультиаккаунт.
// Повторная покупка клиентом с tariff_id — только того же тарифа (один тариф на клиента, §Г.1).

const express = require('express');
const crypto = require('crypto');

module.exports = function createRetailRouter(deps) {
  const {
    logger, authMiddleware,
    clients, saveClients,
    tariffsDb, retailPoolDb, retailPurchasesDb,
    atomicDebit,
    getSetting,
    findServer, fetchApi, proxyConf, proxySmart, parseHtmlInputFields,
    fetchAllServersDataCached,   // Э2: legacy_preview (скан портов всех серверов)
    auditLog, logActivity, getClientIp,
    alerts,
    notifyClient,   // B2C Э3 (WP5): «Прокси выдан» клиенту после покупки
    getMoscowNow, kvGet, kvSet,   // WP7 (Э5): реабилитация портов (abuse_hold)
  } = deps;
  const r = express.Router();

  // WP7 (Э5): «дата до»/runway — та же механика, что у retail-guard.
  const portValidity = require('../services/port-validity').create(deps);

  function _clientOf(req) {
    return clients.find(c => c.login === req.user.login);
  }

  // Выдача порта клиенту на боксе: portName=login (механика assign_modem из proxies.js:91).
  async function _assignPortToClient(server, portId, login) {
    const asForm = await proxyConf.getConfForm(server, `/conf/edit_port/${portId}`);
    if (!asForm.ok) throw new Error(`ProxySmart не отдал форму порта (${asForm.reason})`);
    const formData = parseHtmlInputFields(asForm.html);
    if (!formData.proxy_password) {
      try {
        const portsData = await fetchApi(server, '/apix/list_ports_json');
        for (const [, plist] of Object.entries(portsData)) {
          for (const port of plist) {
            if (port.portID === portId && port.PASSWORD) { formData.proxy_password = port.PASSWORD; break; }
          }
          if (formData.proxy_password) break;
        }
      } catch (_) { /* best-effort */ }
    }
    formData.portName = login;
    const posted = await proxyConf.postConfForm(server, `/conf/edit_port/${portId}`, formData);
    if (!posted.ok) throw new Error(`ProxySmart не сохранил привязку (${posted.reason})`);
  }

  // Лимиты порта из тарифа (maxconn/bandlim) — паттерн save_port_config (proxies-ports.js:229+).
  async function _applyTariffLimits(server, portId, tariff) {
    if (!tariff.maxconn && !tariff.bandlim_kbit) return;
    const form = await proxyConf.getConfForm(server, `/conf/edit_port/${portId}`);
    if (!form.ok) return; // лимиты — best-effort, выдачу не валим
    const formData = parseHtmlInputFields(form.html);
    if (tariff.maxconn) formData.maxconn = String(tariff.maxconn);
    if (tariff.bandlim_kbit) formData.bandlim = String(tariff.bandlim_kbit);
    await proxyConf.postConfForm(server, `/conf/edit_port/${portId}`, formData).catch(() => {});
  }

  // 2026-09-18 · DEEP-22: компенсация провижининга. Порт переводится в free
  // ТОЛЬКО после подтверждённой отвязки: postConfForm(portName=randomport…) + apply +
  // СВЕЖЕЕ чтение реестра портов (portName стал техническим). Любой сбой или
  // неподтверждённое чтение → false: исход неизвестен, порт НЕ освобождаем
  // (иначе активный порт с живым доступом продавался бы повторно).
  async function _tryUnbindPort(server, portId) {
    try {
      const form = await proxyConf.getConfForm(server, `/conf/edit_port/${portId}`);
      if (!form.ok) return false;
      const formData = parseHtmlInputFields(form.html);
      // Пустое имя ProxySmart игнорирует (302 на ту же форму) — «отвязка» = техническое имя randomport…
      formData.portName = 'randomport' + String(Date.now()).slice(-8) + String(Math.floor(Math.random() * 90) + 10);
      const posted = await proxyConf.postConfForm(server, `/conf/edit_port/${portId}`, formData);
      if (!posted.ok) return false;
      try { await fetchApi(server, `/apix/apply_port?arg=${encodeURIComponent(portId)}`); } catch (_) { /* best-effort */ }
      const portsData = await fetchApi(server, '/apix/list_ports_json');
      for (const plist of Object.values(portsData || {})) {
        for (const p of plist || []) {
          if (p && p.portID === portId) { const nm = String(p.portName || '').trim(); return !nm || /^random/i.test(nm); }
        }
      }
      return false;   // порт не найден в свежем реестре — отвязка не доказана
    } catch (_) {
      return false;
    }
  }

  async function buyProxyHandler(req, res) {
    if (!getSetting('retail_enabled', false)) return res.status(404).json({ error: 'Not found' });
    const client = _clientOf(req);
    if (!client) return res.status(404).json({ error: 'Client not found' });
    if (client.blocked) return res.status(403).json({ error: 'Аккаунт заблокирован' });
    // До верификации email покупать нельзя (403) — TG-аккаунты без email тоже (54-ФЗ)
    if (!client.emailVerified) {
      return res.status(403).json({ error: 'Подтвердите email перед покупкой', code: 'EMAIL_NOT_VERIFIED' });
    }

    const tariff = tariffsDb.byId(req.body && req.body.tariff_id);
    if (!tariff || !tariff.active) return res.status(400).json({ error: 'Тариф не найден или неактивен' });
    // DEEP-45 (2026-09-24): скрытый тариф (public=0) — НЕ для самостоятельной
    // покупки: витрина его фильтрует, а прямой запрос по ID доходил до выдачи.
    if (!tariff.public) return res.status(400).json({ error: 'Тариф не найден или неактивен' });
    // DEEP-46 (2026-09-24): конвейер выдачи реализует ТОЛЬКО per_modem-подписку
    // и тест-день (duration_hours=24, разовая фикс-цена). Остальные комбинации
    // (per_gb, срочные аренды 48/72ч) раньше принимались и списывались как
    // price/daysInMonth без deadline и смены billingType — отклоняем явно.
    if (tariff.type && tariff.type !== 'per_modem') {
      return res.status(400).json({ error: 'Этот тип тарифа не поддерживается самостоятельной покупкой', code: 'UNSUPPORTED_TARIFF_TYPE' });
    }
    if (tariff.duration_hours != null && tariff.duration_hours !== 24) {
      return res.status(400).json({ error: 'Срочные аренды этого срока не поддерживаются самостоятельной покупкой', code: 'UNSUPPORTED_DURATION' });
    }

    const isTestDay = tariff.duration_hours === 24;
    if (isTestDay && client.testUsed) {
      return res.status(403).json({ error: 'Тест-день доступен один раз на аккаунт', code: 'TEST_USED' });
    }

    // Один тариф на клиента: повторная покупка — только того же тарифа (§Г.1)
    if (client.tariffId != null && client.tariffId !== tariff.id && !isTestDay) {
      return res.status(409).json({ error: 'У вас уже есть активный тариф — смена тарифа через поддержку', code: 'TARIFF_LOCKED' });
    }

    // Проверка баланса: подписка — price/30.4 × min_topup_days; тест — фикс-цена
    const firstDayCost = isTestDay
      ? getSetting('retail_test_day_price', 100)
      : Math.round((tariff.price / 30.4) * tariff.min_topup_days * 100) / 100;
    if ((client.balance || 0) < firstDayCost) {
      return res.status(402).json({ error: `Недостаточно средств: нужно ${firstDayCost} ₽`, code: 'INSUFFICIENT_BALANCE', required: firstDayCost });
    }

    // 2026-09-18 · DEEP-22: durable-покупка ДО любых сетевых вызовов.
    // Финансовый резерв: UNIQUE idx_retail_purchases_inflight закрывает гонку
    // двух запросов по одному балансу/тест-дню (проверки выше — не транзакция);
    // UNIQUE idx_retail_purchases_testday — durable право на тест-день.
    // DEEP-20/21: сумма списания вычисляется ОДИН раз здесь и дальше идёт
    // и в purchase.amount, и в ledger.cost, и в ответ API.
    const charge = isTestDay
      ? firstDayCost
      : Math.round((tariff.price / new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0).getDate()) * 100) / 100;
    const purchaseId = 'pur_' + crypto.randomBytes(8).toString('hex');
    try {
      retailPurchasesDb.createReserved({
        id: purchaseId, clientId: client.id, tariffId: tariff.id,
        amount: charge, testDay: isTestDay,
      });
    } catch (e) {
      if (e && /UNIQUE constraint/i.test(e.message || '')) {
        const inFlight = ['reserved', 'provisioning', 'provisioned', 'charge_failed', 'quarantine']
          .some(st => retailPurchasesDb.byStatus(st).some(p => p.client_id === client.id));
        if (inFlight) {
          return res.status(409).json({ error: 'Предыдущая покупка ещё выполняется — повторите через минуту', code: 'PURCHASE_IN_FLIGHT' });
        }
        return res.status(403).json({ error: 'Тест-день доступен один раз на аккаунт', code: 'TEST_USED' });
      }
      throw e;
    }

    // Атомарный резерв свободного порта на боксе тарифа (гонки: UPDATE … WHERE status='free')
    const poolServers = String(getSetting('retail_pool_servers', '')).split(',').map(s => s.trim()).filter(Boolean);
    // tariff.server — список боксов по приоритету («S1, S3»). Раньше строка
    // целиком считалась ОДНИМ именем сервера: пул «S1, S3» не находился, и
    // любая покупка по таким тарифам кончалась «прокси закончились»
    // (2026-10-15). Берём первый бокс списка со свободным портом пула.
    const tariffServers = String(tariff.server || '').split(/[\s,;]+/).map(x => x.trim()).filter(Boolean);
    const serverCandidates = tariffServers.length ? tariffServers : poolServers;
    let serverName = serverCandidates.find(s => retailPoolDb.nextFree(s));
    if (!serverName) {
      // Пул пуст везде — пробуем поднять порт на свободном модеме (по порядку серверов),
      // а не отвечать «закончились», пока админ не нажмёт «добавить порты».
      for (const cand of serverCandidates) {
        try { const g = await createFreePorts(cand, 1, 'system:buy_on_demand'); if (g.created.length) { serverName = cand; break; } }
        catch (e) { logger.warn(`[Retail] on-demand порт ${cand}: ${e.message}`); }
      }
    }
    serverName = serverName || serverCandidates[0];
    if (!serverName) {
      retailPurchasesDb.setStatus(purchaseId, 'failed', 'pool_not_configured');
      return res.status(503).json({ error: 'Пул розницы не настроен' });
    }

    let poolRow = null;
    for (let attempt = 0; attempt < 5 && !poolRow; attempt++) {
      const candidate = retailPoolDb.nextFree(serverName);
      if (!candidate) break;
      const reservedUntil = new Date(Date.now() + 5 * 60 * 1000).toISOString(); // TTL резерва 5 мин
      if (retailPoolDb.reserve(candidate.id, client.id, reservedUntil)) poolRow = candidate;
    }
    if (poolRow) retailPurchasesDb.setPortInfo(purchaseId, serverName, poolRow.port_id, poolRow.id);

    // Шаринг (15.08): свободные порты кончились → создаём НОВЫЙ порт на модеме
    // «якорного» клиента (настройка retail_share_anchor_login), если на нём
    // клиентских портов меньше retail_max_clients_per_modem. Чужие модемы
    // (порты не якоря) и свободные модемы здесь не трогаем: свободные —
    // через /api/admin/retail/pool/add, чужие — никогда.
    let sharedCreated = false;
    if (!poolRow) {
      const maxPerModem = Math.max(1, Number(getSetting('retail_max_clients_per_modem', 1)) || 1);
      const anchorLogin = String(getSetting('retail_share_anchor_login', '') || '').trim();
      if (maxPerModem > 1 && anchorLogin) {
        const server0 = findServer(serverName);
        if (server0) {
          try {
            const statusRaw = await fetchApi(server0, '/apix/show_status_json');
            const portsData = await fetchApi(server0, '/apix/list_ports_json');
            const status = Array.isArray(statusRaw) ? statusRaw : (statusRaw && statusRaw.modems) || [];
            const cands = [];
            for (const m of status) {
              const imei = m && m.modem_details && m.modem_details.IMEI;
              if (!imei) continue;
              const online = m.net_details && m.net_details.IS_ONLINE === 'yes';
              if (!online) continue;
              const ports = (portsData && portsData[imei]) || [];
              const named = ports.filter(p => p && (p.portName || '').trim());
              if (!named.length) continue;                          // свободный модем — не наш случай
              if (named.some(p => String(p.portName).trim() !== anchorLogin)) continue; // чужой/другой клиент
              if (named.length >= maxPerModem) continue;            // мест нет
              cands.push({ imei, used: named.length });
            }
            cands.sort((a, b) => a.used - b.used);
            for (const cand of cands) {
              try {
                // Та же механика add_port, что у pool/add, но portName = логину
                // покупателя сразу (порт активен с создания).
                const addForm = await proxyConf.getConfForm(server0, `/conf/add_port?imei=${cand.imei}`);
                if (!addForm.ok) throw new Error(`add_port form: ${addForm.reason}`);
                const formData = parseHtmlInputFields(addForm.html);
                if (!formData.portID) throw new Error('add_port form returned no portID');
                formData.portName = client.login;
                const posted = await proxyConf.postConfForm(server0, `/conf/add_port?imei=${cand.imei}`, formData);
                if (!posted.ok) throw new Error(`add_port post: ${posted.reason}`);
                try { await fetchApi(server0, `/apix/apply_port?arg=${encodeURIComponent(formData.portID)}`); } catch (e) {
                  logger.warn(`[Retail] shared apply_port ${formData.portID}: ${e.message}`);  // best-effort
                }
                retailPoolDb.insertLeased(serverName, formData.portID, client.id);
                poolRow = retailPoolDb.byPort(serverName, formData.portID);
                if (poolRow) retailPurchasesDb.setPortInfo(purchaseId, serverName, formData.portID, poolRow.id);
                sharedCreated = true;
                auditLog(client.login, 'retail_buy_shared_port', { server: serverName, imei: cand.imei, port: formData.portID, anchor: anchorLogin });
                logActivity('modem', 'info', 'retail_shared_port', serverName,
                  `Шаринг: порт ${formData.portID} создан на модеме якоря ${anchorLogin} (imei ${cand.imei}) для ${client.login}`, {});
                break;
              } catch (e) {
                logger.warn(`[Retail] shared add_port ${cand.imei}: ${e.message}`);
              }
            }
          } catch (e) {
            logger.warn(`[Retail] shared-модемы недоступны (${serverName}): ${e.message}`);
          }
        }
      }
    }

    if (!poolRow) {
      // Пул пуст — покупка недоступна + алерт админу (WP4)
      retailPurchasesDb.setStatus(purchaseId, 'failed', 'pool_empty');
      logger.warn(`[Retail] Пул исчерпан: ${serverName} (geo ${tariff.geo})`);
      try { alerts && alerts.trigger('retail_pool_empty', { server: serverName, geo: tariff.geo }); } catch (_) {}
      return res.status(409).json({ error: 'Свободные прокси этой локации закончились — попробуйте позже', code: 'POOL_EMPTY' });
    }

    // Провижининг ВНЕ транзакции; компенсация — только ПОДТВЕРЖДЁННАЯ отвязка
    // (DEEP-22): release без неё делал активный порт free с живым доступом.
    const server = findServer(serverName);
    if (!server) {
      retailPurchasesDb.setStatus(purchaseId, 'quarantine', 'server_unknown');
      try { alerts && alerts.trigger('retail_purchase_quarantine', { client: client.login, port: poolRow.port_id, server: serverName, reason: 'server_unknown', purchase_id: purchaseId }); } catch (_) {}
      return res.status(503).json({ error: 'Сервер выдачи недоступен' });
    }
    retailPurchasesDb.setStatus(purchaseId, 'provisioning');
    try {
      // Шаринговый порт создан сразу с portName=login — привязка не нужна,
      // только лимиты тарифа. Обычный free-порт — assign + лимиты.
      if (!sharedCreated) await _assignPortToClient(server, poolRow.port_id, client.login);
      await _applyTariffLimits(server, poolRow.port_id, tariff);
    } catch (e) {
      const unbound = await _tryUnbindPort(server, poolRow.port_id);
      if (unbound) {
        retailPoolDb.release(poolRow.id);
        retailPurchasesDb.setStatus(purchaseId, 'failed', e.message);
      } else {
        // Исход неизвестен: привязка могла пройти. Порт НЕ в free — durable
        // quarantine, reconcile по свежему владельцу делает retail-guard.
        retailPurchasesDb.setStatus(purchaseId, 'quarantine', e.message);
        try { alerts && alerts.trigger('retail_purchase_quarantine', { client: client.login, port: poolRow.port_id, server: serverName, reason: e.message, purchase_id: purchaseId }); } catch (_) {}
      }
      logger.error(`[Retail] Провижининг порта ${poolRow.port_id} failed: ${e.message} (компенсация: ${unbound ? 'порт отвязан и возвращён в free' : 'НЕ подтверждена — quarantine'})`);
      return res.status(502).json({ error: 'Не удалось выдать прокси — повторите через минуту', details: e.message });
    }
    retailPurchasesDb.setStatus(purchaseId, 'provisioned');

    // leased + привязка тарифа (тест — тоже leased; возврат по 24ч делает retail-guard)
    if (!sharedCreated) retailPoolDb.lease(poolRow.id);
    let testExpiresIso = null;
    if (isTestDay) {
      client.testUsed = true;
      // Э2: дедлайн возврата тест-порта (миграция 062) — снимает retail-guard.
      testExpiresIso = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
      retailPoolDb.setTestExpires(poolRow.id, testExpiresIso);
    } else {
      client.tariffId = tariff.id;
    }

    // Списание — ПОСЛЕДНИЙ шаг (atomicDebit; деньги только через atomic*, §Г.5).
    // DEEP-20/21: идемпотентность покупки — purchase_id (idx_ledger_purchase_unique),
    // НЕ общий ключ client+date+type; сумма события — единый `charge` (cost в
    // ledger). Дата — в зоне биллинга (МСК), как у суточного расчёта.
    // minBalance=0: физик без allowDebt не уходит в минус гоночным списанием.
    let chargeFailed = null;
    try {
      const debitRes = atomicDebit(client.id, charge, {
        date: getMoscowNow().toLocaleDateString('en-CA'),
        type: 'charge',
        note: isTestDay ? 'test_day' : 'first_day',
        cost: charge,
        purchase_id: purchaseId,
      }, { minBalance: 0 });
      if (debitRes && debitRes.duplicate) {
        // Повтор ТОЙ ЖЕ покупки (replay/recovery) — деньги уже списаны этим
        // purchase_id, второго списания нет. Это штатная идемпотентность.
        logger.info(`[Retail] Списание ${purchaseId} уже проведено (duplicate) — идемпотентный повтор`);
      }
    } catch (e) {
      chargeFailed = e;
    }
    if (chargeFailed) {
      // Порт выдан — НЕ откатываем вслепую. Операция durable: recovery
      // (retail-guard) доспишет по purchase_id; API НЕ сообщает charged
      // (DEEP-22: раньше клиент видел «charged» при фактическом отказе).
      retailPurchasesDb.setStatus(purchaseId, 'charge_failed', chargeFailed.message);
      logger.error(`[Retail] Списание первых суток failed для ${client.login} (${purchaseId}): ${chargeFailed.message}`);
      try { alerts && alerts.trigger('retail_first_day_charge_failed', { client: client.login, charge, purchase_id: purchaseId }); } catch (_) {}
    } else {
      retailPurchasesDb.setStatus(purchaseId, 'charged');
    }
    saveClients(clients);
    proxySmart.invalidateCache();

    auditLog(client.login, isTestDay ? 'retail_buy_test_day' : 'retail_buy_proxy',
      { tariff: tariff.id, port: poolRow.port_id, server: serverName, charge, ip: getClientIp(req) });
    logActivity('client', 'info', 'retail_buy', client.login,
      `Куплен прокси по тарифу «${tariff.name}» (${serverName}/${poolRow.port_id})`, { charge });
    // B2C Э3 (WP5): админ-алерты розницы — покупка, массовая покупка, пул на исходе.
    try { alerts && alerts.trigger('retail_purchase', { login: client.login, tariff: tariff.name, price: charge }); } catch (_) {}
    try {
      // Массовая покупка: триггер при ПЕРЕСЕЧЕНИИ порога leased-портов
      // (count === threshold), дальше держит дедуп по clientId в alerts.js.
      // threshold = 0 — антифрод-алерт отключён.
      const threshold = Math.max(0, Number(getSetting('retail_bulk_buy_threshold', 3)) || 0);
      const leasedNow = retailPoolDb.byClient(client.id).filter(r => r.status === 'leased').length;
      if (threshold > 0 && leasedNow === threshold) {
        alerts && alerts.trigger('retail_bulk_buy', { client_id: client.id, login: client.login, count: leasedNow, threshold });
      }
    } catch (_) {}
    try {
      // Пул на исходе — агрегированно по всем боксам розницы (как в
      // retail-guard._checkPoolLow): один алерт в сутки, а не по серверу.
      const minFree = Number(getSetting('retail_pool_min_free', 3));
      const poolServers = String(getSetting('retail_pool_servers', '')).split(',').map(s => s.trim()).filter(Boolean);
      const freeRows = retailPoolDb.byStatus('free');
      const totalFree = poolServers.length
        ? freeRows.filter(r => poolServers.includes(r.server)).length
        : freeRows.length;
      if (totalFree < minFree) {
        const perServer = poolServers.map(srv => `${srv}: ${freeRows.filter(r => r.server === srv).length}`).join(', ');
        alerts && alerts.trigger('retail_pool_low', { free: totalFree, min: minFree, breakdown: perServer });
      }
    } catch (_) {}
    // Клиенту — «Прокси выдан» (TG, если привязан; всегда — след в system_log).
    if (notifyClient) {
      const when = testExpiresIso
        ? `\nТест-день действует до ${new Date(testExpiresIso).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' })} МСК.`
        : '';
      Promise.resolve(notifyClient(client,
        `Прокси выдан по тарифу «${tariff.name}» — реквизиты в личном кабинете на вкладке «Панель управления».${when}`,
        { action: 'retail_buy', details: { client_id: client.id, tariff: tariff.id, port_id: poolRow.port_id, server: serverName } }
      )).catch(e => logger.warn(`[Retail] notify ${client.login}: ${e.message}`));
    }

    // Реквизиты клиент видит сразу (живьём из ProxySmart на dashboard_data)
    res.json({
      ok: true, port_id: poolRow.port_id, server: serverName, tariff: tariff.name,
      charged: chargeFailed ? 0 : charge,
      charge_pending: !!chargeFailed,   // DEEP-22: честный статус списания
      purchase_id: purchaseId,
    });
  }
  r.post('/api/client/buy_proxy', authMiddleware, buyProxyHandler);

  // 2026-10-15: покупка пакетом — гео + количество. Ступень цены выбирается
  // САМА по общему числу прокси клиента после покупки (тарифы гео с
  // min_proxies ≤ итог; берётся самая крупная ступень). Цена ступени действует
  // на все прокси клиента: биллинг берёт одну цену на клиента (tariff_id).
  // Каждая прокси выдаётся тем же buyProxyHandler — все проверки, резерв,
  // списание первых суток и откаты едины; при сбое на k-й прокси выданные
  // остаются, ответ сообщает, сколько выдано.
  const MAX_BATCH = 50;
  r.post('/api/client/buy_proxies', authMiddleware, async (req, res) => {
    if (!getSetting('retail_enabled', false)) return res.status(404).json({ error: 'Not found' });
    const client = _clientOf(req);
    if (!client) return res.status(404).json({ error: 'Client not found' });
    if (client.blocked) return res.status(403).json({ error: 'Аккаунт заблокирован' });
    if (!client.emailVerified) return res.status(403).json({ error: 'Подтвердите email перед покупкой', code: 'EMAIL_NOT_VERIFIED' });
    const geo = String((req.body && req.body.geo) || '').trim().toUpperCase();
    const quantity = parseInt(req.body && req.body.quantity, 10);
    if (!geo) return res.status(400).json({ error: 'Выберите страну' });
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_BATCH) {
      return res.status(400).json({ error: `Количество — от 1 до ${MAX_BATCH} за один заказ` });
    }
    const tiers = tariffsDb.publicActive()
      .filter(t => (t.type || 'per_modem') === 'per_modem' && t.duration_hours == null && String(t.geo || '').toUpperCase() === geo)
      .sort((a, b) => (a.min_proxies || 1) - (b.min_proxies || 1));
    if (!tiers.length) return res.status(400).json({ error: 'Для этой страны нет тарифов' });
    // Один прайс на клиента: прокси другого гео по ступеням — через поддержку.
    const current = client.tariffId != null ? tariffsDb.byId(client.tariffId) : null;
    if (current && String(current.geo || '').toUpperCase() !== geo && current.duration_hours == null) {
      return res.status(409).json({ error: 'У вас прокси другой страны — для второй страны напишите в поддержку', code: 'GEO_LOCKED' });
    }
    const owned = retailPoolDb.byClient(client.id).filter(p => p.status === 'leased').length;
    const total = owned + quantity;
    const tier = tiers.filter(t => (t.min_proxies || 1) <= total).pop() || tiers[0];
    // Хватит ли свободных портов — до первого списания, без частичной выдачи.
    const tierServers = String(tier.server || '').split(/[\s,;]+/).map(x => x.trim()).filter(Boolean);
    const poolServers = String(getSetting('retail_pool_servers', '')).split(',').map(x => x.trim()).filter(Boolean);
    const servers = tierServers.length ? tierServers : poolServers;
    const countFree = () => retailPoolDb.byStatus('free').filter(p => !servers.length || servers.includes(p.server)).length;
    let free = countFree();
    // Не хватает свободных портов — поднимаем недостающие на пустых модемах серверов тарифа.
    for (const srv of servers) {
      if (free >= quantity) break;
      try { await createFreePorts(srv, Math.min(MAX_BATCH, quantity - free), 'system:buy_on_demand'); }
      catch (e) { logger.warn(`[Retail] on-demand порты ${srv}: ${e.message}`); }
      free = countFree();
    }
    if (free < quantity) {
      return res.status(409).json({ error: free ? `Сейчас свободно ${free} прокси этой страны — уменьшите количество` : 'Свободные прокси этой страны закончились — попробуйте позже', code: 'POOL_SHORT', available: free });
    }
    const days = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0).getDate();
    const perProxy = Math.round((tier.price / days) * 100) / 100;
    const needed = Math.round(perProxy * quantity * 100) / 100;
    if ((client.balance || 0) < needed) {
      return res.status(402).json({ error: `Недостаточно средств: нужно ${needed} ₽ (первые сутки за ${quantity} прокси)`, code: 'INSUFFICIENT_BALANCE', required: needed });
    }
    const prevTariffId = client.tariffId;
    if (client.tariffId !== tier.id) { client.tariffId = tier.id; saveClients(clients); }

    const results = [];
    let error = null;
    for (let i = 0; i < quantity; i++) {
      const out = { statusCode: 200, body: null };
      const fakeRes = { status(c) { out.statusCode = c; return this; }, json(b) { out.body = b; return this; } };
      const fakeReq = Object.create(req);
      fakeReq.body = { tariff_id: tier.id };
      try { await buyProxyHandler(fakeReq, fakeRes); }
      catch (e) { out.statusCode = 500; out.body = { error: e.message }; }
      if (out.statusCode !== 200 || !out.body || !out.body.ok) { error = { status: out.statusCode, ...(out.body || {}) }; break; }
      results.push({ port_id: out.body.port_id, server: out.body.server, charged: out.body.charged, charge_pending: out.body.charge_pending });
    }
    // Ничего не выдано — возвращаем прежний тариф (ступень не должна меняться без покупки).
    if (!results.length && client.tariffId !== prevTariffId) { client.tariffId = prevTariffId; saveClients(clients); }
    auditLog(client.login, 'retail_buy_batch', { geo, requested: quantity, bought: results.length, tier: tier.id, ip: getClientIp(req) });
    const body = {
      ok: results.length > 0, bought: results.length, requested: quantity,
      tier: { id: tier.id, name: tier.name, price: tier.price, min_proxies: tier.min_proxies || 1 },
      total_proxies: owned + results.length, results,
    };
    if (error) body.error = results.length ? `Выдано ${results.length} из ${quantity}: ${error.error || 'ошибка'}` : (error.error || 'Покупка не выполнена');
    if (error && error.code) body.code = error.code;
    res.status(results.length ? 200 : (error && error.status) || 500).json(body);
  });


  // Состояние пула (для админки «Розница»; витрина клиента — /api/client/tariffs в tariffs.js)
  r.get('/api/admin/retail/pool', authMiddleware, deps.adminMiddleware, (req, res) => {
    res.json({
      counts: retailPoolDb.countByStatus(),
      rows: retailPoolDb.all(),   // Э2: полный список (server, port_id, status, client_id, hold_until, test_expires_at, reserved_until)
      servers: String(getSetting('retail_pool_servers', '')).split(',').filter(Boolean),
    });
  });

  // ── Э2: пополнение пула. Для каждого порта: свободный IMEI на боксе
  // (онлайн-модем без клиентских портов) → add_port с ПУСТЫМ portName
  // (де-факто выключен, B6) → apply_port → строка retail_pool free.
  // Операция длинная (до 2–3 мин на 10 портов) — идём последовательно.
  // Свободные порты пула на пустых модемах сервера. 2026-10-15: логика вынесена
  // из админского pool/add — её же зовут автоподпитка (retail-pool-topup) и
  // покупка при пустом пуле. Кандидат: онлайн-модем БЕЗ портов с клиентом,
  // реально работающий (есть внешний IP, SIM OK, потери пинга не 100%, не в
  // ротации) и без free-строки пула. Сначала с меньшим числом портов.
  async function createFreePorts(serverName, count, actor) {
    const server = findServer(serverName);
    if (!server) return { created: [], errors: [{ reason: 'Server not found' }], candidates: 0 };
    const created = [], errors = [];
    const statusRaw = await fetchApi(server, '/apix/show_status_json');
    const portsData = await fetchApi(server, '/apix/list_ports_json');
    const status = Array.isArray(statusRaw) ? statusRaw : (statusRaw && statusRaw.modems) || [];
    // portID → IMEI: не стакаем free-порты пула на один модем.
    const poolFreeImeis = new Set();
    for (const row of retailPoolDb.byStatus('free')) {
      if (row.server !== serverName) continue;
      for (const [imei, plist] of Object.entries(portsData || {})) {
        if ((plist || []).some(p => p && p.portID === row.port_id)) { poolFreeImeis.add(imei); break; }
      }
    }
    const candidates = [];
    for (const m of status) {
      const md = (m && m.modem_details) || {}, nd = (m && m.net_details) || {};
      const imei = md.IMEI;
      if (!imei || poolFreeImeis.has(imei)) continue;
      if (nd.IS_ONLINE !== 'yes') continue;
      if (!String(nd.EXT_IP || '').trim()) continue;                        // нет внешнего IP — выдавать нечего
      if (nd.SimStatus && !/ok/i.test(String(nd.SimStatus))) continue;      // SIM не в порядке
      if (/100\s*%\s*loss/i.test(String(nd.ping_stats || ''))) continue;     // канал не отвечает
      if (m.IS_ROTATED === 'true' || m.IS_ROTATED === true || nd.IS_ROTATED === 'true') continue;
      const ports = (portsData && portsData[imei]) || [];
      if (ports.some(p => p && (p.portName || '').trim() && !/^random/i.test(String(p.portName).trim()))) continue;   // занят клиентом (randomport* — технический, не клиент)
      candidates.push({ imei, nick: md.NICK, ports: ports.length });
    }
    candidates.sort((a, b) => a.ports - b.ports);
    for (let i = 0; i < count; i++) {
      const cand = candidates[i];
      if (!cand) { errors.push({ reason: `Свободных модемов на ${serverName} больше нет (нужно ${count}, доступно ${candidates.length})` }); break; }
      try {
        // Создание порта — та же механика store_port (proxies-ports.js):
        // форма add_port → portName='' → POST → apply_port.
        const addForm = await proxyConf.getConfForm(server, `/conf/add_port?imei=${cand.imei}`);
        if (!addForm.ok) throw new Error(`add_port form: ${addForm.reason}`);
        const formData = parseHtmlInputFields(addForm.html);
        if (!formData.portID) throw new Error('add_port form returned no portID');
        // 2026-10-15: ProxySmart не создаёт порт с ПУСТЫМ именем — отвечает 302 обратно
        // на форму, а postConfForm считает это успехом (на проде в пуле появились
        // 6 «призрачных» портов, покупка падала с HTTP_404 на выдаче). Свободный
        // порт называется randomport<цифры> — это штатное имя ProxySmart для
        // неназначенных портов, все проверки проекта уже считают его не клиентским.
        formData.portName = 'randomport' + String(Date.now()).slice(-8) + String(Math.floor(Math.random() * 90) + 10);
        const posted = await proxyConf.postConfForm(server, `/conf/add_port?imei=${cand.imei}`, formData);
        if (!posted.ok) throw new Error(`add_port post: ${posted.reason}`);
        // Порт должен реально появиться на боксе, иначе в пул не записываем.
        const after = await fetchApi(server, '/apix/list_ports_json');
        const exists = Object.values(after || {}).some(pl => (pl || []).some(p => p && p.portID === formData.portID));
        if (!exists) throw new Error('ProxySmart не создал порт (форма вернулась без сохранения)');
        try { await fetchApi(server, `/apix/apply_port?arg=${encodeURIComponent(formData.portID)}`); } catch (e) {
          logger.warn(`[RetailPool] apply_port ${formData.portID}: ${e.message}`);   // best-effort
        }
        retailPoolDb.insertFree(serverName, formData.portID);
        created.push(formData.portID);
        auditLog(actor || 'system', 'retail_pool_add', { server: serverName, imei: cand.imei, nick: cand.nick, portId: formData.portID });
      } catch (e) {
        errors.push({ imei: cand.imei, reason: e.message });
      }
    }
    if (created.length) proxySmart.invalidateCache();
    return { created, errors, candidates: candidates.length };
  }

  // Подпитка: держим на каждом сервере розницы не меньше `target` свободных портов.
  // Возвращает { servers: { S1: {free, added, errors} } }. Вызывает фоновая задача.
  async function topUpPool(target, perRun = 5) {
    const poolServers = String(getSetting('retail_pool_servers', '')).split(',').map(s => s.trim()).filter(Boolean);
    const out = {};
    for (const serverName of poolServers) {
      const free = retailPoolDb.byStatus('free').filter(p => p.server === serverName).length;
      if (free >= target) { out[serverName] = { free, added: 0 }; continue; }
      try {
        const res = await createFreePorts(serverName, Math.min(perRun, target - free), 'system:pool_topup');
        out[serverName] = { free, added: res.created.length, candidates: res.candidates, errors: res.errors.length };
        if (res.created.length) logActivity('modem', 'info', 'retail_pool_topup', serverName, `Подпитка пула: +${res.created.length} портов (было свободно ${free}, цель ${target})`, {});
      } catch (e) {
        out[serverName] = { free, added: 0, error: e.message };
        logger.warn(`[RetailPool] подпитка ${serverName}: ${e.message}`);
      }
    }
    return { servers: out };
  }
  r.topUpPool = topUpPool;

  r.post('/api/admin/retail/pool/add', authMiddleware, deps.adminMiddleware, async (req, res) => {
    if (!getSetting('retail_enabled', false)) return res.status(404).json({ error: 'Not found' });
    const { server: serverName } = req.body || {};
    const count = Math.floor(Number(req.body && req.body.count));
    if (!serverName) return res.status(400).json({ error: 'server required' });
    if (!Number.isInteger(count) || count < 1 || count > 50) return res.status(400).json({ error: 'count: целое 1..50' });
    if (!findServer(serverName)) return res.status(400).json({ error: 'Server not found' });
    try {
      const { created, errors } = await createFreePorts(serverName, count, req.user.login);
      logActivity('modem', 'info', 'retail_pool_add', serverName,
        `Пул розницы: создано ${created.length} портов (запрошено ${count})`, { created, errors: errors.length });
      res.json({ ok: true, created, errors });
    } catch (e) {
      logger.error('[RetailPool] add failed: ' + e.message);
      res.status(502).json({ error: 'Pool add failed', details: e.message, created: [], errors: [] });
    }
  });

  // ── Э5 (WP7): «Реабилитировать порт» — возврат портов, замороженных
  // антифродом (domain-guard: «дата до» = сегодня + пул blocked с ∞ hold +
  // kv-маркер abuse_hold). Только админом; разблокировка аккаунта (blocked=0)
  // — отдельное действие в routes/clients.js (/unblock), здесь её нет:
  // реабилитация порта заблокированному аккаунту бессмысленна.
  r.post('/api/admin/retail/client/rehabilitate', authMiddleware, deps.adminMiddleware, async (req, res) => {
    if (!getSetting('retail_enabled', false)) return res.status(404).json({ error: 'Not found' });
    const client = clients.find(c => c.id === (req.body && req.body.client_id));
    if (!client) return res.status(404).json({ error: 'Client not found' });

    let ports = [];
    try {
      const marker = kvGet(`abuse_hold:${client.id}`);
      ports = marker && marker.value ? JSON.parse(marker.value) : [];
    } catch (_) { ports = []; }
    if (!Array.isArray(ports) || !ports.length) {
      return res.json({ ok: true, restored: 0, note: 'Нет портов, замороженных антифродом' });
    }

    // «Дата до» — как при восстановлении после долга (retail-guard шаг 4):
    // today + floor(balance / avgDailyCharge7d), avg=0 → 30 дн, минимум 1.
    const balance = client.balance || 0;
    const avg = portValidity.avgDailyCharge7d(client.id);
    const days = avg > 0 ? Math.max(1, Math.floor(balance / avg)) : 30;
    const until = getMoscowNow();
    until.setDate(until.getDate() + days);
    const untilStr = until.toLocaleDateString('en-CA');

    const restored = [], errors = [];
    for (const p of ports) {
      const server = findServer(p.server);
      if (!server) { errors.push({ port_id: p.port_id, reason: `сервер ${p.server} не найден` }); continue; }
      try {
        await portValidity.setPortValidBefore(server, p.port_id, untilStr);
        const row = retailPoolDb.byPort(p.server, p.port_id);
        if (row && row.status === 'blocked') retailPoolDb.unblock(row.id);
        restored.push(p.port_id);
      } catch (e) {
        logger.error(`[Retail] rehabilitate ${p.server}/${p.port_id}: ${e.message}`);
        errors.push({ port_id: p.port_id, reason: e.message });
      }
    }
    // Маркер снимаем только если всё восстановлено — иначе retail-guard
    // не должен начать авто-восстановление оставшихся портов.
    if (!errors.length) kvSet(`abuse_hold:${client.id}`, '');

    auditLog(req.user.login, 'retail_rehabilitate', {
      clientId: client.id, login: client.login, ports: restored,
      validBefore: untilStr, errors: errors.length, ip: getClientIp(req),
    });
    logActivity('client', 'warning', 'retail_rehabilitate', client.login,
      `Реабилитация портов антифрода: восстановлено ${restored.length} («дата до» = ${untilStr})`,
      { client_id: client.id, ports: restored, errors });
    res.json({ ok: errors.length === 0, restored, validBefore: untilStr, errors });
  });

  // ── Э2: legacy-preview. Порты, выданные физикам вне пула (portName = login
  // клиента individual), ещё без строки в retail_pool — кандидаты на импорт.
  r.get('/api/admin/retail/pool/legacy_preview', authMiddleware, deps.adminMiddleware, async (req, res) => {
    if (!getSetting('retail_enabled', false)) return res.status(404).json({ error: 'Not found' });
    try {
      const results = await fetchAllServersDataCached();
      const items = [];
      for (const data of results || []) {
        for (const list of Object.values(data.ports || {})) {
          for (const p of list || []) {
            if (!p || !p.portName) continue;
            const client = clients.find(c => c.clientType === 'individual' && c.portName === p.portName);
            if (!client) continue;
            if (retailPoolDb.byPort(data.serverName, p.portID)) continue;   // уже в пуле
            items.push({ server: data.serverName, port_id: p.portID, login: client.login, client_id: client.id });
          }
        }
      }
      res.json({ items });
    } catch (e) {
      logger.error('[RetailPool] legacy_preview failed: ' + e.message);
      res.status(502).json({ error: 'legacy_preview failed', details: e.message });
    }
  });

  // ── Э2: legacy-import — подтверждённый список из preview → leased.
  // Идемпотентно: INSERT OR IGNORE, дубли отчитываются в skipped.
  r.post('/api/admin/retail/pool/legacy_import', authMiddleware, deps.adminMiddleware, (req, res) => {
    if (!getSetting('retail_enabled', false)) return res.status(404).json({ error: 'Not found' });
    const items = Array.isArray(req.body && req.body.items) ? req.body.items.slice(0, 500) : [];
    let imported = 0;
    const skipped = [];
    for (const it of items) {
      if (!it || !it.server || !it.port_id || !it.client_id) { skipped.push({ item: it, reason: 'bad_shape' }); continue; }
      const r = retailPoolDb.insertLeased(it.server, it.port_id, it.client_id);
      if (r.changes > 0) imported++;
      else skipped.push({ item: it, reason: 'duplicate' });
    }
    auditLog(req.user.login, 'retail_pool_legacy_import', { imported, skipped: skipped.length, ip: getClientIp(req) });
    logActivity('modem', 'info', 'retail_pool_legacy_import', null,
      `Импорт legacy-портов в пул: ${imported} строк`, { imported, skipped: skipped.length });
    res.json({ ok: true, imported, skipped });
  });

  return r;
};
