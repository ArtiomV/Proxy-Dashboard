'use strict';
//
// src/routes/public-tariffs.js — ПУБЛИЧНАЯ витрина тарифов для лендинга.
//
//   GET /api/public/tariffs — без авторизации, CORS '*': лендинг
//   (arendaproxy.ru) дергает этот endpoint и рисует актуальные цены —
//   при изменении тарифов в админке лендинг обновляется сам.
//
// Отдаём ТОЛЬКО public=1 + active=1 строки единого прайса (Р36) + цену
// тест-дня. Когда retail_enabled выключен — enabled:false и пустой список:
// лендинг по этому флагу скрывает розничный блок и показывает B2B-заявку.
// Без кэша: запросы — два индексных чтения SQLite (мкс), лендинг-трафик
// их не заметит; зато правка тарифа в админке видна на сайте мгновенно.

module.exports = function createPublicTariffsRouter(deps) {
  const { tariffsDb, getSetting } = deps;
  const express = require('express');
  const r = express.Router();

  r.get('/api/public/tariffs', (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'public, max-age=60');
    const enabled = !!getSetting('retail_enabled', false);
    const testDayPrice = Number(getSetting('retail_test_day_price', 0)) || 0;
    const tariffs = enabled ? tariffsDb.publicActive().map(t => ({
      id: t.id,
      name: t.name,
      type: t.type,                                  // per_modem | per_gb
      geo: t.geo,
      price: t.price,                                // канон: ₽/мес | ₽/ГБ
      perDay: Math.round((t.price / 30.4) * 100) / 100,
      minProxies: t.min_proxies,
      rotationAllowed: !!t.rotation_allowed,
      durationHours: t.duration_hours || null,       // 24 = тест-день
      isTestDay: t.duration_hours === 24,
    })) : [];
    res.json({ enabled, testDayPrice, tariffs });
  });

  return r;
};
