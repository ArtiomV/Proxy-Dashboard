'use strict';
//
// src/routes/client-onboarding.js — личный кабинет розницы (2026-10-15).
//
//   GET  /api/client/onboarding          — нужно ли спросить «физлицо или юрлицо»,
//                                          что уже выбрано, статус договора
//   POST /api/client/onboarding          — {entity_type:'individual'} | {entity_type:'legal', requisites:{…}}
//   GET  /api/client/proxy_orders        — заказы клиента, которые выдаёт менеджер (прокси РФ)
//   POST /api/client/proxy_orders        — {proxy_type, geo, quantity, comment}
//   GET  /api/client/shop_catalog        — справочник магазина: Европа (тарифы-ступени по гео)
//                                          и Россия (типы и гео из настроек)
//
// Юрлицо. Анкета сохраняется, ИНН/КПП/название/адрес — в карточку клиента
// (их читают счета и акты), руководитель получает задачу (Telegram +
// колокольчик + задача в CRM): выслать договор по ЭДО и связаться. Тип
// клиента «юрлицо» НЕ включается автоматически: в биллинге он снимает
// блокировку за долг и списания в дни без трафика — включает руководитель
// после подписания договора.
//
// Прокси РФ выдаёт менеджер: заказ без списания, задача менеджеру.

const express = require('express');
const contractDoc = require('../documents/contract');
const { z } = require('zod');

const digits = (n) => z.string().trim().regex(new RegExp(`^\\d{${n}}$`), `должно быть ${n} цифр`);
const RequisitesSchema = z.object({
  legal_name: z.string().trim().min(2, 'укажите название').max(300),
  inn: z.string().trim().regex(/^(\d{10}|\d{12})$/, 'ИНН — 10 цифр (организация) или 12 (ИП)'),
  kpp: z.string().trim().regex(/^(\d{9})?$/, 'КПП — 9 цифр').optional().default(''),
  ogrn: z.string().trim().regex(/^(\d{13}|\d{15})?$/, 'ОГРН — 13 цифр, ОГРНИП — 15').optional().default(''),
  legal_address: z.string().trim().min(5, 'укажите юридический адрес').max(500),
  postal_address: z.string().trim().max(500).optional().default(''),
  signer_name: z.string().trim().min(3, 'укажите ФИО подписанта').max(200),
  signer_position: z.string().trim().max(100).optional().default('Генеральный директор'),
  signer_basis: z.string().trim().max(100).optional().default('Устава'),
  bank_name: z.string().trim().min(2, 'укажите банк').max(200),
  bik: digits(9),
  account: digits(20),
  corr_account: z.string().trim().regex(/^(\d{20})?$/, 'должно быть 20 цифр').optional().default(''),
  contact_name: z.string().trim().min(2, 'укажите контактное лицо').max(200),
  contact_phone: z.string().trim().max(50).optional().default(''),
  contact_email: z.string().trim().max(200).optional().default(''),
  edo_operator: z.string().trim().max(100).optional().default(''),
  edo_id: z.string().trim().max(100).optional().default(''),
}).refine(r => r.inn.length === 12 || r.kpp, { message: 'у организации (ИНН 10 цифр) нужен КПП', path: ['kpp'] })
  .refine(r => r.contact_phone || r.contact_email, { message: 'укажите телефон или email контакта', path: ['contact_phone'] });

const OnboardingSchema = z.discriminatedUnion('entity_type', [
  z.object({ entity_type: z.literal('individual') }),
  z.object({ entity_type: z.literal('legal'), requisites: RequisitesSchema }),
]);

const OrderSchema = z.object({
  proxy_type: z.string().trim().min(1).max(100),
  geo: z.string().trim().min(1).max(100),
  quantity: z.coerce.number().int().min(1).max(1000),
  comment: z.string().trim().max(1000).optional().default(''),
});

const csv = (v, d) => String(v == null || v === '' ? d : v).split(',').map(x => x.trim()).filter(Boolean);
const GEO_NAMES = { MD: 'Молдова', RO: 'Румыния', RU: 'Россия' };

