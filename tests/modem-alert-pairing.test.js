// Парность «модем отключился» ↔ «модем вернулся».
//
// Регрессия 2026-07-16: «вернулся в строй» приходило без парного «отключился».
// Гейтом recovered был просто downSec ≥ 10 мин, тогда как offline-алерт мог
// не уйти вовсе (модем лежал > stale_modem_hours, либо in-memory флаг
// потерялся при рестарте). Теперь единственный гейт recovered —
// uptimeTracking[key].offline_alerted, который ставит offline-алерт и который
// персистится вместе с uptime_tracking.
//
// Тест воспроизводит решающее правило на модели состояния (без запуска
// 5000-строчного server.js): три сценария, из-за которых ломалась пара.

import { describe, it, expect } from 'vitest';

const ALERT_MIN_MS = 10 * 60 * 1000;
const STALE_MS = 12 * 3600 * 1000;

/** Решение об offline-алерте (server.js: блок «Single shot per offline streak»). */
function offlineTick(ut, now, sentFlags, key) {
  if (sentFlags[key]) return null;
  if (!ut || !ut.last_online_check) return null;
  const lastOnlineMs = Date.parse(ut.last_online_check);
  const offlineMs = now - lastOnlineMs;
  if (offlineMs < ALERT_MIN_MS) return null;
  if (offlineMs >= STALE_MS) return null;          // труп — не спамим
  sentFlags[key] = true;
  ut.offline_alerted = true;                        // ← персистентный флаг пары
  return 'modem_offline_20m';
}

/** Решение об recovered-алерте (server.js: ветка isUp). */
function onlineTick(ut, sentFlags, key) {
  if (!ut.offline_alerted) return null;             // ← пара обязательна
  ut.offline_alerted = false;
  delete sentFlags[key];
  return 'modem_recovered';
}

const iso = (ms) => new Date(ms).toISOString();

describe('парность offline ↔ recovered', () => {
  it('обычный флап: offline → recovered ровно по одному разу', () => {
    const now = Date.UTC(2026, 6, 16, 12, 0, 0);
    const ut = { last_online_check: iso(now - 15 * 60 * 1000) };
    const flags = {}, key = 'S1_86';
    expect(offlineTick(ut, now, flags, key)).toBe('modem_offline_20m');
    expect(offlineTick(ut, now + 3 * 60 * 1000, flags, key)).toBe(null);   // без спама
    expect(onlineTick(ut, flags, key)).toBe('modem_recovered');
    expect(onlineTick(ut, flags, key)).toBe(null);                          // пара закрыта
  });

  it('давно-мёртвый модем (>12ч): нет offline → нет и recovered', () => {
    const now = Date.UTC(2026, 6, 16, 12, 0, 0);
    const ut = { last_online_check: iso(now - 30 * 3600 * 1000) };
    const flags = {}, key = 'S1_dead';
    expect(offlineTick(ut, now, flags, key)).toBe(null);       // stale — молчим
    expect(onlineTick(ut, flags, key)).toBe(null);             // ← раньше слал «вернулся»
  });

  it('рестарт сервера: in-memory флаг потерян, но пара уцелела', () => {
    const now = Date.UTC(2026, 6, 16, 12, 0, 0);
    const ut = { last_online_check: iso(now - 20 * 60 * 1000) };
    let flags = {}; const key = 'S1_86';
    expect(offlineTick(ut, now, flags, key)).toBe('modem_offline_20m');
    flags = {};                                                 // pm2 restart
    expect(ut.offline_alerted).toBe(true);                      // пережил (в uptime_tracking)
    expect(onlineTick(ut, flags, key)).toBe('modem_recovered');  // пара закрывается
  });

  it('короткий блип (<10 мин): молчим с обеих сторон', () => {
    const now = Date.UTC(2026, 6, 16, 12, 0, 0);
    const ut = { last_online_check: iso(now - 4 * 60 * 1000) };
    const flags = {}, key = 'S1_blip';
    expect(offlineTick(ut, now, flags, key)).toBe(null);
    expect(onlineTick(ut, flags, key)).toBe(null);
  });
});

describe('сводка «N модемов не работает»', () => {
  const decide = (downCount, threshold) => threshold > 0 && downCount >= threshold;
  it('шлётся при достижении порога', () => {
    expect(decide(5, 5)).toBe(true);
    expect(decide(9, 5)).toBe(true);
  });
  it('молчит ниже порога и при выключенной сводке', () => {
    expect(decide(4, 5)).toBe(false);
    expect(decide(50, 0)).toBe(false);
  });
});

// Список в сводке: печатаем ВСЕ модемы; режем только у лимита Telegram (4096).
describe('modems_down_bulk: полный список', () => {
  const { RULES } = require('../src/telegram/alerts.js');
  const mk = (n) => Array.from({ length: n }, (_, i) => `MD_${i + 1} (S4, ${i + 5} мин)`).join('\n');

  it('весь парк (86 модемов) влезает целиком, без «…и ещё»', () => {
    const t = RULES.modems_down_bulk.render({ count: 86, servers: 'S4: 60, S2: 26', list: mk(86) });
    expect(t).toContain('MD_86');
    expect(t).not.toContain('…и ещё');
    expect(t.length).toBeLessThan(4096);
  });

  it('аномально длинный список режется по лимиту Telegram с остатком', () => {
    const t = RULES.modems_down_bulk.render({ count: 500, servers: 'S4: 500', list: mk(500) });
    expect(t.length).toBeLessThan(4096);
    expect(t).toMatch(/…и ещё \d+/);
  });
});
