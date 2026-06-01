'use strict';
//
// src/jobs/tochka-cron.js — nightly Tochka-integration jobs (DoD #1).
//
// Three async cron handlers extracted from server.js:
//
//   autoCreateMissingClients() — on every cron tick, scan live ProxySmart
//     for portNames that don't yet have a client record and auto-create
//     one with per-GB pricing scaled by port count.
//
//   autoGenerateMonthlyActs() — on the 1st of each month after 08:00 MSK,
//     create closing-document (act) records for the PREVIOUS month for
//     every client with autoActs enabled and at least one charge.
//
//   autoGenerateMonthlyBills() — on the 1st of each month after 08:00 MSK,
//     create bill records for the CURRENT month for every client with
//     autoBills enabled, INN set, and non-zero billable amount.
//
// All three are pure-effect (touch DB + clients[] + logger). Factory
// receives every dependency via `deps`; nothing global is captured.

const crypto = require('crypto');
const bcrypt = require('bcrypt');

function create(deps) {
  const {
    db, logger,
    fetchAllServersDataCached, fetchAllServersData,
    clients, users,
    saveClients, rebuildClientMaps,
    logActivity,
    generateId,
    getPriceForProxyCount,
    ledgerDb,
    getMoscowNow,
    getTochkaConfig,
    tochkaRequest,
    buildActItemsFromLedger, buildTochkaActBody,
    buildTochkaBillBody, calculateMonthlyBillAmount,
    // last*GenerationMonth are let-rebound in server.js; we accept getter+setter
    getLastActGenerationMonth, setLastActGenerationMonth,
    getLastBillGenerationMonth, setLastBillGenerationMonth,
  } = deps;

  // #4 «дата взаиморасчётов»: the day-of-month a client is billed on. Derived
  // from contract_date (clamped to 1..28 so it exists in every month — a day-30
  // contract bills on the 28th). Empty / unparseable → 1 (billed on the 1st, the
  // pre-#4 behaviour, so existing clients are unaffected).
  function _settlementDay(client) {
    const cd = client && client.contractDate;
    if (cd) {
      const d = new Date(cd).getDate();
      if (Number.isInteger(d) && d >= 1) return Math.min(d, 28);
    }
    return 1;
  }

  async function autoCreateMissingClients() {
    try {
      const results = await fetchAllServersDataCached();
      const existingPortNames = new Set(clients.map(c => c.portName));
      const allPortNames = new Set();

      for (const data of results) {
        if (typeof data.bw === 'object') {
          for (const [, b] of Object.entries(data.bw)) {
            if (b.portName) {
              allPortNames.add(b.portName);
            }
          }
        }
      }

      // Count ports per portName for pricing
      const portCountMap = {};
      for (const data of results) {
        if (typeof data.bw === 'object') {
          for (const [, b] of Object.entries(data.bw)) {
            if (b.portName) {
              portCountMap[b.portName] = (portCountMap[b.portName] || 0) + 1;
            }
          }
        }
      }

      const IGNORED_PORTNAMES = new Set(['Test', 'test', 'TEST', 'Не назначен', '', 'debug', 'Demo', 'demo']);
      let created = 0;
      for (const pn of allPortNames) {
        if (existingPortNames.has(pn)) continue;
        if (IGNORED_PORTNAMES.has(pn)) continue;
        const login = pn.toLowerCase().replace(/[^a-z0-9_]/g, '_');
        if (users[login]) continue;

        const proxyCount = portCountMap[pn] || 1;
        const autoPrice = getPriceForProxyCount(proxyCount);
        const password = crypto.randomBytes(8).toString('hex');
        const passwordHash = bcrypt.hashSync(password, 10);
        const client = {
          id: generateId(),
          name: pn,
          portName: pn,
          login: login,
          password: null,
          passwordHash: passwordHash,
          contact: '',
          notes: 'Auto-created from portName',
          billingType: 'per_gb',
          price: autoPrice,
          currency: 'RUB',
          payments: [],
          documents: [],
          closingDocuments: [],
          bills: [],
          apiKey: 'prx_' + crypto.randomBytes(24).toString('hex'),
          referral_code: 'REF-' + crypto.randomBytes(4).toString('hex').toUpperCase(),
          referred_by: null,
          referral_balance: 0,
          resetToken: crypto.randomBytes(16).toString('hex'),
          balance: 0,
          last_traffic_snapshot: { timestamp: null, month_bytes: 0 },
          inn: '', kpp: '', legalName: '', contractInfo: '', address: '',
          autoActs: true, autoBills: true, billingPaused: false,
          clientType: 'legal',
          createdAt: new Date().toISOString()
        };
        clients.push(client);
        users[login] = { passwordHash, portNameFilter: pn, source: 'client', clientId: client.id };
        created++;
        logger.info(`  Auto-created client: login=${login}, portName=${pn}`);
        logActivity('system', 'info', 'client_auto_created', pn, `Auto-created client: login=${login}, portName=${pn}`, { login, portName: pn, price: autoPrice, proxy_count: proxyCount });
      }

      if (created > 0) {
        saveClients(clients);
        rebuildClientMaps();
        logger.info(`[AutoCreate] Created ${created} new client(s)`);
        logActivity('system', 'info', 'auto_create_complete', null, `Auto-created ${created} new client(s)`, { created });
      }
    } catch (e) {
      logger.error('[AutoCreate] Error:', e.message);
      logActivity('system', 'error', 'auto_create_error', null, `Auto-create clients error: ${e.message}`);
    }
  }

  async function autoGenerateMonthlyActs() {
    const moscowDate = getMoscowNow();
    const today = moscowDate.getDate();
    const hour = moscowDate.getHours();

    // Morning batch only. #4: each client is billed on its OWN settlement day
    // (from contract_date; empty → 1st), so we run daily and act on the clients
    // whose settlement day is today — not just everyone on the 1st.
    if (hour < 8) return;

    // Previous calendar month (interpretation А — calendar periods, just issued
    // on the client's day). Per-client de-dup is the "act already exists" check.
    const prevMonth = new Date(moscowDate);
    prevMonth.setMonth(prevMonth.getMonth() - 1);
    const period = prevMonth.toISOString().slice(0, 7); // YYYY-MM

    logger.info(`[Tochka AutoActs] Period ${period}, settlement day=${today}...`);
    let generated = 0;

    const tochkaConfig = getTochkaConfig();
    for (const client of clients) {
      // Физ. лицо не нуждается в актах — пропускаем (юр.лица оформляем как обычно).
      if (client.clientType === 'individual') continue;
      // #4: only on THIS client's settlement day-of-month.
      if (today !== _settlementDay(client)) continue;
      // Skip clients with autoActs disabled
      if (client.autoActs === false) continue;

      // Skip clients without charges
      const ledgerEntries = ledgerDb.listByClient(client.id);
      const monthCharges = ledgerEntries.filter(e => (e.type === 'charge' || e.type === 'correction') && e.date && e.date.startsWith(period));
      if (monthCharges.length === 0) continue;

      // Skip if act already exists for this period
      if ((client.closingDocuments || []).some(d => d.period === period)) continue;

      try {
        const { actItems, totalCost } = buildActItemsFromLedger(client, period);

        // Try Tochka API
        let tochkaDocumentId = null;
        const actNumber = `АКТ-${period.replace('-', '')}-${client.id.slice(0, 4)}`;
        if (tochkaConfig.jwt && tochkaConfig.customerCode && tochkaConfig.accountId && client.inn) {
          try {
            const actData = buildTochkaActBody(client, period, actItems, actNumber);
            const result = await tochkaRequest('POST', '/uapi/invoice/v1.0/closing-documents', actData);
            if (result.status === 200 && result.data?.Data?.documentId) {
              tochkaDocumentId = result.data.Data.documentId;
            }
          } catch (e) { logger.error(`[Tochka AutoActs] API error for ${client.name}:`, e.message); }
        }

        const docId = crypto.randomBytes(8).toString('hex');
        if (!client.closingDocuments) client.closingDocuments = [];
        client.closingDocuments.push({
          id: docId,
          tochkaDocumentId,
          period,
          createdAt: new Date().toISOString(),
          status: 'unsigned',
          totalAmount: totalCost,
          items: actItems,
          actNumber,
          contractInfo: client.contractInfo || ''
        });
        generated++;
        logger.info(`[Tochka AutoActs] Created act for ${client.name}: ${totalCost} RUB`);
        logActivity('billing', 'info', 'act_created', client.name, `Act created: ${totalCost} RUB for ${period}`, { client_id: client.id, amount: totalCost, period, act_number: actNumber });
      } catch (e) {
        logger.error(`[Tochka AutoActs] Error for ${client.name}:`, e.message);
        logActivity('billing', 'error', 'act_error', client.name, `Act generation error: ${e.message}`, { client_id: client.id, period });
      }
    }

    if (generated > 0) {
      saveClients(clients);
      logger.info(`[Tochka AutoActs] Generated ${generated} acts for ${period}`);
    }
    if (generated > 0) logActivity('billing', 'info', 'acts_complete', null, `Акты: ${generated} за ${period} (день взаиморасчётов ${today})`, { generated, period, day: today });
    // #4: no global per-month guard — de-dup is the per-client "act exists" check,
    // since different clients generate on different days now.
  }

  async function autoGenerateMonthlyBills() {
    const moscowDate = getMoscowNow();
    const today = moscowDate.getDate();
    const hour = moscowDate.getHours();

    // Morning batch only; #4: fire per client on its settlement day (run daily).
    if (hour < 8) return;

    // Current calendar month (interpretation А). Per-client de-dup = "bill exists".
    const currentPeriod = `${moscowDate.getFullYear()}-${String(moscowDate.getMonth() + 1).padStart(2, '0')}`;

    logger.info(`[Tochka AutoBills] Period ${currentPeriod}, settlement day=${today}...`);
    let generated = 0;
    let serverData = [];
    try { serverData = await fetchAllServersData(); } catch (e) { logger.error('[AutoBills] fetchAllServersData error:', e.message); }

    const tochkaConfig = getTochkaConfig();
    for (const client of clients) {
      // Физ. лицо не нуждается в счетах — пропускаем.
      if (client.clientType === 'individual') continue;
      // #4: only on THIS client's settlement day-of-month.
      if (today !== _settlementDay(client)) continue;
      // Skip clients with autoBills disabled
      if (client.autoBills === false) continue;

      // Skip clients without INN
      if (!client.inn) continue;

      // Skip if bill already exists for this period
      if ((client.bills || []).some(b => b.period === currentPeriod)) continue;

      try {
        const amount = calculateMonthlyBillAmount(client, serverData);
        if (amount <= 0) {
          logger.info(`[Tochka AutoBills] Skipping ${client.name}: amount is 0`);
          continue;
        }

        const billNumber = `СЧЁТ-${currentPeriod.replace('-', '')}-${client.id.slice(0, 4)}`;
        const billDate = `${currentPeriod}-01`;

        let tochkaBillId = null;
        if (tochkaConfig.jwt && tochkaConfig.customerCode && tochkaConfig.accountId) {
          try {
            const billData = buildTochkaBillBody(client, amount, billNumber, billDate);
            const result = await tochkaRequest('POST', '/uapi/invoice/v1.0/bills', billData);
            if (result.status === 200 && result.data?.Data?.documentId) {
              tochkaBillId = result.data.Data.documentId;
            }
          } catch (e) {
            logger.error(`[Tochka AutoBills] API error for ${client.name}:`, e.message);
          }
        }

        const billId = crypto.randomBytes(8).toString('hex');
        if (!client.bills) client.bills = [];
        client.bills.push({
          id: billId,
          tochkaBillId,
          period: currentPeriod,
          createdAt: new Date().toISOString(),
          amount,
          status: 'unpaid',
          billNumber,
          billDate
        });
        generated++;
        logger.info(`[Tochka AutoBills] Created bill for ${client.name}: ${amount} RUB`);
        logActivity('billing', 'info', 'bill_created', client.name, `Bill created: ${amount} RUB for ${currentPeriod}`, { client_id: client.id, amount, period: currentPeriod, bill_number: billNumber });
      } catch (e) {
        logger.error(`[Tochka AutoBills] Error for ${client.name}:`, e.message);
        logActivity('billing', 'error', 'bill_error', client.name, `Bill generation error: ${e.message}`, { client_id: client.id, period: currentPeriod });
      }
    }

    if (generated > 0) {
      saveClients(clients);
      logger.info(`[Tochka AutoBills] Generated ${generated} bills for ${currentPeriod}`);
    }
    if (generated > 0) logActivity('billing', 'info', 'bills_complete', null, `Счета: ${generated} за ${currentPeriod} (день взаиморасчётов ${today})`, { generated, period: currentPeriod, day: today });
    // #4: no global per-month guard — de-dup is the per-client "bill exists" check.
  }

  return { autoCreateMissingClients, autoGenerateMonthlyActs, autoGenerateMonthlyBills };
}

module.exports = { create };
