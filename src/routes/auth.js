'use strict';
//
// src/routes/auth.js — login / logout / impersonate (Stage 3).
//
// All three need to read/write the in-memory `users` map + create session
// rows. Auth middleware is supplied externally because it's used by every
// other router too and lives in server.js for now.

const express = require('express');
const bcrypt = require('bcrypt');

module.exports = function createAuthRouter(deps) {
  const {
    logger,
    loginLimiter, validate, LoginSchema, authMiddleware, adminMiddleware,
    getUsers,             // () => users map (let-rebound in server.js, use getter)
    getClientById,        // (id) => client object (clientById Map .get)
    getClientByEmail,     // (email) => client object | undefined (B2C: вход по email)
    generateToken,
    createSession, deleteSession, deleteSessionsByLogin,
    getSessionTTL,
    _readSessionToken,
    auditLog,
    getClientIp,
  } = deps;
  const r = express.Router();

  r.post('/api/login', loginLimiter, validate(LoginSchema), async (req, res) => {
    let { login, password } = req.body;
    if (!login || !password) return res.status(400).json({ error: 'Login and password required' });
    // B2C (WP1): логин содержит '@' → lookup email→login. B2B-путь не меняется.
    if (login.indexOf('@') !== -1 && getClientByEmail) {
      const byEmail = getClientByEmail(String(login).trim().toLowerCase());
      if (byEmail) login = byEmail.login;
    }
    const users = getUsers();
    const user = users[login];
    if (!user) return res.status(401).json({ error: 'Invalid login or password' });

    // B2C (WP1): blocked=1 → 403 + kill сессий (проверка ДО пароля — заблокированному
    // не сообщаем, верен ли пароль: 403 одинаков для любого пароля заблокированного).
    const authClient = getClientById && user.clientId ? getClientById(user.clientId) : null;
    if (authClient && authClient.blocked) {
      deleteSessionsByLogin(login);
      return res.status(403).json({ error: 'Аккаунт заблокирован' });
    }

    // All users must have a bcrypt password_hash. Plaintext fallback removed —
    // all 8 prod clients have been migrated. Refuse login if hash missing.
    if (!user.passwordHash) {
      logger.error(`[Login] User ${login} has no password_hash — auto-migration must run before they can log in`);
      return res.status(401).json({ error: 'Invalid login or password' });
    }
    // 2026-09-18 · DEEP-27: фиксируем версию аутентификации ДО compare.
    // Пока идёт bcrypt.compare со старым хэшем, reset/change может durable-сменить
    // пароль и отозвать сессии — тогда этот успешный compare по СТАРОМУ паролю
    // не должен выдать новую сессию: версия уже другая.
    const authVersionBefore = authClient ? (authClient.authVersion || 0) : null;
    const passwordValid = await bcrypt.compare(password, user.passwordHash);
    if (!passwordValid) return res.status(401).json({ error: 'Invalid login or password' });
    if (authClient && (authClient.authVersion || 0) !== authVersionBefore) {
      auditLog(login, 'client_login_stale_auth_version', { ip: getClientIp(req) });
      return res.status(401).json({ error: 'Invalid login or password' });
    }
    const token = generateToken();
    const isAdmin = user.portNameFilter === '*';
    createSession(token, login, user.portNameFilter, isAdmin, Date.now() + getSessionTTL());
    // Log client logins (not admin)
    if (!isAdmin) {
      auditLog(login, 'client_login', { ip: getClientIp(req), portNameFilter: user.portNameFilter });
    }
    // Set httpOnly cookie alongside the body token. The body token is kept for
    // backwards-compat with the current frontend (which still uses localStorage);
    // new clients can ignore the body and rely on the cookie.
    const ttlSec = Math.round(getSessionTTL() / 1000);
    const secureFlag = req.secure || (req.headers['x-forwarded-proto'] === 'https') ? '; Secure' : '';
    res.setHeader('Set-Cookie', `pr_session=${encodeURIComponent(token)}; Path=/; Max-Age=${ttlSec}; HttpOnly; SameSite=Strict${secureFlag}`);
    res.json({ token, login, isAdmin });
  });

  r.post('/api/logout', (req, res) => {
    const token = _readSessionToken(req);
    deleteSession(token);
    res.setHeader('Set-Cookie', 'pr_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict');
    res.json({ ok: true });
  });

  // Admin: impersonate client (create session as client)
  r.post('/api/admin/impersonate/:id', authMiddleware, adminMiddleware, (req, res) => {
    const client = getClientById(req.params.id);
    if (!client) return res.status(404).json({ error: 'Client not found' });
    const users = getUsers();
    // 2026-10-15: в users попадают только клиенты с паролем (env/пароль в карточке),
    // а розничные клиенты, зарегистрированные через Telegram, пароля не имеют —
    // «Client user not found» при входе в кабинет moonwalk. Привязка портов — из карточки.
    const user = users[client.login] || (client.portName ? { portNameFilter: client.portName } : null);
    if (!user) return res.status(400).json({ error: 'У клиента нет привязки портов (portName) — войти в кабинет нельзя' });
    const token = generateToken();
    // Short TTL: the token travels via URL (?impersonate=…) into the client
    // portal, so it can land in nginx access logs / browser history. A 2-hour
    // window bounds that exposure (a normal session is 30 days).
    const IMPERSONATE_TTL_MS = 2 * 3600 * 1000;
    createSession(token, client.login, user.portNameFilter, false, Date.now() + IMPERSONATE_TTL_MS);
    // Security-sensitive action — always audit who viewed whom.
    auditLog(req.user.login, 'impersonate', { client_id: client.id, client_login: client.login, ip: getClientIp(req) });
    res.json({ ok: true, token, login: client.login });
  });

  return r;
};
