// C7: daily_summary читает system_log по реальным колонкам (timestamp,
// action, target) — раньше запрос читал несуществующие source/created_at,
// падал каждый день и глушился молчаливым catch, блок «Инфраструктура»
// был молча пустым. Тест гоняет buildDailySummary против настоящей
// schema.sql + проверяет правило «деградация → warn».

import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const tgSummary = require('../src/telegram/daily_summary.js');

const SCHEMA = fs.readFileSync(path.join(__dirname, '..', 'schema.sql'), 'utf8');
const MODEM_PING_MIGRATION = fs.readFileSync(path.join(__dirname, '..', 'migrations', '074_modem_ping.sql'), 'utf8');

let db, warns, logger;

function boot() {
  db = new Database(':memory:');
  db.exec(SCHEMA);
  db.exec(MODEM_PING_MIGRATION);
  // auto_reboot_log создаётся миграцией (не входит в baseline schema.sql);
  // блок инфраструктуры читает его без try/catch.
  db.exec(`CREATE TABLE IF NOT EXISTS auto_reboot_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    rebooted_at TEXT NOT NULL, status TEXT
  )`);
  warns = [];
  logger = { warn: (m) => warns.push(m), info() {}, error() {}, debug() {} };
  tgSummary.init({
    db, logger,
    clientById: new Map(),
    getSetting: (_k, dflt) => dflt,
    aiInsights: null,
  });
}

function addSysLog({ level, action, target, message, timestamp }) {
  db.prepare(
    "INSERT INTO system_log (timestamp, category, level, action, target, message) VALUES (?, 'modem', ?, ?, ?, ?)"
  ).run(timestamp, level, action, target, message);
}

// МСК-день 2026-08-09 = UTC [2026-08-08 21:00, 2026-08-09 21:00)
const DAY = '2026-08-09';

describe('C7: daily_summary — блок «Инфраструктура» против реальной схемы system_log', () => {
  beforeEach(boot);

  it('server_unreachable попадает в сводку (target = имя сервера)', async () => {
    addSysLog({ level: 'warn', action: 'server_unreachable', target: 'S2', message: 'Server unreachable: timeout', timestamp: '2026-08-09 10:00:00' });
    addSysLog({ level: 'error', action: 'billing_failed', target: null, message: 'boom', timestamp: '2026-08-09 11:00:00' });

    const { text } = await tgSummary.buildDailySummary(DAY);

    expect(text).toContain('⚙️ <b>Инфраструктура</b>');
    expect(text).toContain('Серверы недоступны: <b>S2</b>');
    expect(text).toContain('Ошибок в системном логе: 1');
    // Запрос не падал — warn не вызывался.
    expect(warns).toEqual([]);
  });

  it('без событий — «Все серверы доступны», без warn', async () => {
    const { text } = await tgSummary.buildDailySummary(DAY);
    expect(text).toContain('Все серверы доступны');
    expect(warns).toEqual([]);
  });

  it('деградация (нет таблицы system_log) пишет warn, сводка всё равно собирается', async () => {
    db.exec('DROP TABLE system_log');
    const { text } = await tgSummary.buildDailySummary(DAY);
    expect(warns.length).toBe(1);
    expect(warns[0]).toContain('[DailySummary] system_log query failed');
    // Блок деградировал в «все доступны», остальная сводка жива.
    expect(text).toContain('Все серверы доступны');
    expect(text).toContain('💰 <b>Финансы</b>');
  });
});

// D3 (2026-08): строка «Лежат >12 ч: N модемов (список)» в сводке — дыра
// «TG-алерт глушится после stale_modem_hours» закрывается дайджестом.
// Источник — тот же fleet.disconnectedList, что у колокольчика (инжектится).
describe('D3: daily_summary — дайджест модемов, лежащих >12 ч', () => {
  const H = 3600 * 1000;
  function bootWithDigest(listOrFn) {
    db = new Database(':memory:');
    db.exec(SCHEMA);
    db.exec(MODEM_PING_MIGRATION);
    db.exec(`CREATE TABLE IF NOT EXISTS auto_reboot_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      rebooted_at TEXT NOT NULL, status TEXT
    )`);
    warns = [];
    logger = { warn: (m) => warns.push(m), info() {}, error() {}, debug() {} };
    tgSummary.init({
      db, logger,
      clientById: new Map(),
      getSetting: (_k, dflt) => dflt,   // stale_modem_hours → 12
      aiInsights: null,
      listDisconnectedModems: typeof listOrFn === 'function' ? listOrFn : async () => listOrFn,
    });
  }
  const modem = (nick, hoursAgo, server = 'S2') => ({
    nick, server, key: server + '|' + nick, lastOnline: Date.now() - hoursAgo * H,
  });

  it('модемы >12 ч попадают в строку, свежие (<12 ч) — нет; сортировка по давности', async () => {
    bootWithDigest([modem('MD_new', 5), modem('MD_mid', 13), modem('MD_old', 30)]);
    const { text } = await tgSummary.buildDailySummary(DAY);
    expect(text).toContain('Лежат >12 ч: <b>2</b> модемов');
    expect(text).toContain('MD_old (S2)');
    expect(text).toContain('MD_mid (S2)');
    expect(text).not.toContain('MD_new');
    // Дольше всех лежит — первым.
    expect(text.indexOf('MD_old')).toBeLessThan(text.indexOf('MD_mid'));
  });

  it('список ограничен топ-10 + «…и ещё N»', async () => {
    const list = [];
    for (let i = 1; i <= 12; i++) list.push(modem('MD_' + String(i).padStart(2, '0'), 20 + i));
    bootWithDigest(list);
    const { text } = await tgSummary.buildDailySummary(DAY);
    expect(text).toContain('Лежат >12 ч: <b>12</b> модемов');
    expect(text).toContain('…и ещё 2');
    expect(text).toContain('MD_12');          // самый старый — в списке
    expect(text).not.toContain('MD_01');      // два самых свежих — за «…и ещё 2»
    expect(text).not.toContain('MD_02');
  });

  it('все модемы свежие → строки нет', async () => {
    bootWithDigest([modem('MD_fresh', 2)]);
    const { text } = await tgSummary.buildDailySummary(DAY);
    expect(text).not.toContain('Лежат >');
  });

  it('провайдер упал → warn, сводка собирается без строки', async () => {
    bootWithDigest(async () => { throw new Error('fleet boom'); });
    const { text } = await tgSummary.buildDailySummary(DAY);
    expect(warns.some(w => w.includes('[DailySummary] offline digest failed'))).toBe(true);
    expect(text).not.toContain('Лежат >');
    expect(text).toContain('💰 <b>Финансы</b>');
  });
});
