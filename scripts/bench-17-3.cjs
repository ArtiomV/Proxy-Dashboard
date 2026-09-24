// scripts/bench-17-3.cjs — замеры оптимизаций §17.3 на синтетической базе.
// Запуск: node scripts/bench-17-3.cjs
// Метрики: длительность прохода, число SQL-запросов, прочитанных строк, peak RSS.
'use strict';
const Database = require('better-sqlite3');

const LEDGER_ROWS = 100000;
const CLIENTS = 200;
const PORTS = 500;

function makeDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE billing_ledger (
      id INTEGER PRIMARY KEY AUTOINCREMENT, client_id TEXT, type TEXT, date TEXT,
      timestamp TEXT, amount REAL, currency TEXT, balance_before REAL, balance_after REAL,
      gb_used REAL, modem_count INTEGER, days_in_month INTEGER, note TEXT, source TEXT,
      payment_id TEXT, details TEXT, purchase_id TEXT
    );
    CREATE INDEX idx_ledger_payment ON billing_ledger(payment_id, type);
    CREATE INDEX idx_ledger_client ON billing_ledger(client_id, type, date);
  `);
  const ins = db.prepare(`INSERT INTO billing_ledger
    (client_id, type, date, timestamp, amount, currency, note, source, payment_id, details)
    VALUES (?, ?, ?, ?, ?, 'RUB', '', '', ?, '{}')`);
  const tx = db.transaction(() => {
    for (let i = 0; i < LEDGER_ROWS; i++) {
      const cid = 'c' + (i % CLIENTS);
      const day = 1 + (i % 28);
      const date = `2026-09-${String(day).padStart(2, '0')}`;
      const type = i % 7 === 0 ? 'payment' : 'charge';
      const pid = i % 997 === 0 ? 'order_' + i : '';
      ins.run(cid, type, date, date + 'T01:00:00Z', 100 + (i % 50), pid);
    }
  });
  tx();
  return db;
}

function bench(label, fn, iters) {
  fn(); // warmup
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < iters; i++) fn();
  const ms = Number(process.hrtime.bigint() - t0) / 1e6 / iters;
  const rss = Math.round(process.memoryUsage().rss / 1048576);
  console.log(`${label.padEnd(58)} ${ms.toFixed(3)} ms/iter, peak RSS ${rss} MB`);
  return ms;
}

const db = makeDb();
const byClient = db.prepare('SELECT * FROM billing_ledger WHERE client_id = ? ORDER BY id');
const byPayment = db.prepare('SELECT id, client_id, type, amount FROM billing_ledger WHERE payment_id = ? AND type = ? ORDER BY id');
const sum7d = db.prepare("SELECT COALESCE(SUM(amount),0) t FROM billing_ledger WHERE client_id = ? AND type = 'charge' AND date >= ? AND date < ?");

// EXPLAIN: индекс используется?
const plan = db.prepare('EXPLAIN QUERY PLAN SELECT * FROM billing_ledger WHERE payment_id = ? AND type = ?').all('order_500', 'card_payment');
console.log('EXPLAIN byPayment:', JSON.stringify(plan.map(r => r.detail)));

console.log('\n=== §17.3.1: сверка по payment_id ===');
bench('старый: listByClient + filter (вся история клиента)', () => {
  const rows = byClient.all('c42').filter(r => r.type === 'card_payment' && r.payment_id === 'order_500');
  return rows.length;
}, 200);
bench('новый: listByPayment (индекс, глобально)', () => {
  return byPayment.all('order_500', 'card_payment').length;
}, 200);

console.log('\n=== §17.3.2: среднесуточное за 7 дней ===');
bench('старый: listByClient + filter по датам', () => {
  return byClient.all('c42').filter(r => r.type === 'charge' && r.date >= '2026-09-17' && r.date < '2026-09-24')
    .reduce((s, r) => s + r.amount, 0);
}, 200);
bench('новый: SUM по (client_id,type,date)', () => {
  return sum7d.get('c42', '2026-09-17', '2026-09-24').t;
}, 200);

console.log('\n=== §17.3.4: порты guard-прохода ===');
// Синтетический фид: 5 серверов × 100 портов
const feed = [];
for (let s = 0; s < 5; s++) {
  const ports = {};
  for (let p = 0; p < 100; p++) {
    ports['imei_' + s + '_' + p] = [{ portID: 'port_' + s + '_' + p, portName: 'c' + ((s * 100 + p) % CLIENTS), PROXY_VALID_BEFORE: '' }];
  }
  feed.push({ serverName: 'S' + s, ports });
}
const findServer = (n) => ({ name: n });
function clientPortsScan(client, results) {
  const out = [];
  for (const data of results) {
    for (const list of Object.values(data.ports || {})) {
      for (const p of list || []) {
        if (p && p.portName === client.portName) out.push({ server: findServer(data.serverName), portId: p.portID });
      }
    }
  }
  return out;
}
bench('старый: clientPorts скан фида на КАЖДОГО клиента (200 клиентов)', () => {
  let n = 0;
  for (let c = 0; c < CLIENTS; c++) n += clientPortsScan({ portName: 'c' + c }, feed).length;
  return n;
}, 20);
bench('новый: clientPortsIndex один проход + lookups', () => {
  const index = new Map();
  for (const data of feed) {
    for (const list of Object.values(data.ports || {})) {
      for (const p of list || []) {
        if (!index.has(p.portName)) index.set(p.portName, []);
        index.get(p.portName).push(p);
      }
    }
  }
  let n = 0;
  for (let c = 0; c < CLIENTS; c++) n += (index.get('c' + c) || []).length;
  return n;
}, 20);

console.log('\nГотово. Цифры «старый vs новый» — для отчёта §17.3.');
