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
//   POST /api/admin/retail/client/rehabilitate { client_id } — Э5 (WP7):
//     возврат портов, замороженных антифродом (только админом, auditLog).
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
    let testExpiresIso = null;
    if (isTestDay) {
      client.testUsed = true;
      // Э2: дедлайн возврата тест-порта (миграция 062) — снимает retail-guard.
      testExpiresIso = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
      retailPoolDb.setTestExpires(poolRow.id, testExpiresIso);
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
    // B2C Э3 (WP5): админ-алерты розницы — покупка, массовая покупка, пул на исходе.
    try { alerts && alerts.trigger('retail_purchase', { login: client.login, tariff: tariff.name, price: charge }); } catch (_) {}
    try {
      // Массовая покупка: триггер при ПЕРЕСЕЧЕНИИ порога leased-портов
      // (count === threshold), дальше держит дедуп по clientId в alerts.js.
      const threshold = Number(getSetting('retail_bulk_buy_threshold', 3)) || 3;
      const leasedNow = retailPoolDb.byClient(client.id).filter(r => r.status === 'leased').length;
      if (leasedNow === threshold) {
        alerts && alerts.trigger('retail_bulk_buy', { client_id: client.id, login: client.login, count: leasedNow, threshold });
      }
    } catch (_) {}
    try {
      const minFree = Number(getSetting('retail_pool_min_free', 3));
      const freeNow = retailPoolDb.byStatus('free').filter(r => r.server === serverName).length;
      if (freeNow < minFree) alerts && alerts.trigger('retail_pool_low', { server: serverName, free: freeNow, min: minFree });
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
    res.json({ ok: true, port_id: poolRow.port_id, server: serverName, tariff: tariff.name, charged: charge });
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
  r.post('/api/admin/retail/pool/add', authMiddleware, deps.adminMiddleware, async (req, res) => {
    if (!getSetting('retail_enabled', false)) return res.status(404).json({ error: 'Not found' });
    const { server: serverName } = req.body || {};
    const count = Math.floor(Number(req.body && req.body.count));
    if (!serverName) return res.status(400).json({ error: 'server required' });
    if (!Number.isInteger(count) || count < 1 || count > 50) return res.status(400).json({ error: 'count: целое 1..50' });
    const server = findServer(serverName);
    if (!server) return res.status(400).json({ error: 'Server not found' });

    const created = [], errors = [];
    try {
      // Живой снимок бокса: все модемы + все порты (spare-эвристика failover.js).
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
      // Свободный IMEI: онлайн-модем, ни одного порта с непустым portName,
      // без free-строки пула. Сначала совсем пустые (меньше портов — раньше).
      const candidates = [];
      for (const m of status) {
        const imei = m && m.modem_details && m.modem_details.IMEI;
        if (!imei || poolFreeImeis.has(imei)) continue;
        const online = m.net_details && m.net_details.IS_ONLINE === 'yes';
        if (!online) continue;
        const ports = (portsData && portsData[imei]) || [];
        if (ports.some(p => p && (p.portName || '').trim())) continue;   // занят клиентом
        candidates.push({ imei, ports: ports.length });
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
          formData.portName = '';   // пустой portName = порт выключен, ждёт выдачи (B6)
          const posted = await proxyConf.postConfForm(server, `/conf/add_port?imei=${cand.imei}`, formData);
          if (!posted.ok) throw new Error(`add_port post: ${posted.reason}`);
          try { await fetchApi(server, `/apix/apply_port?arg=${encodeURIComponent(formData.portID)}`); } catch (e) {
            logger.warn(`[RetailPool] apply_port ${formData.portID}: ${e.message}`);   // best-effort
          }
          retailPoolDb.insertFree(serverName, formData.portID);
          created.push(formData.portID);
          auditLog(req.user.login, 'retail_pool_add', { server: serverName, imei: cand.imei, portId: formData.portID, ip: getClientIp(req) });
        } catch (e) {
          errors.push({ imei: cand.imei, reason: e.message });
        }
      }
      proxySmart.invalidateCache();
      logActivity('modem', 'info', 'retail_pool_add', serverName,
        `Пул розницы: создано ${created.length} портов (запрошено ${count})`, { created, errors: errors.length });
      res.json({ ok: true, created, errors });
    } catch (e) {
      logger.error('[RetailPool] add failed: ' + e.message);
      res.status(502).json({ error: 'Pool add failed', details: e.message, created, errors });
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
