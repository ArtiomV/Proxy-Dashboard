'use strict';
// src/services/cred-check.js — проверка кредов при сохранении настроек
// (PUT /api/admin/settings). Запрос пользователя 15.08: «все креды должны
// проверяться при сохранении» — чтобы 535 SendPulse не всплывал через сутки
// в mail_outbox, а сразу при записи.
//
// Семантика результата:
//   ok      — креды валидны (live-проверка прошла);
//   fatal   — точно невалидны (auth-ответ сервиса: 535/401/истёкший JWT)
//             → роут ОТКЛОНЯЕТ сохранение (400), настройки не пишутся;
//   warning — проверка не состоялась по сетевым причинам (таймаут, DNS,
//             5xx у сервиса) → настройки сохраняются, warning уходит в ответ
//             и показывается в UI. Блокировать сохранение из-за чужого
//             даунтайма нельзя.
//
// Что проверяем:
//   sendpulse_smtp_user/pass — nodemailer verify() на smtp-pulse.com:587;
//   telegram_bot_token       — api.telegram.org getMe;
//   anthropic_api_key        — GET /v1/models (бесплатный, не тратит токены);
//   tochka_acq_jwt           — офлайн: структура JWT + exp (сеть Точки не нужна,
//                              истёкший токен детерминированно невалиден).
// Не проверяем live (невозможно без полного флоу): telegram_oidc_secret,
// turnstile_secret_key (siteverify требует пользовательский токен), crm_db_url
// (формат уже валидируется в роуте).
//
// NODE_ENV=test: сеть заблокирована (как в fx.js) — network-чекеры
// возвращают { skipped: true }. Юнит-тесты используют createChecker() с
// инжектированными фейками.

let _nodemailer = null;
try { _nodemailer = require('nodemailer'); } catch (_) { /* optional dep */ }

const IS_TEST = process.env.NODE_ENV === 'test';
const FETCH_TIMEOUT_MS = 8000;

function _fetch(url, opts) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  return globalThis.fetch(url, { ...opts, signal: ac.signal })
    .finally(() => clearTimeout(t));
}

// --- отдельные чекеры: → Promise<{ok, fatal?, error?, label?, skipped?}> ---

async function checkSmtp(user, pass) {
  if (!user || !pass) {
    return { ok: false, fatal: true, error: 'SendPulse SMTP: нужны оба поля — логин и пароль' };
  }
  if (IS_TEST) return { ok: true, skipped: true };
  if (!_nodemailer) return { ok: false, fatal: false, error: 'SendPulse SMTP: nodemailer не установлен, проверка пропущена' };
  try {
    const t = _nodemailer.createTransport({
      host: 'smtp-pulse.com', port: 587, secure: false,
      auth: { user, pass }, connectionTimeout: FETCH_TIMEOUT_MS,
    });
    await t.verify();
    return { ok: true, label: 'SendPulse SMTP — логин/пароль приняты' };
  } catch (e) {
    const auth = e.responseCode === 535 || /535|EAUTH|Invalid login|authentication failed/i.test(e.message || '');
    return { ok: false, fatal: auth, error: 'SendPulse SMTP: ' + (e.message || 'ошибка проверки') };
  }
}

async function checkTelegramBot(token) {
  if (IS_TEST) return { ok: true, skipped: true };
  try {
    const res = await _fetch(`https://api.telegram.org/bot${token}/getMe`);
    const j = await res.json().catch(() => null);
    if (j && j.ok) return { ok: true, label: `Telegram-бот @${j.result.username} — токен валиден` };
    const fatal = res.status === 401 || res.status === 404;
    return { ok: false, fatal, error: 'Telegram-бот: ' + ((j && j.description) || `HTTP ${res.status}`) };
  } catch (e) {
    return { ok: false, fatal: false, error: 'Telegram-бот: нет связи с api.telegram.org (' + e.message + ')' };
  }
}

async function checkAnthropic(key) {
  if (IS_TEST) return { ok: true, skipped: true };
  try {
    const res = await _fetch('https://api.anthropic.com/v1/models', {
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    });
    if (res.ok) return { ok: true, label: 'Anthropic API — ключ валиден' };
    const fatal = res.status === 401;
    return { ok: false, fatal, error: `Anthropic API: HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, fatal: false, error: 'Anthropic API: нет связи (' + e.message + ')' };
  }
}

// Офлайн: структура + срок годности. Сеть Точки не дёргаем — истёкший JWT
// невалиден детерминированно, а живой проверяется каждым платежом.
function checkTochkaJwt(jwt) {
  const parts = String(jwt).split('.');
  if (parts.length !== 3) return { ok: false, fatal: true, error: 'Точка эквайринг: это не JWT (нет 3 частей)' };
  let payload = null;
  try {
    payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch (_) {
    return { ok: false, fatal: true, error: 'Точка эквайринг: payload JWT не декодируется' };
  }
  if (payload.exp && payload.exp * 1000 < Date.now()) {
    return { ok: false, fatal: true, error: 'Точка эквайринг: JWT истёк ' + new Date(payload.exp * 1000).toLocaleString('ru-RU') };
  }
  return { ok: true, label: 'Точка эквайринг: JWT валиден' + (payload.exp ? ` до ${new Date(payload.exp * 1000).toLocaleDateString('ru-RU')}` : ' (без exp)') };
}

// --- агрегатор для PUT /api/admin/settings ---
// patch — уже собранный объект изменений; getSetting — для добора парных
// кредов (меняем только pass → user берём из текущих настроек).
// Возвращает { errors, warnings, checks } — все три массива строк.
async function validateSettingsPatch(patch, { getSetting }) {
  const tasks = [];
  const has = (k) => Object.prototype.hasOwnProperty.call(patch, k);

  if (has('sendpulse_smtp_user') || has('sendpulse_smtp_pass')) {
    const user = has('sendpulse_smtp_user') ? patch.sendpulse_smtp_user : getSetting('sendpulse_smtp_user', '');
    const pass = has('sendpulse_smtp_pass') ? patch.sendpulse_smtp_pass : getSetting('sendpulse_smtp_pass', '');
    // Очистка обоих полей — легальна, проверять нечего.
    if (user || pass) tasks.push(checkSmtp(user, pass));
  }
  if (has('telegram_bot_token') && patch.telegram_bot_token) {
    tasks.push(checkTelegramBot(patch.telegram_bot_token));
  }
  if (has('anthropic_api_key') && patch.anthropic_api_key) {
    tasks.push(checkAnthropic(patch.anthropic_api_key));
  }
  if (has('tochka_acq_jwt') && patch.tochka_acq_jwt) {
    tasks.push(Promise.resolve(checkTochkaJwt(patch.tochka_acq_jwt)));
  }

  const results = await Promise.all(tasks);
  const errors = [], warnings = [], checks = [];
  for (const r of results) {
    if (r.ok) { if (!r.skipped) checks.push(r.label || 'ok'); }
    else if (r.fatal) errors.push(r.error);
    else warnings.push(r.error);
  }
  return { errors, warnings, checks };
}

module.exports = { validateSettingsPatch, checkSmtp, checkTelegramBot, checkAnthropic, checkTochkaJwt };
