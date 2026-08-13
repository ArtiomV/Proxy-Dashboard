'use strict';
//
// src/routes/tariffs.js — CRUD единого прайса (Р36) + розничная витрина.
//
//   ADMIN:  GET/POST/PUT/DELETE /api/admin/tariffs — управление прайсом.
//   CLIENT: GET /api/client/tariffs — витрина (public=1, active=1), только при
//           retail_enabled. ₽/мес крупно + ≈₽/день (price/30.4) производное.
//
// pricing_tiers (kv) мигрирован в tariffs при boot и больше не читается.

const express = require('express');
const { z } = require('zod');

const TariffSchema = z.object({
  name: z.string().min(1).max(200),
  type: z.enum(['per_modem', 'per_gb']).default('per_modem'), // flat нет — Р34
  geo: z.string().min(1).max(20),
  server: z.string().max(50).default(''),
  price: z.coerce.number().positive().max(1_000_000),
  min_proxies: z.coerce.number().int().min(1).max(100000).default(1),
  public: z.boolean().default(false),
  is_default: z.boolean().default(false),
  maxconn: z.coerce.number().int().min(1).max(100000).nullish(),
  bandlim_kbit: z.coerce.number().int().min(1).max(10_000_000).nullish(),
  rotation_allowed: z.boolean().default(true),
  min_topup_days: z.coerce.number().int().min(1).max(90).default(1),
  duration_hours: z.coerce.number().int().min(1).max(24 * 365).nullish(), // 24 = тест-день
  active: z.boolean().default(true),
  sort: z.coerce.number().int().min(0).max(10000).default(0),
});

module.exports = function createTariffsRouter(deps) {
  const {
    logger, authMiddleware, adminMiddleware, validate,
    tariffsDb, auditLog, getClientIp, getSetting,
  } = deps;
  const r = express.Router();

  function _pub(t) {
    const day = t.type === 'per_modem' ? Math.round((t.price / 30.4) * 100) / 100 : null;
    return {
      id: t.id, name: t.name, type: t.type, geo: t.geo, server: t.server,
      price: t.price, price_day: day,                        // ≈₽/день — производное на витрине
      min_proxies: t.min_proxies, public: !!t.public, is_default: !!t.is_default,
      maxconn: t.maxconn, bandlim_kbit: t.bandlim_kbit,
      rotation_allowed: !!t.rotation_allowed, min_topup_days: t.min_topup_days,
      duration_hours: t.duration_hours,                      // 24 = тест-день
      active: !!t.active, sort: t.sort,
    };
  }

  // ── Витрина для розницы (авторизованный клиент ЛК) ─────────────────────
  r.get('/api/client/tariffs', authMiddleware, (req, res) => {
    if (!getSetting('retail_enabled', false)) return res.status(404).json({ error: 'Not found' });
    res.json({ tariffs: tariffsDb.publicActive().map(_pub) });
  });

  // ── Админский CRUD ──────────────────────────────────────────────────────
  r.get('/api/admin/tariffs', authMiddleware, adminMiddleware, (req, res) => {
    res.json({ tariffs: tariffsDb.all().map(_pub) });
  });

  r.post('/api/admin/tariffs', authMiddleware, adminMiddleware, validate(TariffSchema), (req, res) => {
    const result = tariffsDb.insert(req.body);
    const t = tariffsDb.byId(result.lastInsertRowid);
    auditLog(req.user.login, 'tariff_created', { id: t.id, name: t.name, price: t.price, ip: getClientIp(req) });
    res.json({ ok: true, tariff: _pub(t) });
  });

  r.put('/api/admin/tariffs/:id', authMiddleware, adminMiddleware, validate(TariffSchema.partial()), (req, res) => {
    const old = tariffsDb.byId(req.params.id);
    if (!old) return res.status(404).json({ error: 'Tariff not found' });
    // merge: PUT-обновление только переданных полей (partial-схема)
    const merged = { ...old, ...req.body };
    tariffsDb.update(old.id, merged);
    const t = tariffsDb.byId(old.id);
    // Р32: изменение цены действует на привязанных с даты изменения — биллинг
    // читает актуальный tariffs.price на каждом списании, отдельных действий не нужно.
    if (req.body.price != null && req.body.price !== old.price) {
      auditLog(req.user.login, 'tariff_price_changed', { id: t.id, old: old.price, new: t.price, ip: getClientIp(req) });
    } else {
      auditLog(req.user.login, 'tariff_updated', { id: t.id, ip: getClientIp(req) });
    }
    res.json({ ok: true, tariff: _pub(t) });
  });

  r.delete('/api/admin/tariffs/:id', authMiddleware, adminMiddleware, (req, res) => {
    const old = tariffsDb.byId(req.params.id);
    if (!old) return res.status(404).json({ error: 'Tariff not found' });
    // Не даём удалить тариф с привязанными клиентами — сначала active=0
    const bound = deps.db.prepare('SELECT COUNT(*) AS cnt FROM clients WHERE tariff_id = ?').get(old.id).cnt;
    if (bound > 0) {
      return res.status(409).json({ error: `Тариф привязан к ${bound} клиентам — деактивируйте вместо удаления` });
    }
    tariffsDb.remove(old.id);
    auditLog(req.user.login, 'tariff_deleted', { id: old.id, name: old.name, ip: getClientIp(req) });
    res.json({ ok: true });
  });

  return r;
};
