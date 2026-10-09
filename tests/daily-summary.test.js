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
// 09.10: «Проблемных прокси» считается по modem_httpcheck (миграция 075);
// в фикстурах создаём только нужную таблицу, без modem_rate.
const HTTPCHECK_DDL = `CREATE TABLE IF NOT EXISTS modem_httpcheck (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, server TEXT NOT NULL,
  nick TEXT NOT NULL, status INTEGER, total_ms INTEGER, content_ok INTEGER,
  error TEXT NOT NULL DEFAULT ''
)`;

let db, warns, logger;

function boot() {
  db = new Database(':memory:');
  db.exec(SCHEMA);
  db.exec(MODEM_PING_MIGRATION);
  db.exec(HTTPCHECK_DDL);
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

  it('простой сервера попадает в сводку минутами (server_downtime), ошибки лога — со счётчиком', async () => {
    // 2026-09-26: простои читаются из server_downtime (фактические минуты),
    // system_log server_unreachable — только для невосстановившихся.
    db.exec(`CREATE TABLE IF NOT EXISTS server_downtime (
      id INTEGER PRIMARY KEY, server_name TEXT, down_from TEXT, down_to TEXT, duration_sec INTEGER)`);
    db.prepare("INSERT INTO server_downtime (server_name, down_from, down_to, duration_sec) VALUES ('S2', '2026-08-09 06:10:00', '2026-08-09 06:22:00', 720)").run();
    addSysLog({ level: 'error', action: 'billing_failed', target: null, message: 'boom', timestamp: '2026-08-09 11:00:00' });

    const { text } = await tgSummary.buildDailySummary(DAY);

    expect(text).toContain('⚙️ <b>Инфраструктура</b>');
    expect(text).toContain('Простои серверов: <b>S2 — 12 мин (1×)</b>');
    expect(text).toContain('Ошибок в системном логе: 1 (чаще всего: billing_failed ×1)');
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

  // 09.10: «Проблемных прокси» — доля реальных фейлов http-чека >20% за день
  // (≥3 чеков). rotating/offline/acl-скипы не считаются ни фейлами, ни попытками.
  it('проблемные прокси — по доле фейлов http-чека >20%, скип-категории не в счёте', async () => {
    const ins = db.prepare('INSERT INTO modem_httpcheck (ts, server, nick, error) VALUES (?,?,?,?)');
    // MD_bad: 2 фейла из 4 (50%) → проблемный
    ins.run('2026-08-09 10:00:00', 'S1', 'MD_bad', '');
    ins.run('2026-08-09 10:05:00', 'S1', 'MD_bad', 'ECONNRESET');
    ins.run('2026-08-09 10:10:00', 'S1', 'MD_bad', '');
    ins.run('2026-08-09 10:15:00', 'S1', 'MD_bad', 'timeout');
    // MD_skip: rotating/offline выкинуты из знаменателя → 0 валидных чеков < 3
    ins.run('2026-08-09 10:00:00', 'S1', 'MD_skip', 'rotating');
    ins.run('2026-08-09 10:05:00', 'S1', 'MD_skip', 'offline');
    ins.run('2026-08-09 10:10:00', 'S1', 'MD_skip', 'rotating');
    // MD_few: 2 чека — ниже порога ≥3
    ins.run('2026-08-09 10:00:00', 'S1', 'MD_few', 'boom');
    ins.run('2026-08-09 10:05:00', 'S1', 'MD_few', 'boom');

    const { text } = await tgSummary.buildDailySummary(DAY);
    expect(text).toContain('Проблемных прокси: 1 (доля фейлов http-чека >20%)');
    expect(warns).toEqual([]);
  });

  it('утром считает только реально отложенные ночные Telegram-события', async () => {
    db.exec(`CREATE TABLE notifications (
      id INTEGER PRIMARY KEY, rule_id TEXT, title TEXT, priority TEXT,
      payload_json TEXT, created_at TEXT
    )`);
    const ins=db.prepare('INSERT INTO notifications(rule_id,title,priority,payload_json,created_at) VALUES(?,?,?,?,?)');
    ins.run('modem_ping_dead','Пинг не проходит','important','{"_telegram_night_deferred":true}','2026-08-09 22:00:00');
    ins.run('client_debt','Долг клиента','important','{}','2026-08-09 22:10:00');
    const { text } = await tgSummary.buildDailySummary(DAY);
    expect(text).toContain('Ночью без Telegram: <b>1</b>');
    expect(text).toContain('модемы моргали ночью');   // флап-правила свёрнуты
    expect(text).not.toContain('Долг клиента — 1');
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
  db.exec(HTTPCHECK_DDL);
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

// 20.09: дайджест «Должники» не показывает клиентов без единого прокси-порта
// (вкладка «Неактивные»): долг исторический, списания не идут, ежедневное
// напоминание — шум. Гейт опционален: без hasClientPorts — прежнее поведение.
describe('daily_summary — должники без прокси не попадают в дайджест', () => {
  function bootWithDebtors(hasClientPorts) {
    db = new Database(':memory:');
    db.exec(SCHEMA);
    db.exec(MODEM_PING_MIGRATION);
  db.exec(HTTPCHECK_DDL);
    db.exec(`CREATE TABLE IF NOT EXISTS auto_reboot_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      rebooted_at TEXT NOT NULL, status TEXT
    )`);
    warns = [];
    logger = { warn: (m) => warns.push(m), info() {}, error() {}, debug() {} };
    db.prepare("INSERT INTO clients (id, login, name) VALUES ('c1', 'u_c1', 'Активный Должник')").run();
    db.prepare("INSERT INTO billing_ledger (client_id, type, date, timestamp, amount) VALUES ('c1', 'charge', '2026-08-08', datetime('now'), 100)").run();
    tgSummary.init({
      db, logger,
      clientById: new Map([
        ['c1', { id: 'c1', name: 'Активный Должник', portName: 'active_pn', balance: -500 }],
        ['c2', { id: 'c2', name: 'Неактивный Должник', portName: 'gone_pn', balance: -9000 }],
        ['c3', { id: 'c3', name: 'Пауза Должник', portName: 'paused_pn', balance: -700, billingPaused: true }],
      ]),
      getSetting: (_k, dflt) => dflt,
      aiInsights: null,
      hasClientPorts: hasClientPorts === undefined
        ? undefined
        : (pn) => (hasClientPorts || []).includes(pn),
    });
  }

  it('клиент с 0 прокси исключён из должников, активный должник остаётся', async () => {
    bootWithDebtors(['active_pn', 'paused_pn']);
    const { text } = await tgSummary.buildDailySummary(DAY);
    expect(text).toContain('Должников: 1');
    expect(text).toContain('Активный Должник');
    expect(text).not.toContain('Неактивный Должник');
  });

  it('без hasClientPorts — все должники в счётчике и сумме; старые свёрнуты', async () => {
    bootWithDebtors(undefined);
    const { text } = await tgSummary.buildDailySummary(DAY);
    expect(text).toContain('Должников: 2');
    expect(text).toContain('Активный Должник');
    // 2026-09-26: должник без движений >7 дн — свёрнут в строку «старые»,
    // а не повторяется по имени каждый день.
    expect(text).toContain('старые (>7 дн без движений): 1 шт');
    expect(text).not.toContain('Неактивный Должник');
  });
});

// 2026-09-26: блок «Ротации» — аномалии неуспешных по операторам (норма ≤20%,
// исключение Vodafone RO ≤80% — оператор редко меняет IP) + «застрявшие»
// симки, у которых IP не меняется всю неделю.
describe('daily_summary — ротации: аномалии по операторам и застрявшие симки', () => {
  function bootRot() {
    db = new Database(':memory:');
    db.exec(SCHEMA);
    db.exec(MODEM_PING_MIGRATION);
  db.exec(HTTPCHECK_DDL);
    db.exec(`CREATE TABLE IF NOT EXISTS auto_reboot_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      rebooted_at TEXT NOT NULL, status TEXT
    )`);
    warns = [];
    logger = { warn: (m) => warns.push(m), info() {}, error() {}, debug() {} };
    tgSummary.init({ db, logger, clientById: new Map(), getSetting: (_k, dflt) => dflt, aiInsights: null });
  }
  // МСК-день 2026-08-09 = UTC [2026-08-08 21:00, 2026-08-09 21:00)
  const T = (hh, mm) => `2026-08-09 ${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00`;
  function addRot(server, nick, changed, startedAt) {
    db.prepare('INSERT INTO rotation_log (server_name, nick, old_ip, new_ip, started_at, ended_at, took_sec) VALUES (?,?,?,?,?,?,5)')
      .run(server, nick, '1.1.1.1', changed ? '2.2.2.2' : '1.1.1.1', startedAt, startedAt);
  }
  function addMeta(server, nick, operator) {
    db.prepare('INSERT INTO modem_meta (server_name, imei, nick, operator) VALUES (?,?,?,?)')
      .run(server, `imei_${server}_${nick}`, nick, operator);
  }

  it('оператор выше нормы флагается; Vodafone RO в пределах своего порога — нет', async () => {
    bootRot();
    addMeta('RO1', 'RO1_01', 'Orange RO');
    addMeta('RO1', 'RO1_02', 'Vodafone RO');
    addMeta('S1', 'MD_01', 'Moldcell');
    // Orange RO: 6/12 = 50% > нормы 20% → флаг
    for (let i = 0; i < 12; i++) addRot('RO1', 'RO1_01', i >= 6, T(10, i));
    // Vodafone RO: 9/12 = 75% < своего порога 80% → без флага
    for (let i = 0; i < 12; i++) addRot('RO1', 'RO1_02', i >= 9, T(11, i));
    // Moldcell: 1/20 = 5% → без флага
    for (let i = 0; i < 20; i++) addRot('S1', 'MD_01', i !== 0, T(12, i));

    const { text } = await tgSummary.buildDailySummary(DAY);
    expect(text).toContain('🔄 <b>Ротации</b>');
    expect(text).toContain('⚠️ Неуспешные по операторам');
    expect(text).toContain('Orange RO 50% (6/12, норма ≤20%)');
    expect(text).not.toContain('Vodafone RO 75%');
    expect(text).not.toContain('Moldcell 5%');
    expect(warns).toEqual([]);
  });

  it('настройка rotation_fail_norm переопределяет дефолтные пороги', async () => {
    bootRot();
    tgSummary.init({
      db, logger, clientById: new Map(),
      getSetting: (k, dflt) => k === 'rotation_fail_norm'
        ? JSON.stringify({ default: 20, exceptions: { 'Orange RO': 60 } })
        : dflt,
      aiInsights: null,
    });
    addMeta('RO1', 'RO1_01', 'Orange RO');
    for (let i = 0; i < 12; i++) addRot('RO1', 'RO1_01', i >= 6, T(10, i));  // 50% < 60%

    const { text } = await tgSummary.buildDailySummary(DAY);
    expect(text).toContain('🔄 <b>Ротации</b>');
    expect(text).not.toContain('⚠️ Неуспешные по операторам');
  });

  it('симка со 100% фейлов за 7 дней попадает в «Симки без смены IP», разовый фейл — нет', async () => {
    bootRot();
    // RO1_25: 12 фейлов из 12, часть — в предыдущие дни окна 7д
    for (let i = 0; i < 6; i++) addRot('RO1', 'RO1_25', false, T(13, i));
    for (let i = 0; i < 6; i++) addRot('RO1', 'RO1_25', false, `2026-08-05 10:${String(i).padStart(2, '0')}:00`);
    // MD_47: 10 ротаций, 6 фейлов (60% < 80%) — не «застрявшая»
    for (let i = 0; i < 10; i++) addRot('S3', 'MD_47', i >= 6, T(14, i));

    const { text } = await tgSummary.buildDailySummary(DAY);
    expect(text).toContain('🔴 Симки без смены IP (7 дн): RO1_25 — 12/12');
    expect(text).not.toContain('MD_47 —');
  });

  // 09.10: свободные модемы (без клиентских портов) не попадают в дайджест
  // застрявших симок — их IP никому не мешает, строка только путает.
  it('модем без клиента не попадает в «Симки без смены IP», клиентский — попадает', async () => {
    bootRot();
    tgSummary.init({
      db, logger, clientById: new Map(),
      getSetting: (_k, dflt) => dflt,
      aiInsights: null,
      modemHasClient: (_srv, nick) => nick === 'MD_47',
    });
    // RO1_25: 12/12 фейлов, но клиента нет → скрыт
    for (let i = 0; i < 12; i++) addRot('RO1', 'RO1_25', false, T(13, i));
    // MD_47: 12/12 фейлов, клиент есть → в списке
    for (let i = 0; i < 12; i++) addRot('S3', 'MD_47', false, T(14, i));

    const { text } = await tgSummary.buildDailySummary(DAY);
    expect(text).toContain('MD_47 — 12/12');
    expect(text).not.toContain('RO1_25');
  });

  it('без аномалий — только базовые строки блока', async () => {
    bootRot();
    addMeta('S1', 'MD_01', 'Moldcell');
    for (let i = 0; i < 10; i++) addRot('S1', 'MD_01', true, T(10, i));

    const { text } = await tgSummary.buildDailySummary(DAY);
    expect(text).toContain('🔄 <b>Ротации</b>');
    expect(text).toContain('Всего: 10, неуспешных: 0');
    expect(text).not.toContain('⚠️ Неуспешные по операторам');
    expect(text).not.toContain('🔴 Симки без смены IP');
    expect(warns).toEqual([]);
  });
});

// 2026-09-28: блок per_gb клиентов считает стоимость по ЭФФЕКТИВНОЙ цене
// (priceOverride → tariff → price), как биллинг — иначе сводка показывала
// базовую цену 29 ₽ при фактическом списании по override 23 ₽.
describe('daily_summary — per_gb блок по эффективной цене (priceOverride)', () => {
  it('стоимость = ГБ × priceOverride, а не × clients.price', async () => {
    db = new Database(':memory:');
    db.exec(SCHEMA);
    db.exec(MODEM_PING_MIGRATION);
  db.exec(HTTPCHECK_DDL);
    db.exec(`CREATE TABLE IF NOT EXISTS auto_reboot_log (id INTEGER PRIMARY KEY AUTOINCREMENT, rebooted_at TEXT NOT NULL, status TEXT)`);
    db.exec(`CREATE TABLE IF NOT EXISTS tariffs (id INTEGER PRIMARY KEY, name TEXT, price REAL)`);
    warns = [];
    logger = { warn: (m) => warns.push(m), info() {}, error() {}, debug() {} };
    db.prepare("INSERT INTO clients (id, login, name) VALUES ('c1', 'u_c1', 'Палитрумлаб')").run();
    // 10 ГБ вчера (МСК-день 2026-08-09 = UTC [08 21:00, 09 21:00))
    db.prepare("INSERT INTO traffic_hourly (server_name, port_id, nick, client_name, operator, hour_start, bytes_in, bytes_out, uncertain) VALUES ('S1','S1_p1','MD_1','Brandanalytics','Moldcell','2026-08-09 10:00', 8e9, 2e9, 0)").run();
    tgSummary.init({
      db, logger,
      clientById: new Map([
        ['c1', { id: 'c1', name: 'Палитрумлаб', portName: 'Brandanalytics', billingType: 'per_gb', price: 29, priceOverride: 23 }],
      ]),
      getSetting: (_k, dflt) => dflt,
      aiInsights: null,
    });
    const { text } = await tgSummary.buildDailySummary('2026-08-09');
    expect(text).toContain('per_gb клиенты:');
    expect(text).toContain('→ 230 ₽');   // 10 GB × 23 ₽ (override), не ×29 = 290 ₽
    expect(text).not.toContain('→ 290 ₽');
  });

  it('без override цена берётся из тарифа, иначе legacy price', async () => {
    db = new Database(':memory:');
    db.exec(SCHEMA);
    db.exec(MODEM_PING_MIGRATION);
  db.exec(HTTPCHECK_DDL);
    db.exec(`CREATE TABLE IF NOT EXISTS auto_reboot_log (id INTEGER PRIMARY KEY AUTOINCREMENT, rebooted_at TEXT NOT NULL, status TEXT)`);
    db.exec(`CREATE TABLE IF NOT EXISTS tariffs (id INTEGER PRIMARY KEY, name TEXT, price REAL)`);
    db.prepare("INSERT INTO tariffs (id, name, price) VALUES (7, 'Корп', 25)").run();
    db.prepare("INSERT INTO clients (id, login, name) VALUES ('c1', 'u_c1', 'Палитрумлаб')").run();
    db.prepare("INSERT INTO traffic_hourly (server_name, port_id, nick, client_name, operator, hour_start, bytes_in, bytes_out, uncertain) VALUES ('S1','S1_p1','MD_1','Brandanalytics','Moldcell','2026-08-09 10:00', 8e9, 2e9, 0)").run();
    warns = [];
    logger = { warn: (m) => warns.push(m), info() {}, error() {}, debug() {} };
    tgSummary.init({
      db, logger,
      clientById: new Map([
        ['c1', { id: 'c1', name: 'Палитрумлаб', portName: 'Brandanalytics', billingType: 'per_gb', price: 29, tariffId: 7 }],
      ]),
      getSetting: (_k, dflt) => dflt,
      aiInsights: null,
    });
    const { text } = await tgSummary.buildDailySummary('2026-08-09');
    expect(text).toContain('→ 250 ₽');   // 10 GB × 25 ₽ (tariff)
  });
});
