'use strict';
//
// src/routes/retail.js — B2C покупка прокси (WP2, ТЗ 10.08).
//
//   POST /api/client/buy_proxy { tariff_id } — автовыдача из пула:
//     проверки → reserve (атомарно) → assign_modem(portName=login) →
//     save_port_config лимитов → leased → tariff_id → списание первых суток
//     ПОСЛЕДНИМ шагом (при фейле бокса деньги не тронуты, порт → free).
//   Тест-день: тариф duration_hours=24, разовое списание retail_test_day_price,
//     1 раз на аккаунт (test_used), daily billing его НЕ трогает; возврат в пул
//     через 24ч — retail-guard (этап 2).
//
// Лимита портов на аккаунт НЕТ (решение 10.08) — контур защиты: WP7 анти-мультиаккаунт.
// Повторная покупка клиентом с tariff_id — только того же тарифа (один тариф на клиента, §Г.1).

const express = require('express');

module.exports = function createRetailRouter(deps) {
  const {
    logger, authMiddleware,
    clients, saveClients,
    tariffsDb, retailPoolDb,
    atomicDebit,
    getSetting,
    findServer, fetchApi, proxyConf, proxySmart, parseHtmlInputFields,
    auditLog, logActivity, getClientIp,
    alerts,
  } = deps;
  const r = express.Router();

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

  r.post('/api/client/buy_proxy', authMiddleware, async (req, res) => {
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

    // Атомарный резерв свободного порта на боксе тарифа (гонки: UPDATE … WHERE status='free')
    const poolServers = String(getSetting('retail_pool_servers', '')).split(',').map(s => s.trim()).filter(Boolean);
    const serverName = tariff.server || poolServers[0];
    if (!serverName) return res.status(503).json({ error: 'Пул розницы не настроен' });

    let poolRow = null;
    for (let attempt = 0; attempt < 5 && !poolRow; attempt++) {
      const candidate = retailPoolDb.nextFree(serverName);
      if (!candidate) break;
      const reservedUntil = new Date(Date.now() + 5 * 60 * 1000).toISOString(); // TTL резерва 5 мин
      if (retailPoolDb.reserve(candidate.id, client.id, reservedUntil)) poolRow = candidate;
    }
    if (!poolRow) {
      // Пул пуст — покупка недоступна + алерт админу (WP4)
      logger.warn(`[Retail] Пул исчерпан: ${serverName} (geo ${tariff.geo})`);
      try { alerts && alerts.trigger('retail_pool_empty', { server: serverName, geo: tariff.geo }); } catch (_) {}
      return res.status(409).json({ error: 'Свободные прокси этой локации закончились — попробуйте позже', code: 'POOL_EMPTY' });
    }

    // Провижининг ВНЕ транзакции; при фейле — порт обратно в free, деньги не тронуты
    const server = findServer(serverName);
    if (!server) {
      retailPoolDb.release(poolRow.id);
      return res.status(503).json({ error: 'Сервер выдачи недоступен' });
    }
    try {
      await _assignPortToClient(server, poolRow.port_id, client.login);
      await _applyTariffLimits(server, poolRow.port_id, tariff);
    } catch (e) {
      retailPoolDb.release(poolRow.id);
      logger.error(`[Retail] Провижининг порта ${poolRow.port_id} failed: ${e.message}`);
      return res.status(502).json({ error: 'Не удалось выдать прокси — повторите через минуту', details: e.message });
    }

    // leased + привязка тарифа (тест — тоже leased; возврат по 24ч делает retail-guard)
    retailPoolDb.lease(poolRow.id);
    if (isTestDay) {
      client.testUsed = true;
    } else {
      client.tariffId = tariff.id;
    }

    // Списание — ПОСЛЕДНИЙ шаг (atomicDebit; деньги только через atomic*, §Г.5)
    const charge = isTestDay
      ? firstDayCost
      : Math.round((tariff.price / new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0).getDate()) * 100) / 100;
    try {
      atomicDebit(client.id, charge, {
        date: new Date().toISOString().slice(0, 10),
        type: 'charge',
        note: isTestDay ? 'test_day' : 'first_day',
      });
    } catch (e) {
      logger.error(`[Retail] Списание первых суток failed для ${client.login}: ${e.message}`);
      // Порт уже выдан — не откатываем (биллинг доберёт ретраем); фиксируем инцидент
      try { alerts && alerts.trigger('retail_first_day_charge_failed', { client: client.login, charge }); } catch (_) {}
    }
    saveClients(clients);
    proxySmart.invalidateCache();

    auditLog(client.login, isTestDay ? 'retail_buy_test_day' : 'retail_buy_proxy',
      { tariff: tariff.id, port: poolRow.port_id, server: serverName, charge, ip: getClientIp(req) });
    logActivity('client', 'info', 'retail_buy', client.login,
      `Куплен прокси по тарифу «${tariff.name}» (${serverName}/${poolRow.port_id})`, { charge });
    try { alerts && alerts.trigger('retail_new_purchase', { client: client.login, tariff: tariff.name, charge }); } catch (_) {}

    // Реквизиты клиент видит сразу (живьём из ProxySmart на dashboard_data)
    res.json({ ok: true, port_id: poolRow.port_id, server: serverName, tariff: tariff.name, charged: charge });
  });

  // Состояние пула (для админки «Розница»; витрина клиента — /api/client/tariffs в tariffs.js)
  r.get('/api/admin/retail/pool', authMiddleware, deps.adminMiddleware, (req, res) => {
    res.json({ counts: retailPoolDb.countByStatus(), servers: String(getSetting('retail_pool_servers', '')).split(',').filter(Boolean) });
  });

  return r;
};
