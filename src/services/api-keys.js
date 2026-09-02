'use strict';
//
// src/services/api-keys.js — выдача и ротация клиентских API-ключей (v2.10.68).
//
// Ключи хранятся только в виде SHA-256 (миграция 043), plaintext показывается
// один раз в момент выдачи. При ротации прежний ключ НЕ умирает мгновенно:
// он переезжает в apiKeyPrev и работает ещё graceHours (дефолт 24 ч) —
// клиент обновляет интеграцию без обрыва (grace-ротация, миграция 086).
// Истёкший prev отклоняется в findClientByApiKey (server.js).
//
// Вызывающий код обязан после rotateApiKey сохранить клиентов (saveClients)
// и перестроить карты (rebuildMaps — вызывается внутри saveClients).

const crypto = require('crypto');
const { sha256hex } = require('../utils/secrets');

const DEFAULT_GRACE_HOURS = 24;

// Новый ключ БЕЗ сохранения прежнего (первичная выдача при создании клиента).
function issueApiKey() {
  const plain = 'prx_' + crypto.randomBytes(24).toString('hex');
  return { plain, hash: sha256hex(plain), prefix: plain.slice(0, 8) };
}

// Ротация с grace: новый ключ работает сразу, прежний — ещё graceHours.
// Возвращает plaintext нового ключа (показать один раз) и дедлайн прежнего.
function rotateApiKey(client, graceHours = DEFAULT_GRACE_HOURS) {
  const k = issueApiKey();
  const now = Date.now();
  const graceMs = Math.max(0, Number(graceHours) || 0) * 3600 * 1000;
  if (client.apiKey) {
    client.apiKeyPrev = client.apiKey;   // это уже хэш — хэшируем только plaintext
    client.apiKeyPrevExpiresAt = graceMs > 0 ? new Date(now + graceMs).toISOString() : null;
  } else {
    client.apiKeyPrev = '';
    client.apiKeyPrevExpiresAt = null;
  }
  client.apiKey = k.hash;
  client.apiKeyPrefix = k.prefix;
  client.apiKeyCreatedAt = new Date(now).toISOString();
  return { plain: k.plain, prevExpiresAt: client.apiKeyPrevExpiresAt };
}

module.exports = { issueApiKey, rotateApiKey, DEFAULT_GRACE_HOURS };
