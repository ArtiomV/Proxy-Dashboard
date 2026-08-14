'use strict';
//
// src/routes/public-lead.js — ПУБЛИЧНЫЙ приём заявок с лендинга arendaproxy.ru.
//
//   POST /api/public/lead — без авторизации, CORS '*': telegram-form.js на
//   сайте дублирует каждую заявку сюда параллельно с отправкой в TG-бота.
//
// Контур надёжности (заявка = деньги, терять нельзя):
//   1. Пишем в локальную таблицу leads ВСЕГДА (аудит + возможность допушить).
//   2. Push в Twenty CRM (src/crm/twenty-leads.js) — прямой Postgres на этом
//      же сервере. Ошибка НЕ валит запрос: crm_status='failed' + алерт
//      админу (crm_lead_failed) — заявка сохранена локально и в TG.
//   3. Honeypot-поле website: заполнено → молчаливый {ok:true} без записи
//      (боты шлют его всегда, человекам оно невидимо). Как в RegisterSchema.
//   4. Rate-limit по IP: 10 заявок/час — достаточно для человека, мало для спама.

const rateLimit = require('express-rate-limit');
const { LeadSchema } = require('../schemas');
const twentyLeads = require('../crm/twenty-leads');

const leadLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Слишком много заявок, попробуйте позже' },
});

module.exports = function createPublicLeadRouter(deps) {
  const { logger, db, validate, getSetting, alerts, getClientIp } = deps;
  const express = require('express');
  const r = express.Router();

  const insertLead = db.prepare(
    `INSERT INTO leads (contact, contact_type, message, product, offer, page, cta_position, utm_json, ip)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const markCrm = db.prepare('UPDATE leads SET crm_status = ?, crm_person_id = ? WHERE id = ?');

  // CORS preflight для браузерного fetch с лендинга.
  r.options('/api/public/lead', (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.status(204).end();
  });

  r.post('/api/public/lead', leadLimiter, validate(LeadSchema), async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    const b = req.body;

    // Honeypot: бот заполнил невидимое поле → делаем вид, что всё ок.
    if (b.website) return res.json({ ok: true });

    const contact = b.contact.trim();
    const contactType = /^[+]?[0-9\s\-()]{7,18}$/.test(contact) ? 'phone' : 'telegram';

    let id;
    try {
      id = insertLead.run(
        contact, contactType, b.text || '', b.product || '', b.offer || '',
        b.page || '', b.ctaPosition || '', JSON.stringify(b.utm || {}),
        (getClientIp && getClientIp(req)) || ''
      ).lastInsertRowid;
    } catch (e) {
      logger.error('[Lead] DB insert failed: ' + e.message);
      return res.status(500).json({ error: 'Не удалось сохранить заявку' });
    }

    // Push в Twenty CRM: неудача не теряет заявку — она уже в leads и в TG.
    try {
      const out = await twentyLeads.pushLead(getSetting, {
        contact, contact_type: contactType, message: b.text || '',
        product: b.product || '', offer: b.offer || '',
        page: b.page || '', cta_position: b.ctaPosition || '', utm: b.utm || {},
      });
      markCrm.run('pushed', out.personId || '', id);
      return res.json({ ok: true, crm: true });
    } catch (e) {
      logger.warn('[Lead] Twenty push failed (lead #' + id + ' сохранён локально): ' + e.message);
      try { markCrm.run('failed', '', id); } catch (_) { /* best-effort */ }
      try { alerts && alerts.trigger('crm_lead_failed', { id, contact, error: e.message }); } catch (_) { /* best-effort */ }
      return res.json({ ok: true, crm: false });
    }
  });

  return r;
};
