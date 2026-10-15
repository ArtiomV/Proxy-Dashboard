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
  // Список серверов выдачи по порядку приоритета: «S1, S3». Пусто — пул розницы.
  server: z.string().max(200).default('')
    .transform(v => String(v).split(/[\s,;]+/).map(x => x.trim()).filter(Boolean).join(', ')),
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

// PUT — частичное обновление. В zod 4 TariffSchema.partial() ПОДСТАВЛЯЕТ значения по
// умолчанию для не переданных полей (server='', public=false, min_proxies=1, …):
// запрос «поменять только цену» молча сбрасывал серверы и витрину тарифа. Для PATCH
// схема строится из тех же полей, но без default.
const _stripDefault = (v) => {
  if (v && v.def && v.def.type === 'default') return v.def.innerType;
  // default().transform(...) = pipe(default, transform): убираем default во входе пайпа
  if (v && v.def && v.def.type === 'pipe' && v.def.in && v.def.in.def && v.def.in.def.type === 'default') return z.pipe(v.def.in.def.innerType, v.def.out);
  return v;
};
const TariffPatchSchema = z.object(
  Object.fromEntries(Object.entries(TariffSchema.shape).map(([k, v]) => [k, _stripDefault(v)]))
).partial();

module.exports = function createTariffsRouter(deps) {
  const {
    logger, authMiddleware, adminMiddleware, validate,
    tariffsDb, auditLog, getClientIp, getSetting, SERVER_COUNTRIES,
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

  // 2026-10-15: серверы тарифа выбираются из реальных боксов, и все они должны быть
  // из СТРАНЫ тарифа (гео): тариф «MD» со списком «S1, S3, S4, RO1» продавал бы
  // молдавскую цену на румынском боксе. Неизвестное имя сервера — тоже ошибка.
  function _serversError(geo, serverCsv) {
    const names = String(serverCsv || '').split(/[\s,;]+/).filter(Boolean);
    const map = SERVER_COUNTRIES || {};
    if (!Object.keys(map).length) return null;   // серверы не настроены (тестовая среда) — проверять нечего
    for (const n of names) {
      const meta = map[n];
      if (!meta) return `Сервер «${n}» не найден среди настроенных серверов`;
      const c = String(meta.country || '').toUpperCase();
      if (c && String(geo || '').toUpperCase() !== c) return `Сервер «${n}» из страны ${c}, а тариф — ${String(geo).toUpperCase()}: выберите серверы той же страны`;
    }
    return null;
  }

  r.post('/api/admin/tariffs', authMiddleware, adminMiddleware, validate(TariffSchema), (req, res) => {
    const bad = _serversError(req.body.geo, req.body.server);
    if (bad) return res.status(400).json({ error: bad });
    const result = tariffsDb.insert(req.body);
    const t = tariffsDb.byId(result.lastInsertRowid);
    auditLog(req.user.login, 'tariff_created', { id: t.id, name: t.name, price: t.price, ip: getClientIp(req) });
    res.json({ ok: true, tariff: _pub(t) });
  });

  r.put('/api/admin/tariffs/:id', authMiddleware, adminMiddleware, validate(TariffPatchSchema), (req, res) => {
    const old = tariffsDb.byId(req.params.id);
    if (!old) return res.status(404).json({ error: 'Tariff not found' });
    // merge: PUT-обновление только переданных полей (partial-схема)
    const merged = { ...old, ...req.body };
    // Проверяем только если менялись гео или серверы — старые тарифы с устаревшим значением можно править дальше.
    if (req.body.geo !== undefined || req.body.server !== undefined) {
      const bad = _serversError(merged.geo, merged.server);
      if (bad) return res.status(400).json({ error: bad });
    }
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
