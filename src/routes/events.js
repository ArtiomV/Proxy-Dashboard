'use strict';
//
// src/routes/events.js — SSE (ТЗ мониторинга v2, этап 5, 23.08):
//
//   GET /api/admin/events — Server-Sent Events поток realtime-обновлений
//   админки (шина — src/events.js). Auth — та же admin-сессия, что у
//   остальных /api/admin/*: нативный EventSource не умеет заголовки, поэтому
//   принимаем токен из ?token= (cookie pr_session тоже доходит same-origin —
//   тогда query не нужен). sse_enabled=false → 503, фронт остаётся на
//   polling 60 сек.

const express = require('express');

module.exports = function (deps) {
  const { logger, authMiddleware, adminMiddleware, getSetting, events } = deps;
  const r = express.Router();

  r.get('/api/admin/events',
    (req, res, next) => {
      // Подсовываем ?token= в заголовок, чтобы дальше работал штатный
      // authMiddleware — та же таблица sessions, те же проверки (без
      // дублирования логики сессий).
      const hasCookie = /(?:^|;\s*)pr_session=/.test(req.headers.cookie || '');
      if (!req.headers['x-auth-token'] && !hasCookie && req.query && req.query.token) {
        req.headers['x-auth-token'] = String(req.query.token);
      }
      next();
    },
    authMiddleware, adminMiddleware,
    (req, res) => {
      if (!getSetting('sse_enabled', true)) {
        return res.status(503).json({ error: 'Realtime (SSE) выключен настройкой sse_enabled' });
      }
      // Лимит клиентов на admin-сессию проверяем ДО открытия потока —
      // так отказ это обычный 429, а не оборванный SSE.
      const sessionId = req.user.token || req.user.login;
      if (!events.subscribe(res, sessionId)) {
        return res.status(429).json({ error: 'Слишком много SSE-подключений для сессии (лимит 10)' });
      }
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',   // Nginx: не буферизовать SSE
      });
      res.write(':ok\n\n');
      logger.info('[SSE] client connected (' + req.user.login + ')');
    });

  return r;
};
