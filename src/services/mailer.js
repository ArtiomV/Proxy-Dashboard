'use strict';
// src/services/mailer.js — обёртка SendPulse SMTP (WP1: верификация email,
// сброс пароля, чеки 54-ФЗ). Креды — в appSettings (sendpulse_smtp_user/pass,
// enc1: в kv; getSetting расшифровывает).
//
// Режим БЕЗ кредов (код готовим до аккаунта SendPulse): письмо не уходит,
// payload пишется в kv-очередь `mail_outbox` + system_log, send() возвращает
// { ok: false, queued: true } — потоки verify/reset продолжают работать
// (токен доступен админу через очередь), запуск не блокируется.
//
// SMTP — через nodemailer, если установлен; иначе fallback в очередь даже при
// наличии кредов (с warn). Зависимость опциональна намеренно: не ломать prod
// при отсутствии пакета.

const fs = require('fs');
const path = require('path');

let _nodemailer = null;
try { _nodemailer = require('nodemailer'); } catch (_) { /* optional dep */ }

let _deps = null;
let _transport = null;
let _transportKey = '';

function init(deps) {
  _deps = deps; // { logger, getSetting, kvSet, kvGet, logActivity }
}

function _creds() {
  const g = _deps.getSetting;
  return {
    user: g('sendpulse_smtp_user', ''),
    pass: g('sendpulse_smtp_pass', ''),
    from: g('sendpulse_from', '') || g('sendpulse_smtp_user', ''),
  };
}

function isConfigured() {
  const c = _creds();
  return !!(c.user && c.pass && _nodemailer);
}

function _getTransport(c) {
  const key = c.user + '|' + c.pass;
  if (_transport && _transportKey === key) return _transport;
  // 465/SSL на Hetzner-сервере закрыт провайдером (таймаут, 15.08.2026) —
  // уходим на 587/STARTTLS, он открыт.
  _transport = _nodemailer.createTransport({
    host: 'smtp-pulse.com', port: 587, secure: false,
    auth: { user: c.user, pass: c.pass },
  });
  _transportKey = key;
  return _transport;
}

// Письмо в локальную очередь (kv `mail_outbox`, последние 50) — видно админу
// и используется как журнал при живом SMTP.
function _queue(entry) {
  try {
    const row = _deps.kvGet('mail_outbox');
    const list = row ? JSON.parse(row.value) : [];
    list.push(entry);
    while (list.length > 50) list.shift();
    _deps.kvSet('mail_outbox', JSON.stringify(list));
  } catch (e) { _deps.logger.error('[Mailer] outbox write failed: ' + e.message); }
}

/**
 * send({ to, subject, text, html, kind }) — единая точка отправки.
 * kind: verify_email | reset_password | receipt | notification (для очереди/логов).
 * Возвращает { ok, queued?, error? }.
 */
async function send({ to, subject, text, html, kind }) {
  const entry = { at: new Date().toISOString(), to, subject, kind: kind || 'notification' };
  const c = _creds();
  if (!isConfigured()) {
    entry.queued = true;
    entry.reason = !_nodemailer ? 'nodemailer_missing' : 'no_credentials';
    // Тело письма с токеном — тоже в очередь: без SendPulse это единственный
    // способ достать ссылку верификации/сброса (через админку).
    entry.text = text || '';
    _queue(entry);
    _deps.logger.warn(`[Mailer] ${entry.reason} — письмо ${entry.kind} → ${to} помещено в mail_outbox`);
    try { _deps.logActivity('system', 'warn', 'mail_queued', to, `Письмо ${entry.kind} в очередь (${entry.reason})`, { subject }); } catch (_) {}
    return { ok: false, queued: true, reason: entry.reason };
  }
  try {
    await _getTransport(c).sendMail({ from: c.from, to, subject, text, html });
    _queue(entry); // журнал отправленных
    return { ok: true };
  } catch (e) {
    _deps.logger.error(`[Mailer] SMTP send failed (${kind} → ${to}): ${e.message}`);
    entry.queued = true; entry.reason = 'smtp_error'; entry.error = e.message; entry.text = text || '';
    _queue(entry);
    return { ok: false, queued: true, reason: 'smtp_error', error: e.message };
  }
}

module.exports = { init, send, isConfigured };
