// B3 (Р13): автоблок должников-физиков после DailyBilling + восстановление
// после оплаты. Чистые юнит-тесты джобы с заглушками ProxySmart (proxyConf/
// fetchApi) — проверяем УСЛОВИЯ и то, что «дата до» пишется тем же путём
// (edit_port form → POST → apply_port), что ручной save_port_config.

import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const debtBlockMod = require('../src/jobs/debt-block.js');

const NOW = new Date('2026-08-10T10:00:00+03:00');       // МСК
const TODAY = '2026-08-10';
const RESTORE_UNTIL = '2026-09-09';                        // +30 дней

let posted, applied, alertsFired, audited, saved, activity;
let server;

function mkDeps(ledgerEntries = [], resultsFn = serverResults) {
  posted = []; applied = []; alertsFired = []; audited = []; saved = 0; activity = [];
  server = { name: 'S1', apiUrl: 'http://s1' };
  return {
    logger: { info() {}, warn() {}, error() {} },
    logActivity: (cat, level, action, target, _message, _details) => activity.push({ cat, level, action, target }),
    alerts: { trigger: (rule, payload) => alertsFired.push({ rule, payload }) },
    auditLog: (who, action, details) => audited.push({ who, action, details }),
    proxyConf: {
      getConfForm: async () => ({ ok: true, html: '<form><input name="proxy_password" value="pw1"></form>' }),
      postConfForm: async (srv, path, formData) => { posted.push({ path, formData }); return { ok: true }; },
    },
    fetchApi: async (srv, path) => { applied.push(path); return {}; },
    parseHtmlInputFields: () => ({ proxy_password: 'pw1' }),
    findServer: () => server,
    proxySmart: { invalidateCache() {} },
    ledgerDb: { listByClient: () => ledgerEntries },
    saveClients: () => { saved++; },
    getMoscowNow: () => new Date(NOW.getTime()),
    fetchAllServersDataCached: async () => resultsFn(),
    clients: [],
  };
}

function serverResults(portName = 'clientA', validBefore = '2026-12-31') {
  return [{
    serverName: 'S1',
    ports: { imei1: [{ portID: 'p1', portName, PROXY_VALID_BEFORE: validBefore }] },
  }];
}

function mkClient(overrides = {}) {
  return {
    id: 'c1', name: 'ClientA', portName: 'clientA',
    clientType: 'individual', allowDebt: false, debtBlocked: false,
    balance: -100, ...overrides,
  };
}

const lastPostedValidBefore = () => posted[posted.length - 1].formData.PROXY_VALID_BEFORE;