module.exports = function createClientOnboardingRouter(deps) {
  const {
    db, logger, authMiddleware, adminMiddleware, clients, saveClients, alerts, getSetting,
    crm, auditLog, getClientIp, logActivity, tariffsDb, retailPoolDb,
  } = deps;
  const r = express.Router();

  const _clientOf = (req) => (req.user && clients.find(c => c.login === req.user.login)) || null;
  const _row = (id) => db.prepare('SELECT * FROM client_onboarding WHERE client_id = ?').get(id);

  // Спрашиваем один раз и только у самостоятельно зарегистрированных физлиц
  // (B2B-клиенты, заведённые вручную, — уже юрлица с реквизитами).
  function _needsChoice(c, row) {
    if (row) return false;
    if (c.clientType === 'legal' || c.inn) return false;
    return !!(c.email || c.consentPdAt || c.tgOidcSub);
  }

  async function _managerTask(task) {
    if (!crm || !String(getSetting('crm_db_url', '') || process.env.CRM_DB_URL || '')) return null;
    try { return (await crm.pushTask(getSetting, task)).taskId; }
    catch (e) { logger.warn('[Onboarding] задача в CRM не создана: ' + e.message); return null; }
  }

  // Реквизиты можно менять, пока договор не подписан (2026-10-15). Подписан —
  // статус «signed» в анкете, либо у клиента заведён договор вручную (номер/дата).
  // Номер договора: ЛК-<год>-<NNN>, сквозной по году; присваивается один раз.
  function _ensureContractNumber(clientId) {
    const row = _row(clientId);
    if (row && row.contract_number) return row.contract_number;
    const year = new Date().getFullYear();
    const last = db.prepare("SELECT contract_number FROM client_onboarding WHERE contract_number LIKE ? ORDER BY contract_number DESC LIMIT 1").get(`ЛК-${year}-%`);
    const seq = last ? (parseInt(String(last.contract_number).split('-')[2], 10) || 0) + 1 : 1;
    const number = `ЛК-${year}-${String(seq).padStart(3, '0')}`;
    db.prepare('UPDATE client_onboarding SET contract_number = ? WHERE client_id = ?').run(number, clientId);
    return number;
  }

  function _locked(c, row) {
    if (row) return row.contract_status === 'signed';
    return !!(c.contractInfo || c.contractDate);
  }

  r.get('/api/client/onboarding', authMiddleware, (req, res) => {
    const c = _clientOf(req);
    if (!c) return res.status(404).json({ error: 'Client not found' });
    const row = _row(c.id);
    // Анкеты нет, а реквизиты в карточке есть (клиент заведён вручную) — подставляем их в форму.
    const fromCard = (c.inn || c.legalName) ? { legal_name: c.legalName || '', inn: c.inn || '', kpp: c.kpp || '', legal_address: c.address || '' } : null;
    res.json({
      needsChoice: _needsChoice(c, row),
      entityType: row ? row.entity_type : (c.clientType === 'legal' ? 'legal' : null),
      contractStatus: row ? row.contract_status : (c.contractInfo || c.contractDate ? 'signed' : 'none'),
      locked: _locked(c, row),
      requisites: row ? JSON.parse(row.requisites_json || '{}') : fromCard,
    });
  });

  r.post('/api/client/onboarding', authMiddleware, async (req, res) => {
    const c = _clientOf(req);
    if (!c) return res.status(404).json({ error: 'Client not found' });
    const parsed = OnboardingSchema.safeParse(req.body || {});
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return res.status(400).json({ error: issue.message, field: (issue.path || []).slice(-1)[0] || null });
    }
    const existing = _row(c.id);
    if (_locked(c, existing)) {
      return res.status(409).json({ error: 'Договор уже подписан — реквизиты меняются через менеджера', code: 'LOCKED' });
    }
    const body = parsed.data;
    if (body.entity_type === 'individual') {
      db.prepare(`INSERT INTO client_onboarding (client_id, entity_type) VALUES (?, 'individual')
                  ON CONFLICT(client_id) DO UPDATE SET entity_type='individual', contract_status='none', updated_at=datetime('now')`).run(c.id);
      auditLog(c.login, 'onboarding_individual', { ip: getClientIp(req) });
      return res.json({ ok: true, entityType: 'individual' });
    }

    const q = body.requisites;
    const isUpdate = !!(existing && existing.entity_type === 'legal');
    // Изменение после того, как договор уже подготовлен/отправлен, возвращает его в работу.
    db.prepare(`INSERT INTO client_onboarding (client_id, entity_type, requisites_json, contract_status)
                VALUES (?, 'legal', ?, 'generated')
                ON CONFLICT(client_id) DO UPDATE SET entity_type='legal', requisites_json=excluded.requisites_json,
                  contract_status='generated', updated_at=datetime('now')`).run(c.id, JSON.stringify(q));
    _ensureContractNumber(c.id);
    // Реквизиты — в карточку клиента (счета, акты, поиск платежей по ИНН).
    c.inn = q.inn; c.kpp = q.kpp || ''; c.legalName = q.legal_name; c.address = q.legal_address;
    if (!c.contact) c.contact = [q.contact_name, q.contact_phone, q.contact_email].filter(Boolean).join(', ');
    saveClients(clients);

    const lines = [
      `**Организация:** ${q.legal_name}`, `**ИНН / КПП:** ${q.inn} / ${q.kpp || '—'}`, `**ОГРН:** ${q.ogrn || '—'}`,
      `**Юр. адрес:** ${q.legal_address}`, q.postal_address ? `**Почтовый адрес:** ${q.postal_address}` : null,
      `**Подписант:** ${q.signer_position} ${q.signer_name}, действует на основании ${q.signer_basis}`,
      `**Банк:** ${q.bank_name}, БИК ${q.bik}, р/с ${q.account}${q.corr_account ? ', к/с ' + q.corr_account : ''}`,
      `**Контакт:** ${[q.contact_name, q.contact_phone, q.contact_email].filter(Boolean).join(', ')}`,
      `**ЭДО:** ${[q.edo_operator, q.edo_id].filter(Boolean).join(', ') || 'не указано'}`,
      `**Логин в ЛК:** ${c.login}`, '',
      'Договор уже сформирован по шаблону: админка → Настройки → Розница → «Заказы и анкеты из ЛК» → «Скачать договор». Что сделать: проверить его, выслать по ЭДО и связаться с клиентом. Когда клиент подпишет — выберите статус «Подписан» в той же таблице (реквизиты клиента закроются для правки, договор попадёт в карточку клиента).',
    ].filter(x => x !== null);
    const taskId = await _managerTask({
      title: `${isUpdate ? 'Реквизиты изменены, договор заново' : 'Договор по ЭДО'}: ${q.legal_name} (ИНН ${q.inn})`,
      body: lines.join('\n'), personName: q.contact_name, email: q.contact_email || c.email, phone: q.contact_phone,
      opportunityName: `Юрлицо из ЛК: ${q.legal_name}`, dueInHours: 24,
    });
    if (taskId) db.prepare('UPDATE client_onboarding SET manager_task = ? WHERE client_id = ?').run(taskId, c.id);
    try {
      alerts.trigger('legal_onboarding', {
        client_id: c.id, login: c.login, legal_name: q.legal_name, inn: q.inn,
        contact: [q.contact_name, q.contact_phone, q.contact_email].filter(Boolean).join(', '),
        edo: [q.edo_operator, q.edo_id].filter(Boolean).join(', '), crm_task: !!taskId,
      });
    } catch (_) { /* best-effort */ }
    auditLog(c.login, 'onboarding_legal', { inn: q.inn, crm_task: taskId || null, ip: getClientIp(req) });
    logActivity('client', 'info', 'onboarding_legal', c.login, `Анкета юрлица: ${q.legal_name} (ИНН ${q.inn})`, { crm_task: taskId || null });
    res.json({ ok: true, entityType: 'legal', contractStatus: 'generated' });
  });

  // ── Справочник магазина ──────────────────────────────────────────────────
  r.get('/api/client/shop_catalog', authMiddleware, (req, res) => {
    if (!getSetting('retail_enabled', false)) return res.status(404).json({ error: 'Not found' });
    const tiers = tariffsDb.publicActive()
      .filter(t => (t.type || 'per_modem') === 'per_modem' && t.duration_hours == null)
      .map(t => ({ id: t.id, name: t.name, geo: String(t.geo || '').toUpperCase(), price: t.price, min_proxies: t.min_proxies || 1 }));
    const geos = [...new Set(tiers.map(t => t.geo))].filter(g => g && g !== 'RU');
    const testDay = tariffsDb.publicActive().find(t => t.duration_hours === 24);
    const c = _clientOf(req);
    const owned = c && retailPoolDb ? retailPoolDb.byClient(c.id).filter(p => p.status === 'leased').length : 0;
    const cur = c && c.tariffId != null ? tariffsDb.publicActive().find(t => t.id === c.tariffId) : null;
    // Деньги клиента: баланс и текущий суточный расход (прокси × цена ступени ÷ дней месяца).
    const now = new Date();
    const dim = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    const dailyCharge = cur && cur.duration_hours == null ? Math.round((cur.price / dim) * owned * 100) / 100 : 0;
    res.json({
      owned, currentGeo: cur ? String(cur.geo || '').toUpperCase() : null,
      balance: c ? Math.round((c.balance || 0) * 100) / 100 : 0,
      dailyCharge, daysInMonth: dim,
      emailVerified: !!(c && c.emailVerified),
      testDayAvailable: !!(c && !c.testUsed),
      europe: geos.map(g => ({
        geo: g, name: GEO_NAMES[g] || g, type: 'Мобильные (4G/LTE)',
        tiers: tiers.filter(t => t.geo === g).sort((a, b) => a.min_proxies - b.min_proxies),
      })),
      russia: {
        types: csv(getSetting('ru_proxy_types', ''), 'Мобильные (4G/LTE),Резидентские'),
        geos: csv(getSetting('ru_proxy_geos', ''), 'Москва,Санкт-Петербург,Другой регион РФ'),
        note: 'Прокси России выдаёт менеджер: после заявки он свяжется с вами, согласует цену и выдаст доступы.',
      },
      testDay: testDay ? { id: testDay.id, name: testDay.name, price: getSetting('retail_test_day_price', 100) } : null,
    });
  });

  // ── Заказы, которые выдаёт менеджер (прокси РФ) ──────────────────────────
  r.get('/api/client/proxy_orders', authMiddleware, (req, res) => {
    const c = _clientOf(req);
    if (!c) return res.status(404).json({ error: 'Client not found' });
    res.json({ orders: db.prepare('SELECT id, region, proxy_type, geo, quantity, comment, status, created_at FROM proxy_orders WHERE client_id = ? ORDER BY id DESC LIMIT 50').all(c.id) });
  });

  r.post('/api/client/proxy_orders', authMiddleware, async (req, res) => {
    const c = _clientOf(req);
    if (!c) return res.status(404).json({ error: 'Client not found' });
    if (c.blocked) return res.status(403).json({ error: 'Аккаунт заблокирован' });
    const parsed = OrderSchema.safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });
    const o = parsed.data;
    const open = db.prepare("SELECT COUNT(*) n FROM proxy_orders WHERE client_id = ? AND status = 'new' AND created_at >= datetime('now','-1 day')").get(c.id).n;
    if (open >= 5) return res.status(429).json({ error: 'Слишком много открытых заявок — менеджер уже обрабатывает ваши заказы' });
    const id = db.prepare('INSERT INTO proxy_orders (client_id, region, proxy_type, geo, quantity, comment) VALUES (?, ?, ?, ?, ?, ?)')
      .run(c.id, 'RU', o.proxy_type, o.geo, o.quantity, o.comment).lastInsertRowid;
    const who = c.legalName || c.name || c.login;
    const taskId = await _managerTask({
      title: `Выдать прокси РФ: ${o.quantity} шт, ${o.proxy_type}, ${o.geo} — ${who}`,
      body: [`**Заказ №${id}** из личного кабинета`, `**Клиент:** ${who} (логин ${c.login})`, `**Тип:** ${o.proxy_type}`,
        `**Гео:** ${o.geo}`, `**Количество:** ${o.quantity}`, o.comment ? `**Комментарий:** ${o.comment}` : null,
        `**Контакт:** ${[c.email, c.contact].filter(Boolean).join(', ') || '—'}`, '',
        'Что сделать: связаться с клиентом, согласовать цену и выдать прокси.'].filter(x => x !== null).join('\n'),
      personName: who, email: c.email, opportunityName: `Прокси РФ: ${who}`, dueInHours: 4,
    });
    if (taskId) db.prepare('UPDATE proxy_orders SET manager_task = ? WHERE id = ?').run(taskId, id);
    try { alerts.trigger('proxy_order_ru', { order_id: id, client: `${who} (${c.login})`, proxy_type: o.proxy_type, geo: o.geo, quantity: o.quantity, comment: o.comment, crm_task: !!taskId }); } catch (_) { /* best-effort */ }
    auditLog(c.login, 'proxy_order_ru', { id, ...o, ip: getClientIp(req) });
    res.json({ ok: true, order: { id, status: 'new', ...o } });
  });

  // ── Админка: заказы прокси РФ и анкеты юрлиц ─────────────────────────────
  const STATUSES = ['new', 'in_progress', 'done', 'cancelled'];
  const _clientName = (id) => { const c = clients.find(x => x.id === id); return c ? (c.legalName || c.name || c.login) : id; };
  r.get('/api/admin/proxy_orders', authMiddleware, adminMiddleware, (req, res) => {
    const rows = db.prepare('SELECT * FROM proxy_orders ORDER BY id DESC LIMIT 200').all();
    res.json({ orders: rows.map(o => ({ ...o, client: _clientName(o.client_id) })) });
  });
  r.post('/api/admin/proxy_orders/:id', authMiddleware, adminMiddleware, (req, res) => {
    const status = String((req.body || {}).status || '');
    if (!STATUSES.includes(status)) return res.status(400).json({ error: 'bad status' });
    const info = db.prepare("UPDATE proxy_orders SET status = ?, updated_at = datetime('now') WHERE id = ?").run(status, req.params.id);
    if (!info.changes) return res.status(404).json({ error: 'not found' });
    auditLog(req.user.login, 'proxy_order_status', { id: Number(req.params.id), status, ip: getClientIp(req) });
    res.json({ ok: true });
  });
  r.get('/api/admin/onboarding', authMiddleware, adminMiddleware, (req, res) => {
    const rows = db.prepare("SELECT * FROM client_onboarding WHERE entity_type = 'legal' ORDER BY updated_at DESC LIMIT 200").all();
    res.json({ items: rows.map(o => ({ client_id: o.client_id, client: _clientName(o.client_id), contract_status: o.contract_status, contract_number: o.contract_number || null,
      manager_task: o.manager_task, created_at: o.created_at, requisites: JSON.parse(o.requisites_json || '{}') })) });
  });
  r.get('/api/admin/onboarding/:clientId/contract.docx', authMiddleware, adminMiddleware, async (req, res) => {
    const row = _row(req.params.clientId);
    if (!row || row.entity_type !== 'legal') return res.status(404).json({ error: 'Анкеты юрлица нет' });
    try {
      const q = JSON.parse(row.requisites_json || '{}');
      const number = _ensureContractNumber(row.client_id);
      // Дата договора — день выгрузки, пока он не подписан; после подписания — зафиксирована.
      const signed = row.contract_status === 'signed' && row.contract_date;
      const day = signed ? row.contract_date : new Date().toISOString().slice(0, 10);
      if (!signed) db.prepare("UPDATE client_onboarding SET contract_date = ? WHERE client_id = ?").run(day, row.client_id);
      const buf = await contractDoc.buildContract(q, number, new Date(day + 'T12:00:00'));
      const fname = `Договор ${number} ${q.legal_name || ''}.docx`.replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim();
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
      res.setHeader('Content-Disposition', `attachment; filename="contract.docx"; filename*=UTF-8''${encodeURIComponent(fname)}`);
      auditLog(req.user.login, 'onboarding_contract_download', { client_id: row.client_id, number, ip: getClientIp(req) });
      res.send(buf);
    } catch (e) {
      logger.error('[Onboarding] contract: ' + e.message);
      res.status(500).json({ error: 'Не удалось сформировать договор: ' + e.message });
    }
  });
  r.post('/api/admin/onboarding/:clientId', authMiddleware, adminMiddleware, (req, res) => {
    const status = String((req.body || {}).contract_status || '');
    if (!['awaiting_template', 'generated', 'sent', 'signed'].includes(status)) return res.status(400).json({ error: 'bad status' });
    const info = db.prepare("UPDATE client_onboarding SET contract_status = ?, updated_at = datetime('now') WHERE client_id = ?").run(status, req.params.clientId);
    if (!info.changes) return res.status(404).json({ error: 'not found' });
    if (status === 'signed') {
      // Подписан: фиксируем дату и записываем договор в карточку клиента (основание для счетов и актов).
      const row = _row(req.params.clientId);
      const number = _ensureContractNumber(req.params.clientId);
      const day = row.contract_date || new Date().toISOString().slice(0, 10);
      db.prepare('UPDATE client_onboarding SET contract_date = ? WHERE client_id = ?').run(day, req.params.clientId);
      const c = clients.find(x => x.id === req.params.clientId);
      if (c) { c.contractInfo = `Договор № ${number}`; c.contractDate = day; saveClients(clients); }
    }
    auditLog(req.user.login, 'onboarding_contract_status', { client_id: req.params.clientId, status, ip: getClientIp(req) });
    res.json({ ok: true });
  });

  return r;
};

module.exports.RequisitesSchema = RequisitesSchema;
