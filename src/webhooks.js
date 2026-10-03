'use strict';
//
// src/webhooks.js — доставка событий на вебхук клиента (03.10).
// Одна запись на клиента (таблица client_webhooks, миграция 110). Вызов —
// из SSE-пушей server.js: deliver(db, login, event, data) — сам найдёт
// клиента и его вебхук, проверит подписку на событие и отправит POST.
// Формат: JSON {event, data, ts} + заголовок X-Webhook-Event. Таймаут 5 с,
// ретраев в v1 нет — статус последней доставки пишется в last_ok_at/last_error.

const https = require('https');
const http = require('http');

const TIMEOUT_MS = 5000;

function create({ db, logger, clientByLogin }) {
  let _getStmt = null, _okStmt = null, _errStmt = null;
  function _stmts() {
    if (!_getStmt) {
      _getStmt = db.prepare('SELECT url, events, enabled FROM client_webhooks WHERE client_id = ?');
      _okStmt = db.prepare("UPDATE client_webhooks SET last_ok_at = datetime('now'), last_error = NULL WHERE client_id = ?");
      _errStmt = db.prepare('UPDATE client_webhooks SET last_error = ? WHERE client_id = ?');
    }
    return { get: _getStmt, ok: _okStmt, err: _errStmt };
  }

  // login → webhook row (или null). Таблицы может не быть до миграции — молча.
  function _hookFor(login) {
    try {
      const client = clientByLogin.get(login);
      if (!client) return null;
      const row = _stmts().get.get(client.id);
      if (!row || !row.enabled || !row.url) return null;
      return row;
    } catch (_) { return null; }
  }

  function deliver(login, event, data, force) {
    const hook = _hookFor(login);
    if (!hook) return;
    const subscribed = String(hook.events || '').split(',').map(s => s.trim());
    if (!force && !subscribed.includes(event)) return;
    const payload = JSON.stringify({ event, data: data == null ? {} : data, ts: new Date().toISOString() });
    let url;
    try { url = new URL(hook.url); } catch (_) { return; }
    const mod = url.protocol === 'https:' ? https : http;
    const req = mod.request({
      method: 'POST',
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      timeout: TIMEOUT_MS,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'X-Webhook-Event': event,
      },
    }, (res) => {
      // тело не читаем — важен только статус
      res.resume();
      res.on('end', () => {
        try {
          if (res.statusCode >= 200 && res.statusCode < 300) _stmts().ok.run(_clientId(login));
          else _stmts().err.run('HTTP ' + res.statusCode, _clientId(login));
        } catch (_) { /* best-effort */ }
      });
    });
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', (e) => {
      try { _stmts().err.run(e.message, _clientId(login)); } catch (_) { /* best-effort */ }
      if (logger) logger.warn('[Webhooks] ' + login + ' ' + event + ': ' + e.message);
    });
    req.write(payload);
    req.end();
  }

  function _clientId(login) {
    const c = clientByLogin.get(login);
    return c ? c.id : '';
  }

  return { deliver };
}

module.exports = { create };