describe('debt-block: автоблок после DailyBilling', () => {
  it('физик с минусом и allow_debt=0 → «дата до» = сегодня, порт применён, флаг+аудит+алерт', async () => {
    const job = debtBlockMod.create(mkDeps());
    const client = mkClient();
    await job.runAfterDailyBilling([client], serverResults());

    expect(posted.length).toBe(1);
    expect(posted[0].path).toBe('/conf/edit_port/p1');
    expect(lastPostedValidBefore()).toBe(TODAY);
    expect(applied).toEqual(['/apix/apply_port?arg=p1']);
    expect(client.debtBlocked).toBe(true);
    expect(saved).toBe(1);
    expect(alertsFired.some(a => a.rule === 'client_blocked_debt')).toBe(true);
    expect(audited.some(a => a.action === 'debt_block')).toBe(true);
    expect(activity.some(a => a.action === 'debt_block')).toBe(true);
  });

  it('юрлицо с минусом — НИКОГДА не блокируется', async () => {
    const job = debtBlockMod.create(mkDeps());
    const client = mkClient({ clientType: 'legal' });
    await job.runAfterDailyBilling([client], serverResults());
    expect(posted.length).toBe(0);
    expect(client.debtBlocked).toBeFalsy();
  });

  it('allow_debt=1 — не трогаем', async () => {
    const job = debtBlockMod.create(mkDeps());
    const client = mkClient({ allowDebt: true });
    await job.runAfterDailyBilling([client], serverResults());
    expect(posted.length).toBe(0);
    expect(client.debtBlocked).toBeFalsy();
  });

  it('per_modem физик — блокируется так же (Р25)', async () => {
    const job = debtBlockMod.create(mkDeps());
    const client = mkClient({ billingType: 'per_modem' });
    await job.runAfterDailyBilling([client], serverResults());
    expect(posted.length).toBe(1);
    expect(client.debtBlocked).toBe(true);
  });

  it('повторный прогон по уже заблокированному — идемпотентно (без повторной записи)', async () => {
    const job = debtBlockMod.create(mkDeps());
    const client = mkClient({ debtBlocked: true });
    await job.runAfterDailyBilling([client], serverResults());
    expect(posted.length).toBe(0);
  });

  it('порт с уже истёкшей «дата до» (ручной override в прошлое) — не перезаписываем', async () => {
    const job = debtBlockMod.create(mkDeps());
    const client = mkClient();
    await job.runAfterDailyBilling([client], serverResults('clientA', '2026-08-01'));
    expect(posted.length).toBe(0);
    expect(client.debtBlocked).toBeFalsy();   // гасили не мы — флаг не ставим
  });

  it('клиент без портов — не блокируется и не алертит', async () => {
    const job = debtBlockMod.create(mkDeps());
    const client = mkClient();
    await job.runAfterDailyBilling([client], [{ serverName: 'S1', ports: {} }]);
    expect(posted.length).toBe(0);
    expect(client.debtBlocked).toBeFalsy();
  });

  it('прогноз «за 3 дня»: баланс ≤ 3 × среднесуточное списание → предупреждение', async () => {
    // Списания по 100 ₽/день 04–09.08 → avg = 600/7 ≈ 85.71; баланс 250 ≤ 3×avg.
    const ledger = [];
    for (let d = 3; d <= 9; d++) {
      ledger.push({ type: 'charge', date: `2026-08-0${d}`, cost: 100 });
    }
    const job = debtBlockMod.create(mkDeps(ledger));
    const client = mkClient({ balance: 250 });
    await job.runAfterDailyBilling([client], serverResults());
    const warn = alertsFired.find(a => a.rule === 'client_block_warning');
    expect(warn).toBeTruthy();
    expect(warn.payload.daysLeft).toBe(2);
    expect(posted.length).toBe(0);            // это только предупреждение, не блок
  });

  it('баланс > 3 × avg — ни блока, ни предупреждения', async () => {
    const ledger = [{ type: 'charge', date: '2026-08-09', cost: 100 }];
    const job = debtBlockMod.create(mkDeps(ledger));
    const client = mkClient({ balance: 5000 });
    await job.runAfterDailyBilling([client], serverResults());
    expect(posted.length).toBe(0);
    expect(alertsFired.length).toBe(0);
  });
});

describe('debt-block: восстановление после оплаты', () => {
  it('оплата → balance > 0 → «дата до» = сегодня + 30 дней, флаг снят, аудит+алерт', async () => {
    // Порт погашен автоблоком (validBefore = сегодня) — продлеваем.
    const job = debtBlockMod.create(mkDeps([], () => serverResults('clientA', TODAY)));
    const client = mkClient({ balance: 500, debtBlocked: true });
    const ok = await job.restoreAfterCredit(client);

    expect(ok).toBe(true);
    expect(lastPostedValidBefore()).toBe(RESTORE_UNTIL);
    expect(applied).toEqual(['/apix/apply_port?arg=p1']);
    expect(client.debtBlocked).toBe(false);
    expect(saved).toBe(1);
    expect(alertsFired.some(a => a.rule === 'client_unblocked_debt')).toBe(true);
    expect(audited.some(a => a.action === 'debt_unblock')).toBe(true);
  });

  it('баланс всё ещё ≤ 0 — не восстанавливаем', async () => {
    const job = debtBlockMod.create(mkDeps());
    const client = mkClient({ balance: -5, debtBlocked: true });
    expect(await job.restoreAfterCredit(client)).toBe(false);
    expect(posted.length).toBe(0);
    expect(client.debtBlocked).toBe(true);
  });

  it('клиент без флага debtBlocked (гасили руками) — автоматом не продлеваем', async () => {
    const job = debtBlockMod.create(mkDeps());
    const client = mkClient({ balance: 500, debtBlocked: false });
    expect(await job.restoreAfterCredit(client)).toBe(false);
    expect(posted.length).toBe(0);
  });

  it('не укорачиваем более поздний ручной срок (override «продлить до…»)', async () => {
    const job = debtBlockMod.create(mkDeps());
    const client = mkClient({ balance: 500, debtBlocked: true });
    await job.restoreAfterCredit(client);
    // порт имел 2026-12-31 > restore-until → записи не было, но флаг снят
    expect(posted.length).toBe(0);
    expect(client.debtBlocked).toBe(false);
  });
});
