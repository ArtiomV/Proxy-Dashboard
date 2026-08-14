'use strict';
//
// src/routes/registration.js — B2C self-service auth (WP1, ТЗ 10.08).
//
//   POST /api/register              — email + пароль (bcrypt), consent, Turnstile, honeypot
//   POST /api/auth/telegram         — Telegram Login Widget (проверка подписи по токену бота)
//   POST /api/verify_email          — подтверждение адреса по токену из письма (24ч)
//   POST /api/forgot_password       — токен сброса на email (1ч, одноразовый)
//   POST /api/reset_password        — новый пароль по токену + kill сессий
//   POST /api/client/change_password — смена пароля из ЛК (ОБЩИЙ endpoint для всех клиентов)
//   POST /api/client/tg_link_code    — код привязки Telegram (ОБЩИЙ; B2C Э3, WP5)
//   POST /api/client/tg_unlink       — отвязка Telegram (ОБЩИЙ; B2C Э3, WP5)
//   GET  /api/public/auth_config     — публичный конфиг auth-форм (флаг розницы, site-key
//                                      Turnstile, username TG-бота для виджета). Без auth.
//
// Всё — за фича-флагом retail_enabled (register/auth/verify/forgot/reset).
// change_password доступен всем типам клиентов (новый функционал, Р37 ред. 2).
// Внутренний login = 'u_' + uid; portName = login (привязка портов строкой).

const express = require('express');
const bcrypt = require('bcrypt');
const crypto = require('crypto');

