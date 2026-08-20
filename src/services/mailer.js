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

module.exports = { init, send, isConfigured, renderTemplate };

// ── Брендированный HTML-шаблон (20.08) ─────────────────────────────────────
// Тёмная тема в стиле arendaproxy.ru, акцент #ffcc00. Совместимость с
// почтовыми клиентами: табличная вёрстка, только inline-стили, без внешних
// шрифтов/скриптов. Логотип — PNG с prod-домена (webp не везде рендерится).
function renderTemplate({ title, intro, ctaText, ctaUrl, note }) {
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
  const cta = ctaUrl
    ? `<tr><td align="center" style="padding:24px 0 8px;">
         <a href="${esc(ctaUrl)}" target="_blank"
            style="display:inline-block;background:#ffcc00;color:#1a1a1a;text-decoration:none;
                   font-weight:700;font-size:15px;padding:14px 36px;border-radius:10px;">${esc(ctaText || 'Открыть')}</a>
       </td></tr>
       <tr><td style="padding:12px 0 0;color:#8b8b8b;font-size:12px;line-height:1.5;word-break:break-all;">
         Если кнопка не работает, скопируйте ссылку в браузер:<br>
         <a href="${esc(ctaUrl)}" target="_blank" style="color:#ffcc00;">${esc(ctaUrl)}</a>
       </td></tr>`
    : '';
  const noteRow = note
    ? `<tr><td style="padding:20px 0 0;color:#8b8b8b;font-size:12px;line-height:1.6;">${esc(note)}</td></tr>`
    : '';
  return `<!DOCTYPE html>
<html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title></head>
<body style="margin:0;padding:0;background:#0e0e10;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0e0e10;padding:32px 16px;">
<tr><td align="center">
  <table role="presentation" width="520" cellpadding="0" cellspacing="0"
         style="max-width:520px;width:100%;background:#17171b;border:1px solid #2a2a30;border-radius:16px;overflow:hidden;">
    <tr><td style="height:4px;background:#ffcc00;font-size:0;line-height:0;">&nbsp;</td></tr>
    <tr><td align="center" style="padding:28px 32px 8px;">
      <img src="https://app.arendaproxy.ru/img/brand-favicon-96.png" width="48" height="48" alt="Arendaproxy"
           style="display:block;border-radius:12px;">
      <div style="padding-top:12px;color:#ffffff;font:700 20px/1.3 -apple-system,Segoe UI,Roboto,Arial,sans-serif;">${esc(title)}</div>
    </td></tr>
    <tr><td style="padding:12px 32px 8px;color:#c9c9cf;font:400 14px/1.7 -apple-system,Segoe UI,Roboto,Arial,sans-serif;">
      ${intro}
    </td></tr>
    <tr><td style="padding:0 32px 28px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${cta}${noteRow}</table>
    </td></tr>
  </table>
  <div style="padding-top:16px;color:#6a6a72;font:400 11px/1.5 -apple-system,Segoe UI,Roboto,Arial,sans-serif;">
    Arendaproxy.ru — мобильные прокси. Письмо отправлено автоматически, отвечать на него не нужно.
  </div>
</td></tr>
</table>
</body></html>`;
}
