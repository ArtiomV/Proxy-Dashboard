'use strict';
//
// src/routes/promo-codes.js — WP6 (Этап 7): промокоды розницы.
//
//   GET  /api/client/promo/check?code=X&context=topup|buy — проверка кода
//        для UI ЛК (auth; retail_enabled). Ничего не списывает.
//   GET  /api/admin/promo-codes          — список (с использованием)
//   POST /api/admin/promo-codes          — создать {code,type,value,max_uses?,expires_at?}
//   POST /api/admin/promo-codes/:id/toggle — вкл/выкл
//   DELETE /api/admin/promo-codes/:id    — удалить
//
// Семантика типов — см. src/db/promo-codes.js. Само применение — в точках
// денег: topup (payments.js) и buy_proxy (retail.js); здесь только проверка
// и управление.

const express = require('express');
const { z } = require('zod');

const PromoCreateSchema = z.object({
  code: z.string().min(3).max(50).regex(/^[A-Za-z0-9_-]+$/, 'Только латиница, цифры, - и _'),
  type: z.enum(['percent', 'fixed', 'bonus_days']),
  value: z.coerce.number().positive().max(100000),
  max_uses: z.coerce.number().int().positive().max(1000000).nullish(),
  expires_at: z.string().regex(/^\d{4}-\d{2}-\d{2}/).nullish(),  // YYYY-MM-DD
});

// Человекочитаемое описание для ЛК.
function describe(promo) {
  if (promo.type === 'percent') return `+${promo.value}% к пополнению`;
  if (promo.type === 'fixed') return `+${promo.value} ₽ к пополнению`;
  return `+${promo.value} дн. при покупке`;
}

// Куда применим тип: percent/fixed — пополнение, bonus_days — покупка.
function fitsContext(promo, context) {
  return promo.type === 'bonus_days' ? context === 'buy' : context === 'topup';
}

module.exports = function createPromoCodesRouter(deps) {
  const { logger, authMiddleware, adminMiddleware, promoDb, getSetting, auditLog, getClientIp } = deps;
  const r = express.Router();

  // ── ЛК: проверка промокода (без списания — списывает точка денег) ────────
  r.get('/api/client/promo/check', authMiddleware, (req, res) => {
    if (!getSetting('retail_enabled', false)) return res.status(404).json({ error: 'Not found' });
    const code = String(req.query.code || '').trim();
    const context = req.query.context === 'buy' ? 'buy' : 'topup';
    if (!code) return res.status(400).json({ error: 'Укажите промокод' });
    const { promo, error } = promoDb.findValid(code);
    if (error) return res.status(404).json({ ok: false, error });
    if (!fitsContext(promo, context)) {
      return res.status(400).json({
        ok: false,
        error: promo.type === 'bonus_days'
          ? 'Этот промокод действует при покупке прокси'
          : 'Этот промокод действует при пополнении баланса',
      });
    }
    res.json({ ok: true, type: promo.type, value: promo.value, description: describe(promo) });
  });

  // ── Админка: CRUD ────────────────────────────────────────────────────────
  r.get('/api/admin/promo-codes', authMiddleware, adminMiddleware, (req, res) => {
    res.json({
      promo_codes: promoDb.list().map(p => ({
        id: p.id, code: p.code, type: p.type, value: p.value,
        max_uses: p.max_uses, used: p.used, expires_at: p.expires_at,
        active: !!p.active, created_at: p.created_at, description: describe(p),
      })),
    });
  });

  r.post('/api/admin/promo-codes', authMiddleware, adminMiddleware, (req, res) => {
    const parsed = PromoCreateSchema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({ error: 'Validation error', details: parsed.error.flatten().fieldErrors });
    }
    const d = parsed.data;
    if (d.type === 'percent' && d.value > 100) {
      return res.status(400).json({ error: 'percent: не больше 100' });
    }
    if (promoDb.findValid(d.code).promo || promoDb.list().some(p => p.code.toLowerCase() === d.code.toLowerCase())) {
      return res.status(409).json({ error: 'Такой промокод уже существует' });
    }
    const id = promoDb.create({
      code: d.code, type: d.type, value: d.value,
      max_uses: d.max_uses || null,
      expires_at: d.expires_at ? String(d.expires_at).slice(0, 10) + 'T23:59:59.000Z' : null,
    });
    auditLog(req.user.login, 'promo_code_create', { id, code: d.code, type: d.type, value: d.value, ip: getClientIp(req) });
    res.json({ ok: true, id });
  });

  r.post('/api/admin/promo-codes/:id/toggle', authMiddleware, adminMiddleware, (req, res) => {
    const id = parseInt(req.params.id, 10);
    const promo = promoDb.list().find(p => p.id === id);
    if (!promo) return res.status(404).json({ error: 'Промокод не найден' });
    promoDb.setActive(id, !promo.active);
    auditLog(req.user.login, 'promo_code_toggle', { id, code: promo.code, active: !promo.active, ip: getClientIp(req) });
    res.json({ ok: true, active: !promo.active });
  });

  r.delete('/api/admin/promo-codes/:id', authMiddleware, adminMiddleware, (req, res) => {
    const id = parseInt(req.params.id, 10);
    const promo = promoDb.list().find(p => p.id === id);
    if (!promo) return res.status(404).json({ error: 'Промокод не найден' });
    promoDb.remove(id);
    logger.info(`[Promo] удалён ${promo.code} (used ${promo.used}) админом ${req.user.login}`);
    auditLog(req.user.login, 'promo_code_delete', { id, code: promo.code, used: promo.used, ip: getClientIp(req) });
    res.json({ ok: true });
  });

  return r;
};