module.exports = function createRegistrationRouter(deps) {
  const {
    logger,
    validate, registerLimiter, RegisterSchema, ForgotPasswordSchema, ResetPasswordSchema,
    ChangePasswordSchema, TelegramAuthSchema,
    authMiddleware,
    getUsers,                // () => users map
    clients,                 // in-memory clients array
    saveClients, rebuildClientMaps,
    generateToken, generateId, createSession, deleteSessionsByLogin, getSessionTTL,
    getClientIp, auditLog, logActivity,
    getSetting,
    mailer, authTokensDb,
    db,
    tgBot,                   // B2C Э3 (WP5): getBotUsername для ссылки привязки
  } = deps;
  const r = express.Router();

  // ── helpers ─────────────────────────────────────────────────────────────
  function retailOn(res) {
    if (getSetting('retail_enabled', false)) return true;
    res.status(404).json({ error: 'Not found' });
    return false;
  }

  // OIDC state/nonce (Telegram Login, новый протокол взамен deprecated
  // oauth-embed): in-memory Map с TTL 10 мин — одноразовые, чистим лениво.
  const _oidcStates = new Map(); // state → { nonce, exp }
  function _oidcStateNew() {
    const now = Date.now();
    for (const [s, v] of _oidcStates) if (v.exp < now) _oidcStates.delete(s);
    const state = crypto.randomBytes(16).toString('hex');
    _oidcStates.set(state, { nonce: crypto.randomBytes(16).toString('hex'), exp: now + 10 * 60 * 1000 });
    return state;
  }
  function _oidcStateConsume(state) {
    const v = _oidcStates.get(String(state || ''));
    _oidcStates.delete(String(state || ''));
    return v && v.exp >= Date.now() ? v : null;
  }

  // Повторная отправка письма верификации: cooldown 5 мин на логин.
  const _resendCooldown = new Map(); // login → ts последней отправки
  const RESEND_COOLDOWN_MS = 5 * 60 * 1000;

  function _oidcCreds() {
    return {
      clientId: getSetting('telegram_oidc_client_id', '') || process.env.TELEGRAM_OIDC_CLIENT_ID || '',
      secret: getSetting('telegram_oidc_secret', '') || process.env.TELEGRAM_OIDC_CLIENT_SECRET || '',
    };
  }

  // JWKS oauth.telegram.org — кэш 1ч (ключи ротируются редко; промах по kid —
  // один принудительный рефреш).
  let _jwksCache = { at: 0, keys: [] };
  async function _oidcJwks(force) {
    if (!force && _jwksCache.keys.length && Date.now() - _jwksCache.at < 3600_000) return _jwksCache.keys;
    const resp = await globalThis.fetch('https://oauth.telegram.org/.well-known/jwks.json');
    if (!resp.ok) throw new Error('jwks fetch ' + resp.status);
    const data = await resp.json();
    _jwksCache = { at: Date.now(), keys: data.keys || [] };
    return _jwksCache.keys;
  }

  function _b64url(buf) { return Buffer.from(buf).toString('base64url'); }

  // Проверка id_token (JWT): подпись по JWKS + iss/aud/exp/nonce.
  async function _oidcVerifyIdToken(idToken, clientId, expectedNonce) {
    const parts = String(idToken || '').split('.');
    if (parts.length !== 3) throw new Error('bad jwt');
    const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    if (payload.iss !== 'https://oauth.telegram.org') throw new Error('bad iss');
    if (payload.aud !== clientId) throw new Error('bad aud');
    if (!payload.exp || payload.exp * 1000 < Date.now()) throw new Error('expired');
    if (expectedNonce && payload.nonce !== expectedNonce) throw new Error('bad nonce');
    let keys = await _oidcJwks(false);
    let jwk = keys.find(k => k.kid === header.kid);
    if (!jwk) { keys = await _oidcJwks(true); jwk = keys.find(k => k.kid === header.kid); }
    if (!jwk) throw new Error('no jwk for kid');
    const key = crypto.createPublicKey({ format: 'jwk', key: jwk });
    const algByName = { RS256: 'RSA-SHA256', ES256: 'SHA256', ES256K: 'SHA256', EdDSA: null };
    if (!(header.alg in algByName)) throw new Error('unsupported alg ' + header.alg);
    const sig = Buffer.from(parts[2], 'base64url');
    const data = Buffer.from(parts[0] + '.' + parts[1]);
    const ok = crypto.verify(algByName[header.alg], data, key, sig);
    if (!ok) throw new Error('bad signature');
    return payload;
  }

  // Общий find-or-create для TG-входа (Login Widget POST и OIDC callback).
  // profile: { id, first_name?, last_name?, username? }. Бросает {status, error}.
  //
  // ВАЖНО (066): OIDC sub — НЕ telegram user id (другой namespace, 18 цифр).
  // Поэтому для OIDC ищем по tg_oidc_sub; при промахе — по tg_username
  // (если Telegram отдал preferred_username) и прикрепляем sub к найденному
  // аккаунту — иначе вход через TG создавал дубль аккаунта у тех, кто
  // регистрировался по email и привязывал TG через бота.
  function _tgFindOrCreate(profile, req, oidcSub) {
    const tgId = String(profile.id);
    let client = null;
    if (oidcSub) {
      client = clients.find(c => c.tgOidcSub === String(oidcSub));
      if (!client && profile.username) {
        const un = String(profile.username).toLowerCase();
        const cand = clients.find(c => c.tgUsername && c.tgUsername.toLowerCase() === un);
        if (cand) {
          cand.tgOidcSub = String(oidcSub);
          saveClients(clients);
          auditLog(cand.login, 'tg_oidc_attached', { sub: String(oidcSub), via: 'username', ip: getClientIp(req) });
          client = cand;
        }
      }
    }
    if (!client) client = clients.find(c => c.tgChatId === tgId);
    let created = false;
    if (!client) {
      // WP7: лимит аккаунтов на reg_ip действует и на TG-путь (Э5).
      // Проверка только при СОЗДАНИИ — вход существующего клиента не режем.
      if (accountIpLimitHit(getClientIp(req))) {
        throw { status: 403, error: 'Не удалось создать аккаунт — попробуйте позже' };
      }
      // TG-созданный аккаунт: пароль задаётся позже в профиле, email — перед первой оплатой (54-ФЗ)
      const id = generateId();
      const login = 'u_' + id;
      client = {
        id, login,
        name: [profile.first_name, profile.last_name].filter(Boolean).join(' ') || (profile.username || tgId),
        portName: login,
        passwordHash: '',
        contact: profile.username ? ('@' + profile.username) : '',
        billingType: 'per_modem', price: 0, currency: 'RUB', balance: 0,
        apiKey: crypto.createHash('sha256').update('prx_' + crypto.randomBytes(24).toString('hex')).digest('hex'),
        apiKeyPrefix: '',
        referral_code: 'REF-' + crypto.randomBytes(4).toString('hex').toUpperCase(),
        referred_by: null, referral_balance: 0, resetToken: '',
        clientType: 'individual', allowDebt: false,
        tgChatId: oidcSub ? '' : tgId,          // legacy widget: user id; OIDC: отдельно
        tgOidcSub: oidcSub ? String(oidcSub) : '',
        tgUsername: profile.username || '',
        regIp: getClientIp(req),
        consentPdAt: new Date().toISOString(),  // согласие — чекбоксом на форме перед виджетом
        createdAt: new Date().toISOString(),
      };
      clients.push(client);
      try {
        saveClients(clients);
      } catch (e) {
        clients.pop();
        if (e && (e.code === 'SQLITE_CONSTRAINT_UNIQUE' || /UNIQUE constraint/i.test(e.message || ''))) {
          throw { status: 409, error: 'Этот Telegram-аккаунт уже привязан' };
        }
        throw e;
      }
      rebuildClientMaps();
      getUsers()[login] = { passwordHash: '', portNameFilter: login, source: 'client', clientId: id };
      created = true;
      auditLog(login, 'retail_register_tg', { tg: tgId, ip: getClientIp(req) });
      logActivity('client', 'info', 'retail_register', client.name, `Регистрация через Telegram (${tgId})`, {});
      // B2C Э3 (WP5): админ-алерт розницы — регистрация через TG.
      try { deps.alerts && deps.alerts.trigger('retail_registered', { login, email: client.email || null, via: 'telegram', tg: tgId }); } catch (_) {}
    } else if (profile.username && client.tgUsername !== profile.username) {
      client.tgUsername = profile.username; // username мог смениться — освежаем
      saveClients(clients);
    }
    if (client.blocked) {
      deleteSessionsByLogin(client.login);
      throw { status: 403, error: 'Аккаунт заблокирован' };
    }
    return { client, created };
  }


  // Turnstile: если secret не задан — проверка пропускается (dev/ранний запуск),
  // но honeypot + limiter остаются. Задан — токен обязателен и проверяется.
  async function verifyTurnstile(token, ip) {
    const secret = getSetting('turnstile_secret_key', '');
    if (!secret) return true;
    if (!token) return false;
    try {
      const resp = await globalThis.fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `secret=${encodeURIComponent(secret)}&response=${encodeURIComponent(token)}&remoteip=${encodeURIComponent(ip || '')}`,
      });
      const data = await resp.json();
      return !!data.success;
    } catch (e) {
      logger.warn('[Turnstile] siteverify failed: ' + e.message);
      return false; // strict: без ответа Cloudflare публичную форму не пропускаем
    }
  }

  function createClientSession(res, req, client) {
    const token = generateToken();
    createSession(token, client.login, client.portName, false, Date.now() + getSessionTTL());
    const ttlSec = Math.round(getSessionTTL() / 1000);
    const secureFlag = req.secure || (req.headers['x-forwarded-proto'] === 'https') ? '; Secure' : '';
    res.setHeader('Set-Cookie', `pr_session=${encodeURIComponent(token)}; Path=/; Max-Age=${ttlSec}; HttpOnly; SameSite=Strict${secureFlag}`);
    return token;
  }

  function publicClient(c) {
    return { login: c.login, email: c.email, name: c.name, emailVerified: !!c.emailVerified };
  }

  // Анти-мультиаккаунт: регистраций с одного IP в сутки — не более настройки.
  function regIpLimitHit(ip) {
    const limit = getSetting('retail_reg_limit_per_ip_day', 10);
    if (!ip || !limit) return false;
    const row = db.prepare(
      "SELECT COUNT(*) AS cnt FROM clients WHERE reg_ip = ? AND created_at > datetime('now', '-1 day')"
    ).get(ip);
    return (row ? row.cnt : 0) >= limit;
  }

  // Анти-мультиаккаунт (WP7, Э5): ВСЕГО аккаунтов с одного reg_ip — не более
  // retail_max_accounts_per_ip (дефолт 2; 0 = выкл). B2B/админ-созданные
  // клиенты без reg_ip не считаются (reg_ip NULL не матчится).
  function accountIpLimitHit(ip) {
    const limit = Number(getSetting('retail_max_accounts_per_ip', 2));
    if (!ip || !limit) return false;
    const row = db.prepare('SELECT COUNT(*) AS cnt FROM clients WHERE reg_ip = ?').get(ip);
    const count = row ? row.cnt : 0;
    if (count < limit) return false;
    // Отказ — с нейтральным текстом (не раскрываем причину ботам), админу — алерт
    // (дедуп по IP с cooldown внутри alerts.js) + след в аудите.
    auditLog('system', 'retail_multiaccount_ip', { ip, count, limit });
    try { deps.alerts && deps.alerts.trigger('retail_multiaccount_ip', { ip, count, limit }); } catch (_) { /* alert best-effort */ }
    return true;
  }

  // ── Публичный конфиг auth-форм (без auth): фронт прячет/показывает
  // регистрацию, Turnstile и TG-виджет по этим полям. НЕ 404 при выключенной
  // рознице — страницы login/register должны отличать «флаг выкл» от «нет роута».
  r.get('/api/public/auth_config', (req, res) => {
    if (!getSetting('retail_enabled', false)) {
      return res.json({ retail_enabled: false, turnstile_site_key: '', telegram_bot_username: '', telegram_oidc_enabled: false });
    }
    res.json({
      retail_enabled: true,
      turnstile_site_key: getSetting('turnstile_site_key', ''),
      telegram_bot_username: getSetting('telegram_bot_username', ''), // нет в SETTINGS_DEFAULTS — default ''
      telegram_oidc_enabled: !!_oidcCreds().clientId, // OIDC Login взамен deprecated embed-виджета
    });
  });

  // ── А. Регистрация (email + пароль) ─────────────────────────────────────
  r.post('/api/register', registerLimiter, validate(RegisterSchema), async (req, res) => {
    if (!retailOn(res)) return;
    const { email, password, ref, turnstile } = req.body;
    const ip = getClientIp(req);

    // Honeypot: невидимое поле «website» заполняют только боты — молча «успех».
    if (req.body.website) return res.json({ ok: true });
    if (!(await verifyTurnstile(turnstile, ip))) {
      return res.status(403).json({ error: 'Проверка «я не робот» не пройдена' });
    }
    if (regIpLimitHit(ip)) {
      auditLog('system', 'retail_reg_ip_limit', { ip });
      return res.status(429).json({ error: 'Слишком много регистраций с вашего IP — попробуйте завтра' });
    }
    // WP7: жёсткий лимит аккаунтов на reg_ip (мультиаккаунт-контур, Э5)
    if (accountIpLimitHit(ip)) {
      return res.status(403).json({ error: 'Не удалось создать аккаунт — попробуйте позже' });
    }

    const normEmail = String(email).trim().toLowerCase();
    if (clients.find(c => c.email && c.email.toLowerCase() === normEmail)) {
      return res.status(409).json({ error: 'Аккаунт с этим email уже существует' });
    }

    const id = generateId();
    const login = 'u_' + id;
    const passwordHash = await bcrypt.hash(password, 10);
    const client = {
      id, login,
      name: normEmail.split('@')[0],
      portName: login,               // привязка портов строкой (ТЗ: portName = login)
      passwordHash,
      contact: normEmail,
      billingType: 'per_modem',
      price: 0,                      // биллинг пропускает до покупки (billing.js:112)
      currency: 'RUB',
      balance: 0,
      apiKey: crypto.createHash('sha256').update('prx_' + crypto.randomBytes(24).toString('hex')).digest('hex'),
      apiKeyPrefix: '',   // plaintext нигде не сохраняется; клиент перевыпускает ключ из ЛК
      referral_code: 'REF-' + crypto.randomBytes(4).toString('hex').toUpperCase(),
      referred_by: null, referral_balance: 0,
      resetToken: '',
      clientType: 'individual',
      allowDebt: false,              // Р24: розница предоплатная, allow_debt = 0 принудительно
      email: normEmail, emailVerified: false,
      consentPdAt: new Date().toISOString(),   // consent обязателен (zod literal true)
      regIp: ip,
      createdAt: new Date().toISOString(),
    };
    // ?ref=CODE → referred_by автоматически (раньше — только админом)
    if (ref) {
      const referrer = clients.find(c => c.referral_code === ref);
      if (referrer) client.referred_by = referrer.id;
    }

    clients.push(client);
    try {
      saveClients(clients);
    } catch (e) {
      clients.pop();
      if (e && (e.code === 'SQLITE_CONSTRAINT_UNIQUE' || /UNIQUE constraint/i.test(e.message || ''))) {
        return res.status(409).json({ error: 'Аккаунт с этим email уже существует' });
      }
      throw e;
    }
    rebuildClientMaps();
    getUsers()[login] = { passwordHash, portNameFilter: login, source: 'client', clientId: id };

    // Письмо верификации (SendPulse; без кредов — в mail_outbox, токен достаёт админ)
    const verifyToken = authTokensDb.issue(login, 'verify_email');
    const base = (req.headers['x-forwarded-proto'] || req.protocol) + '://' + req.headers.host;
    mailer.send({
      to: normEmail, kind: 'verify_email',
      subject: 'Подтвердите email — Arendaproxy',
      text: `Подтвердите адрес: ${base}/verify?token=${verifyToken}\nСсылка действует 24 часа.`,
    }).catch(e => logger.warn('[Register] verify email send failed: ' + e.message));

    auditLog(login, 'retail_register', { ip, email: normEmail, ref: ref || null });
    // B2C Э3 (WP5): админ-алерт розницы «новая регистрация» (правило alerts.js).
    try { deps.alerts && deps.alerts.trigger('retail_registered', { login, email: normEmail, via: 'email', ip }); } catch (_) {}
    logActivity('client', 'info', 'retail_register', normEmail, `Новая розничная регистрация ${normEmail}`, { ip });

    const token = createClientSession(res, req, client);
    res.json({ ok: true, token, login, client: publicClient(client) });
  });

  // ── Б. Telegram Login Widget ─────────────────────────────────────────────
  r.post('/api/auth/telegram', validate(TelegramAuthSchema), async (req, res) => {
    if (!retailOn(res)) return;
    // Подпись: hash = HMAC_SHA256(data-check-string, sha256(bot_token)).
    // Токен существующего единого бота — в настройках (kv enc1:, D1).
    const botToken = getSetting('telegram_bot_token', '');
    if (!botToken) return res.status(503).json({ error: 'Telegram-вход не настроен' });
    const p = req.body;
    // data-check-string: все поля кроме hash, отсортированные, key=value через \n
    const checkString = Object.keys(p).filter(k => k !== 'hash' && p[k] !== undefined)
      .sort().map(k => `${k}=${p[k]}`).join('\n');
    const secret = crypto.createHash('sha256').update(botToken).digest();
    const expected = crypto.createHmac('sha256', secret).update(checkString).digest('hex');
    if (expected !== p.hash) return res.status(401).json({ error: 'Неверная подпись Telegram' });
    if (Math.abs(Math.floor(Date.now() / 1000) - p.auth_date) > 86400) {
      return res.status(401).json({ error: 'Данные Telegram устарели — повторите вход' });
    }

    let result;
    try {
      result = _tgFindOrCreate(p, req);
    } catch (err) {
      if (err && err.status) return res.status(err.status).json({ error: err.error });
      throw err;
    }
    const token = createClientSession(res, req, result.client);
    res.json({ ok: true, token, login: result.client.login, client: publicClient(result.client) });
  });

  // ── Б2. Telegram OIDC Login (замена deprecated oauth-embed виджета) ──────
  // Telegram перевёл Login Widget на OpenID Connect: oauth.telegram.org/auth
  // на старый embed-поток отвечает просто «deprecated». Здесь — code flow:
  //   GET /api/auth/telegram_oidc_start → 302 на oauth.telegram.org/auth
  //   GET /api/auth/telegram_oidc       → callback: code → id_token (JWKS) →
  //     find-or-create клиента → сессия (cookie) → редирект на /tg-auth,
  //     где JS забирает токен из /api/auth/session_token в localStorage.
  // Креды: telegram_oidc_client_id / telegram_oidc_secret (настройки; fallback —
  // env TELEGRAM_OIDC_CLIENT_ID/SECRET). Redirect URL для BotFather:
  // https://app.arendaproxy.ru/api/auth/telegram_oidc
  r.get('/api/auth/telegram_oidc_start', (req, res) => {
    if (!retailOn(res)) return;
    const { clientId } = _oidcCreds();
    if (!clientId) return res.status(503).send('Telegram-вход не настроен');
    const state = _oidcStateNew();
    const base = (req.headers['x-forwarded-proto'] || req.protocol) + '://' + req.headers.host;
    const url = 'https://oauth.telegram.org/auth'
      + '?client_id=' + encodeURIComponent(clientId)
      + '&response_type=code'
      + '&scope=' + encodeURIComponent('openid profile')
      + '&redirect_uri=' + encodeURIComponent(base + '/api/auth/telegram_oidc')
      + '&state=' + encodeURIComponent(state)
      + '&nonce=' + encodeURIComponent(_oidcStates.get(state).nonce);
    res.redirect(url);
  });

  r.get('/api/auth/telegram_oidc', async (req, res) => {
    if (!retailOn(res)) return;
    const fail = (msg) => res.redirect('/tg-auth?error=' + encodeURIComponent(msg));
    try {
      if (req.query.error) return fail('Вход отменён или отклонён Telegram');
      const st = _oidcStateConsume(req.query.state);
      if (!st) return fail('Сессия входа устарела — попробуйте ещё раз');
      const { clientId, secret } = _oidcCreds();
      if (!clientId || !secret) return fail('Telegram-вход не настроен');
      const base = (req.headers['x-forwarded-proto'] || req.protocol) + '://' + req.headers.host;
      const tokenResp = await globalThis.fetch('https://oauth.telegram.org/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: clientId,
          client_secret: secret,
          code: String(req.query.code || ''),
          redirect_uri: base + '/api/auth/telegram_oidc',
        }).toString(),
      });
      const tokenData = await tokenResp.json().catch(() => ({}));
      if (!tokenResp.ok || !tokenData.id_token) {
        logger.warn('[TG-OIDC] token exchange failed: ' + tokenResp.status + ' ' + JSON.stringify(tokenData).slice(0, 200));
        return fail('Не удалось подтвердить вход — попробуйте ещё раз');
      }
      const claims = await _oidcVerifyIdToken(tokenData.id_token, clientId, st.nonce);
      const result = _tgFindOrCreate({
        id: claims.sub,
        first_name: claims.name || '',
        username: claims.preferred_username || '',
      }, req, claims.sub);
      createClientSession(res, req, result.client);
      res.redirect('/tg-auth');
    } catch (e) {
      if (e && e.status) return fail(e.error);
      logger.warn('[TG-OIDC] callback failed: ' + e.message);
      fail('Ошибка входа через Telegram — попробуйте ещё раз');
    }
  });

  // Токен текущей сессии — для /tg-auth после OIDC-редиректа: cookie httpOnly,
  // фронту нужен raw-токен в localStorage (основной транспорт — X-Auth-Token).
  r.get('/api/auth/session_token', authMiddleware, (req, res) => {
    let token = req.headers['x-auth-token'] || '';
    if (!token) {
      const m = (req.headers['cookie'] || '').match(/(?:^|;\s*)pr_session=([^;]+)/);
      token = m ? decodeURIComponent(m[1]) : '';
    }
    const client = clients.find(c => c.login === req.user.login);
    res.json({ ok: true, token, login: req.user.login, client: client ? publicClient(client) : null });
  });

  // ── Повторная отправка письма верификации (кулдаун 5 мин на аккаунт) ─────
  r.post('/api/auth/resend_verification', authMiddleware, (req, res) => {
    if (!retailOn(res)) return;
    const client = clients.find(c => c.login === req.user.login);
    if (!client) return res.status(404).json({ error: 'Аккаунт не найден' });
    if (!client.email) return res.status(400).json({ error: 'Email не указан — добавьте его в профиле' });
    if (client.emailVerified) return res.status(400).json({ error: 'Email уже подтверждён' });
    const last = _resendCooldown.get(client.login) || 0;
    if (Date.now() - last < RESEND_COOLDOWN_MS) {
      const waitMin = Math.ceil((RESEND_COOLDOWN_MS - (Date.now() - last)) / 60000);
      return res.status(429).json({ error: `Письмо уже отправлено — повторить можно через ${waitMin} мин` });
    }
    _resendCooldown.set(client.login, Date.now());
    const verifyToken = authTokensDb.issue(client.login, 'verify_email');
    const base = (req.headers['x-forwarded-proto'] || req.protocol) + '://' + req.headers.host;
    mailer.send({
      to: client.email, kind: 'verify_email',
      subject: 'Подтвердите email — Arendaproxy',
      text: `Подтвердите адрес: ${base}/verify?token=${verifyToken}\nСсылка действует 24 часа.`,
    }).catch(e => logger.warn('[Resend] verify email send failed: ' + e.message));
    auditLog(client.login, 'verify_email_resent', { ip: getClientIp(req) });
    res.json({ ok: true, message: 'Письмо отправлено — проверьте почту (и папку «Спам»)' });
  });

  // ── Верификация email ───────────────────────────────────────────────────
  r.post('/api/verify_email', (req, res) => {
    if (!retailOn(res)) return;
    const hit = authTokensDb.consume(req.body && req.body.token, 'verify_email');
    if (!hit) return res.status(400).json({ error: 'Ссылка недействительна или устарела' });
    const client = clients.find(c => c.login === hit.login);
    if (!client) return res.status(404).json({ error: 'Аккаунт не найден' });
    client.emailVerified = true;
    saveClients(clients);
    auditLog(client.login, 'email_verified', {});
    res.json({ ok: true });
  });

  // ── Г. Сброс пароля ─────────────────────────────────────────────────────
  r.post('/api/forgot_password', registerLimiter, validate(ForgotPasswordSchema), async (req, res) => {
    if (!retailOn(res)) return;
    const ip = getClientIp(req);
    if (!(await verifyTurnstile(req.body.turnstile, ip))) {
      return res.status(403).json({ error: 'Проверка «я не робот» не пройдена' });
    }
    // Ответ одинаковый независимо от наличия аккаунта — не раскрываем базу email.
    const normEmail = String(req.body.email).trim().toLowerCase();
    const client = clients.find(c => c.email && c.email.toLowerCase() === normEmail);
    if (client) {
      const token = authTokensDb.issue(client.login, 'reset_password');
      const base = (req.headers['x-forwarded-proto'] || req.protocol) + '://' + req.headers.host;
      mailer.send({
        to: normEmail, kind: 'reset_password',
        subject: 'Сброс пароля — Arendaproxy',
        text: `Сброс пароля: ${base}/reset?token=${token}\nСсылка действует 1 час. Если это были не вы — игнорируйте письмо.`,
      }).catch(e => logger.warn('[Forgot] reset email send failed: ' + e.message));
      auditLog(client.login, 'password_reset_requested', { ip });
    }
    res.json({ ok: true, message: 'Если аккаунт существует — письмо отправлено' });
  });

  r.post('/api/reset_password', validate(ResetPasswordSchema), async (req, res) => {
    if (!retailOn(res)) return;
    const hit = authTokensDb.consume(req.body.token, 'reset_password');
    if (!hit) return res.status(400).json({ error: 'Ссылка недействительна или устарела' });
    const client = clients.find(c => c.login === hit.login);
    if (!client) return res.status(404).json({ error: 'Аккаунт не найден' });
    const passwordHash = await bcrypt.hash(req.body.password, 10);
    client.passwordHash = passwordHash;
    const users = getUsers();
    if (users[client.login]) users[client.login].passwordHash = passwordHash;
    saveClients(clients);
    deleteSessionsByLogin(client.login); // перелогин после сброса
    auditLog(client.login, 'password_reset_done', { ip: getClientIp(req) });
    res.json({ ok: true });
  });

  // ── В. Смена пароля из ЛК — ОБЩИЙ endpoint для всех типов клиентов ──────
  // (Р37 ред. 2: функционал отсутствовал у всех, включая B2B.)
  r.post('/api/client/change_password', authMiddleware, validate(ChangePasswordSchema), async (req, res) => {
    const login = req.user.login;
    const users = getUsers();
    const user = users[login];
    if (!user || !user.passwordHash) {
      return res.status(400).json({ error: 'Пароль не задан — используйте сброс по email' });
    }
    const ok = await bcrypt.compare(req.body.old, user.passwordHash);
    if (!ok) return res.status(403).json({ error: 'Текущий пароль неверен' });
    const passwordHash = await bcrypt.hash(req.body.new, 10);
    user.passwordHash = passwordHash;
    const client = clients.find(c => c.login === login);
    if (client) { client.passwordHash = passwordHash; saveClients(clients); }
    deleteSessionsByLogin(login); // перелогин на всех устройствах
    auditLog(login, 'password_changed', { ip: getClientIp(req) });
    res.json({ ok: true, relogin: true });
  });

  // ── B2C Э3 (WP5): привязка Telegram из ЛК — ОБЩИЕ endpoints (НЕ за
  // retail-флагом): привязка нужна и B2B-клиентам для уведомлений. У клиентов
  // без tg_chat_id ничего не меняется.
  //
  // Код — одноразовый auth_token типа tg_link (TTL 15 мин, authTokensDb);
  // бот гасит его на /start link_<code> (src/telegram/bot.js).
  r.post('/api/client/tg_link_code', authMiddleware, async (req, res) => {
    const client = clients.find(c => c.login === req.user.login);
    if (!client) return res.status(404).json({ error: 'Client not found' });
    if (client.tgChatId) {
      return res.status(409).json({ error: 'Telegram уже привязан — сначала отвяжите', code: 'TG_ALREADY_LINKED' });
    }
    // Username бота: getMe с кэшем в kv; fallback — настройка telegram_bot_username.
    let username = '';
    try { username = tgBot && await tgBot.getBotUsername() || ''; } catch (e) {
      logger.warn('[TgLink] getBotUsername failed: ' + e.message);
    }
    if (!username) return res.status(503).json({ error: 'Telegram-бот не настроен', code: 'TG_BOT_NOT_CONFIGURED' });
    const code = authTokensDb.issue(client.login, 'tg_link');
    const ttlMin = Math.round((authTokensDb.TTL_MS.tg_link || 900000) / 60000);
    auditLog(client.login, 'tg_link_code_issued', { ip: getClientIp(req) });
    res.json({ ok: true, code, url: `https://t.me/${username}?start=link_${code}`, ttlMin });
  });

  r.post('/api/client/tg_unlink', authMiddleware, (req, res) => {
    const client = clients.find(c => c.login === req.user.login);
    if (!client) return res.status(404).json({ error: 'Client not found' });
    if (!client.tgChatId) return res.json({ ok: true });   // идемпотентно
    const oldTg = client.tgChatId;
    client.tgChatId = null;
    client.tgUsername = null;
    saveClients(clients);
    auditLog(client.login, 'tg_unlinked', { tg: oldTg, ip: getClientIp(req) });
    res.json({ ok: true });
  });

  return r;
};
