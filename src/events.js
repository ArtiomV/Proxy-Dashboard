'use strict';
//
// src/events.js — SSE (ТЗ мониторинга v2, этап 5, 23.08): внутрипроцессная
// шина realtime-событий админки. Джобы публикуют через publish(type, data)
// (fire-and-forget: без подписчиков — дешёвый no-op, падать не может),
// роут GET /api/admin/events подписывает SSE-клиентов через subscribe().
//
//   - троттлинг: не чаще 1 события каждого типа в THROTTLE_MS на клиента;
//     промежуточные публикации коалесцируются — выигрывает последнее значение;
//   - heartbeat ':ping' каждые HEARTBEAT_MS (держим соединение сквозь Nginx);
//   - лимит MAX_PER_SESSION одновременных SSE-клиентов на admin-сессию;
//   - closeAll() шлёт событие 'bye' и закрывает потоки — graceful shutdown
//     при pm2 restart (фронт переподключается сам, с backoff).

function create(opts) {
  opts = opts || {};
  const HEARTBEAT_MS = opts.heartbeatMs || 25000;
  const THROTTLE_MS = opts.throttleMs != null ? opts.throttleMs : 2000;
  const MAX_PER_SESSION = opts.maxPerSession || 10;
  const logger = opts.logger || null;

  // client: { res, sessionId, lastSent: Map(type→ms), pending: Map(type→data), timer }
  const clients = new Set();

  function _send(client, type, data) {
    let payload;
    try { payload = JSON.stringify(data == null ? {} : data); }
    catch (_) { payload = '{}'; }   // несериализуемый payload не должен ронять джобу
    client.res.write('event: ' + type + '\ndata: ' + payload + '\n\n');
    client.lastSent.set(type, Date.now());
  }

  function _drop(client, reason) {
    if (!clients.has(client)) return;
    clients.delete(client);
    if (client.timer) { clearTimeout(client.timer); client.timer = null; }
    try { client.res.end(); } catch (_) { /* сокет уже мёртв */ }
    if (logger && reason) logger.info('[SSE] client dropped: ' + reason);
  }

  // Отправка отложенных (коалесцированных) событий, чей троттлинг уже истёк;
  // остальные ждут следующего таймера.
  function _flush(client) {
    client.timer = null;
    const now = Date.now();
    let nextDue = Infinity;
    for (const [type, data] of client.pending) {
      const due = (client.lastSent.get(type) || 0) + THROTTLE_MS;
      if (due <= now) {
        client.pending.delete(type);
        try { _send(client, type, data); } catch (e) { _drop(client, 'write: ' + e.message); return; }
      } else if (due < nextDue) nextDue = due;
    }
    if (client.pending.size && nextDue < Infinity) {
      client.timer = setTimeout(() => _flush(client), nextDue - Date.now() + 5);
      if (client.timer.unref) client.timer.unref();
    }
  }

  // Fire-and-forget для джоб: без подписчиков — мгновенный выход.
  function publish(type, data) {
    if (!clients.size) return;
    const now = Date.now();
    for (const client of [...clients]) {
      try {
        const last = client.lastSent.get(type) || 0;
        if (now - last >= THROTTLE_MS) {
          _send(client, type, data);
        } else {
          // Окно троттлинга: коалесцируем — последнее значение типа выигрывает.
          client.pending.set(type, data);
          if (!client.timer) {
            client.timer = setTimeout(() => _flush(client), THROTTLE_MS - (now - last) + 5);
            if (client.timer.unref) client.timer.unref();
          }
        }
      } catch (e) { _drop(client, 'write: ' + e.message); }
    }
  }

  // Подписка SSE-ответа. false = лимит на сессию исчерпан (роут отвечает 429).
  // Отписка — по 'close' сокета (клиент ушёл / вкладка закрыта).
  function subscribe(res, sessionId) {
    let perSession = 0;
    for (const c of clients) if (c.sessionId === sessionId) perSession++;
    if (perSession >= MAX_PER_SESSION) return false;
    const client = { res, sessionId, lastSent: new Map(), pending: new Map(), timer: null };
    clients.add(client);
    res.on('close', () => _drop(client));
    return true;
  }

  // heartbeat-комментарий: Nginx/прокси не режут соединение по idle-таймауту.
  const heartbeat = setInterval(() => {
    for (const client of [...clients]) {
      try { client.res.write(':ping\n\n'); } catch (e) { _drop(client, 'heartbeat: ' + e.message); }
    }
  }, HEARTBEAT_MS);
  if (heartbeat.unref) heartbeat.unref();

  // Graceful shutdown (pm2 restart): 'bye' → фронт закрывает поток и
  // переподключается с backoff, не спамя реконнектами в мёртвый процесс.
  function closeAll() {
    clearInterval(heartbeat);
    for (const client of [...clients]) {
      try { client.res.write('event: bye\ndata: {"reason":"shutdown"}\n\n'); } catch (_) { /* best-effort */ }
      _drop(client);
    }
  }

  function clientCount() { return clients.size; }

  return { publish, subscribe, closeAll, clientCount };
}

module.exports = { create };
