'use strict';
//
// src/jobs/client-offline-notify.js — ЛК v3, карточка прокси → «Настройки» →
// «Уведомлять, если офлайн»: клиенту в Telegram, если его прокси недоступен
// больше 5 минут, и парное «снова работает» после возврата.
//
// Источник «последний раз был жив» — uptimeTracking[key].last_online_check
// (тот же, что у операторских алертов, переживает рестарт). Флаги клиента —
// kv_store 'client_proxy_prefs:<clientId>'.notifyOffline[nick] (пишет
// POST /api/client/proxy_prefs). Состояние «уже уведомили» — в памяти:
// после рестарта модем, лежащий дольше STALE_MS, повторно не объявляется.

const DOWN_MS = 5 * 60 * 1000;
const STALE_MS = 60 * 60 * 1000;   // лежит дольше часа к моменту первого замера — не спамим

function create(deps) {
  const { db, logger, clientById, uptimeTracking, knownModems, notifyClient } = deps;
  const notified = new Map();   // clientId|server|nick → downSinceMs

  function prefsRows() {
    try {
      return db.prepare("SELECT key, value FROM kv_store WHERE key LIKE 'client_proxy_prefs:%'").all();
    } catch (_) { return []; }
  }

  // nick (клиентский порт) → [{server, imei}] по knownModems: portName клиента
  function modemsOf(portName) {
    const out = [];
    for (const [server, portMap] of Object.entries(knownModems || {})) {
      for (const info of Object.values(portMap || {})) {
        if (info && info.nick && info.imei && info.portName === portName) out.push({ server, nick: info.nick, imei: info.imei });
      }
    }
    return out;
  }

  async function tick() {
    const now = Date.now();
    for (const row of prefsRows()) {
      const clientId = row.key.slice('client_proxy_prefs:'.length);
      let prefs;
      try { prefs = JSON.parse(row.value || '{}'); } catch (_) { continue; }
      const want = prefs.notifyOffline || {};
      if (!Object.keys(want).length) continue;
      const client = clientById.get(clientId) || clientById.get(Number(clientId));
      if (!client || !client.tgChatId || !client.portName) continue;
      for (const m of modemsOf(client.portName)) {
        if (!want[m.nick]) continue;
        const ut = uptimeTracking[m.server + '_' + m.imei];
        if (!ut || !ut.last_online_check) continue;
        const last = Date.parse(ut.last_online_check);
        if (isNaN(last)) continue;
        const id = clientId + '|' + m.server + '|' + m.nick;
        const down = now - last;
        const label = (prefs.labels && prefs.labels[m.nick]) ? ` («${prefs.labels[m.nick]}»)` : '';
        if (down >= DOWN_MS) {
          if (notified.has(id)) continue;
          if (down > STALE_MS) { notified.set(id, { since: last, silent: true }); continue; }   // лежал до рестарта — молча
          notified.set(id, { since: last, silent: false });
          try {
            await notifyClient(client, `⚠️ Прокси ${m.nick}${label} недоступен ${Math.round(down / 60000)} мин. Мы уже разбираемся — напишем, когда он снова заработает.`,
              { action: 'proxy_offline_notify', level: 'warn', details: { nick: m.nick, server: m.server } });
          } catch (e) { logger.warn(`[ClientOfflineNotify] ${client.login}: ${e.message}`); }
        } else if (notified.has(id)) {
          const st = notified.get(id);
          notified.delete(id);
          if (st.silent) continue;   // о падении не сообщали — и о возврате молчим
          const since = st.since;
          const mins = Math.max(1, Math.round((last - since) / 60000));
          try {
            await notifyClient(client, `✅ Прокси ${m.nick}${label} снова работает (простой ~${mins} мин).`,
              { action: 'proxy_online_notify', details: { nick: m.nick, server: m.server } });
          } catch (e) { logger.warn(`[ClientOfflineNotify] ${client.login}: ${e.message}`); }
        }
      }
    }
  }

  return { tick, _notified: notified };
}

module.exports = { create, DOWN_MS, STALE_MS };
