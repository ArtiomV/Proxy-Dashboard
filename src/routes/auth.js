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
    generateToken,
    createSession, deleteSession,
    getSessionTTL,
    _readSessionToken,
    auditLog,
    getClientIp,
  } = deps;
  const r = express.Router();

  r.post('/api/login', loginLimiter, validate(LoginSchema), async (req, res) => {
    const { login, password } = req.body;
    if (!login || !password) return res.status(400).json({ error: 'Login and password required' });
    const users = getUsers();
    const user = users[login];
    if (!user) return res.status(401).json({ error: 'Invalid login or password' });

    // All users must have a bcrypt password_hash. Plaintext fallback removed —
    // all 8 prod clients have been migrated. Refuse login if hash missing.
    if (!user.passwordHash) {
      logger.error(`[Login] User ${login} has no password_hash — auto-migration must run before they can log in`);
      return res.status(401).json({ error: 'Invalid login or password' });
    }
    const passwordValid = await bcrypt.compare(password, user.passwordHash);
    if (!passwordValid) return res.status(401).json({ error: 'Invalid login or password' });
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
    const user = users[client.login];
    if (!user) return res.status(400).json({ error: 'Client user not found' });
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
