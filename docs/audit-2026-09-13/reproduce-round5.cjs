'use strict';
// Local audit only: network and financial writes are replaced by recording adapters.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ROOT = path.resolve(__dirname, '../..');
const noop = () => {};
const middleware = (req, res, next) => next();
const logger = { info: noop, warn: noop, error: noop };
const results = [];
function response() { return { statusCode: 200, status(n) { this.statusCode = n; return this; }, json(body) { this.body = body; return this; } }; }
function handler(router, url) { return router.stack.find(x => x.route && x.route.path === url).route.stack.at(-1).handle; }
async function purchase(tariff) {
  const client = { id: 'a', login: 'alice', balance: 10000, emailVerified: true, billingType: 'per_modem', price: 0 };
  const deadlines = [], debits = [];
  const router = require(path.join(ROOT, 'src/routes/retail'))({
    logger, authMiddleware: middleware, adminMiddleware: middleware, clients: [client],
    getSetting: (key, fallback) => key === 'retail_enabled' ? true : fallback,
    tariffsDb: { byId: () => tariff },
    retailPoolDb: { nextFree: () => ({ id: 1, port_id: 'p1' }), reserve: () => true, lease: noop,
      setTestExpires: (id, time) => deadlines.push(time), byStatus: () => [] },
    findServer: name => ({ name }), proxyConf: { getConfForm: async () => ({ ok: true, html: '' }), postConfForm: async () => ({ ok: true }) },
    parseHtmlInputFields: () => ({ proxy_password: 'demo' }),
    atomicDebit: (id, amount) => debits.push(amount), saveClients: noop,
    proxySmart: { invalidateCache: noop }, auditLog: noop, logActivity: noop, getClientIp: () => 'test',
  });
  const res = response();
  await handler(router, '/api/client/buy_proxy')({ user: { login: 'alice' }, body: { tariff_id: tariff.id } }, res);
  return { client, deadlines, debits, res };
}
async function main() {
  const tariff = { id: 1, active: 1, public: 0, name: 'private', type: 'per_gb', server: 'S1', price: 3040, min_topup_days: 1, duration_hours: 48 };
  const bought = await purchase(tariff);
  assert.equal(bought.res.body.ok, true);
  assert.equal(bought.client.tariffId, 1);
  assert.equal(bought.client.billingType, 'per_modem');
  assert.equal(bought.deadlines.length, 0);
  results.push({ finding: 'DEEP-45', privateTariffPurchased: true });
  results.push({ finding: 'DEEP-46', tariffType: tariff.type, clientBillingType: bought.client.billingType,
    durationHours: 48, deadlinesCreated: 0, chargedAsMonthlyRate: bought.debits[0] });

  const billingSource = fs.readFileSync(path.join(ROOT, 'src/jobs/billing.js'), 'utf8');
  const priceSource = billingSource.slice(billingSource.indexOf('  function getClientPrice('), billingSource.indexOf('\n  let lastBillingRunSummary'));
  const currentTariff = { active: 1, price: 3040 };
  const price = vm.runInNewContext('(' + priceSource.trim() + ')', { tariffsDb: { byId: () => currentTariff } });
  assert.equal(price(bought.client), 3040);
  currentTariff.active = 0;
  assert.equal(price(bought.client), 0);
  results.push({ finding: 'DEEP-47', priceBeforeDeactivation: 3040, priceAfterDeactivation: price(bought.client) });

  const portRouter = require(path.join(ROOT, 'src/routes/proxies-ports'))({
    logger, authMiddleware: middleware, adminMiddleware: middleware, findServer: name => ({ name }),
    fetchApi: async (server, url) => url.includes('list_ports') ? { imei: [{ portID: 'p1', portName: 'alice' }] } : { ok: false, error: 'apply rejected' },
    proxyConf: { getConfForm: async () => ({ ok: true, html: '' }), postConfForm: async () => ({ ok: true }) },
    parseHtmlInputFields: () => ({ portID: 'p1', http_port: 8001, socks_port: 5001 }),
    proxySmart: { invalidateCache: noop }, auditLog: noop, logActivity: noop, getClientIp: () => 'test',
  });
  const stored = response();
  // Different initial client name avoids the duplicate preflight; verification checks ID only.
  await handler(portRouter, '/api/admin/store_port')({ user: { login: 'admin' }, body: { serverName: 'S1', IMEI: 'imei', portName: 'bob1' } }, stored);
  assert.equal(stored.body.ok, true);
  assert.equal(stored.body.applied, true);
  results.push({ finding: 'DEEP-49', actualOwner: 'alice', requestedOwner: 'bob1', applyReturnedOk: false, reportedApplied: stored.body.applied });
  console.log(JSON.stringify({ isolation: 'local modules with recording adapters', results }, null, 2));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
