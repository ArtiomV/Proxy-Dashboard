'use strict';
// src/db/auth-tokens.js — repository for the `auth_tokens` table (WP1).
//
// Одноразовые токены email-потоков: verify_email (TTL 24ч) и reset_password
// (TTL 1ч). Токен хранится как sha256 — plaintext уходит только в письмо.
// used=1 после успешного consume; просроченные чистятся лениво при consume.

const crypto = require('crypto');
const { sha256hex } = require('../utils/secrets');

let S = {};

function init(db) {
  S.byToken = db.prepare('SELECT * FROM auth_tokens WHERE token = ?');
  S.insert = db.prepare(
    'INSERT INTO auth_tokens (login, type, token, expires_at, used) VALUES (?, ?, ?, ?, 0)'
  );
  S.markUsed = db.prepare('UPDATE auth_tokens SET used = 1 WHERE id = ? AND used = 0');
  S.invalidateForLogin = db.prepare('UPDATE auth_tokens SET used = 1 WHERE login = ? AND type = ? AND used = 0');
  S.prune = db.prepare("DELETE FROM auth_tokens WHERE expires_at < datetime('now', '-7 days')");
}

const TTL_MS = { verify_email: 24 * 3600 * 1000, reset_password: 3600 * 1000 };

// Создаёт токен, инвалидируя прежние того же типа для этого логина.
// Возвращает PLAINTEXT токен (его шлём в письме); в БД ложится sha256.
function issue(login, type) {
  const plain = crypto.randomBytes(24).toString('hex');
  const ttl = TTL_MS[type] || TTL_MS.verify_email;
  S.invalidateForLogin.run(login, type);
  S.insert.run(login, type, sha256hex(plain), new Date(Date.now() + ttl).toISOString());
  return plain;
}

// Проверяет и гасит токен (одноразовый). Возвращает { login, type } или null.
function consume(plainToken, type) {
  const row = S.byToken.get(sha256hex(String(plainToken || '')));
  if (!row || row.used || row.type !== type) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) return null;
  if (S.markUsed.run(row.id).changes !== 1) return null; // гонка — уже погашен
  return { login: row.login, type: row.type };
}

function prune() { return S.prune.run(); }

module.exports = { init, issue, consume, prune, TTL_MS };
