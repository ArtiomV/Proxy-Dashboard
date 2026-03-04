const express = require('express');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');

// Load .env manually
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#')) {
      const [key, ...vals] = trimmed.split('=');
      process.env[key.trim()] = vals.join('=').trim();
    }
  });
}

const PORT = process.env.PORT || 3000;

// Multiple API servers: API_<name>_URL, API_<name>_USER, API_<name>_PASS
const apiServers = [];
const serverKeys = new Set();
for (const key of Object.keys(process.env)) {
  const m = key.match(/^API_(.+)_URL$/);
  if (m) serverKeys.add(m[1]);
}
for (const name of serverKeys) {
  apiServers.push({
    name,
    url: process.env[`API_${name}_URL`],
    user: process.env[`API_${name}_USER`] || 'proxy',
    pass: process.env[`API_${name}_PASS`] || 'proxy'
  });
}
console.log(`Loaded ${apiServers.length} API server(s): ${apiServers.map(s => s.name + ' (' + s.url + ')').join(', ')}`);

// Modem login mapping: MODEM_LOGIN_<nick>=<login>
const modemLogins = {};
for (const [key, val] of Object.entries(process.env)) {
  if (key.startsWith('MODEM_LOGIN_')) {
    const nick = key.slice(12);
    modemLogins[nick] = val;
  }
}
console.log(`Loaded ${Object.keys(modemLogins).length} modem login mapping(s)`);

// Parse users from .env: USER_<login>=<password>|<portName>
const users = {};
for (const [key, val] of Object.entries(process.env)) {
  if (key.startsWith('USER_')) {
    const login = key.slice(5);
    const pipeIdx = val.indexOf('|');
    if (pipeIdx === -1) continue;
    const password = val.slice(0, pipeIdx);
    const filterPart = val.slice(pipeIdx + 1).trim();
    const portNameFilter = filterPart === '*' ? '*' : filterPart;
    users[login] = { password, portNameFilter, source: 'env' };
  }
}

// ==================== CLIENT MANAGEMENT (JSON storage) ====================
const CLIENTS_FILE = path.join(__dirname, 'clients.json');

function loadClients() {
  try {
    if (fs.existsSync(CLIENTS_FILE)) {
      return JSON.parse(fs.readFileSync(CLIENTS_FILE, 'utf8'));
    }
  } catch (e) { console.error('Failed to load clients:', e.message); }
  return [];
}

function saveClients(clientsList) {
  try { fs.writeFileSync(CLIENTS_FILE, JSON.stringify(clientsList, null, 2)); }
  catch (e) { console.error('Failed to save clients:', e.message); }
}

// ==================== BILLING LEDGER ====================
const BILLING_LEDGER_FILE = path.join(__dirname, 'billing_ledger.json');
let billingLedger = {};
try {
  if (fs.existsSync(BILLING_LEDGER_FILE)) {
    billingLedger = JSON.parse(fs.readFileSync(BILLING_LEDGER_FILE, 'utf8'));
  }
} catch (e) { console.error('Failed to load billing_ledger:', e.message); }

function saveBillingLedger() {
  try { fs.writeFileSync(BILLING_LEDGER_FILE, JSON.stringify(billingLedger, null, 2)); }
  catch (e) { console.error('Failed to save billing_ledger:', e.message); }
}

// ==================== TOCHKA BANK API ====================
const TOCHKA_CONFIG_FILE = path.join(__dirname, 'tochka_config.json');
let tochkaConfig = { jwt: '', clientId: '', customerCode: '', accountId: '', companyName: '', companyInn: '', companyKpp: '' };
try {
  if (fs.existsSync(TOCHKA_CONFIG_FILE)) {
    Object.assign(tochkaConfig, JSON.parse(fs.readFileSync(TOCHKA_CONFIG_FILE, 'utf8')));
  }
} catch (e) { console.log('[Tochka] Error loading config file:', e.message); }
// .env overrides file config
if (process.env.TOCHKA_JWT_TOKEN) tochkaConfig.jwt = process.env.TOCHKA_JWT_TOKEN;
if (process.env.TOCHKA_CLIENT_ID) tochkaConfig.clientId = process.env.TOCHKA_CLIENT_ID;
if (process.env.TOCHKA_CUSTOMER_CODE) tochkaConfig.customerCode = process.env.TOCHKA_CUSTOMER_CODE;
if (process.env.TOCHKA_ACCOUNT_ID) tochkaConfig.accountId = process.env.TOCHKA_ACCOUNT_ID;
if (process.env.TOCHKA_COMPANY_NAME) tochkaConfig.companyName = process.env.TOCHKA_COMPANY_NAME;
if (process.env.TOCHKA_COMPANY_INN) tochkaConfig.companyInn = process.env.TOCHKA_COMPANY_INN;
if (process.env.TOCHKA_COMPANY_KPP) tochkaConfig.companyKpp = process.env.TOCHKA_COMPANY_KPP;
function saveTochkaConfig() { try { fs.writeFileSync(TOCHKA_CONFIG_FILE, JSON.stringify(tochkaConfig, null, 2)); } catch(e) { console.error('[Tochka] Save config error:', e.message); } }
if (tochkaConfig.jwt) { saveTochkaConfig(); console.log(`[Tochka] API configured (client_id: ${tochkaConfig.clientId})`); }
else console.log('[Tochka] No JWT token configured, bank integration disabled');

// Tochka API helper — HTTPS requests to enter.tochka.com
function tochkaRequest(method, apiPath, body) {
  return new Promise((resolve, reject) => {
    const postData = body ? JSON.stringify(body) : null;
    const headers = {
      'Authorization': `Bearer ${tochkaConfig.jwt}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    };
    if (tochkaConfig.customerCode) headers['CustomerCode'] = tochkaConfig.customerCode;
    if (postData) headers['Content-Length'] = Buffer.byteLength(postData);
    const req = https.request({
      hostname: 'enter.tochka.com',
      port: 443,
      path: apiPath,
      method: method,
      headers,
      timeout: 30000
    }, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        const ct = res.headers['content-type'] || '';
        if (ct.includes('application/json')) {
          try { resolve({ status: res.statusCode, data: JSON.parse(buf.toString()), headers: res.headers }); }
          catch (e) { resolve({ status: res.statusCode, data: buf.toString(), headers: res.headers }); }
        } else if (ct.includes('application/pdf') || ct.includes('application/octet-stream')) {
          resolve({ status: res.statusCode, buffer: buf, headers: res.headers });
        } else {
          resolve({ status: res.statusCode, data: buf.toString(), headers: res.headers });
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Tochka API timeout')); });
    if (postData) req.write(postData);
    req.end();
  });
}

// Bank payments log
const BANK_PAYMENTS_FILE = path.join(__dirname, 'bank_payments.json');
let bankPayments = [];
try {
  if (fs.existsSync(BANK_PAYMENTS_FILE)) {
    bankPayments = JSON.parse(fs.readFileSync(BANK_PAYMENTS_FILE, 'utf8'));
  }
} catch (e) { console.error('Failed to load bank_payments:', e.message); }

function saveBankPayments() {
  try { fs.writeFileSync(BANK_PAYMENTS_FILE, JSON.stringify(bankPayments, null, 2)); }
  catch (e) { console.error('Failed to save bank_payments:', e.message); }
}

// Decode JWT payload (without verification — verification is optional via public key)
function decodeJwtPayload(token) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const payload = Buffer.from(parts[1], 'base64url').toString('utf8');
    return JSON.parse(payload);
  } catch (e) {
    // Try standard base64 with padding fix
    try {
      const parts = token.split('.');
      let b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
      while (b64.length % 4) b64 += '=';
      const payload = Buffer.from(b64, 'base64').toString('utf8');
      return JSON.parse(payload);
    } catch (e2) { return null; }
  }
}

// Track last act/bill generation month to avoid duplicates
let lastActGenerationMonth = '';
let lastBillGenerationMonth = '';

// Russian month names (prepositional case for "в январе")
const MONTH_NAMES_RU = ['январе','феврале','марте','апреле','мае','июне','июле','августе','сентябре','октябре','ноябре','декабре'];

// Helper: build Tochka closing document request body
function buildTochkaActBody(client, period, actItems, actNumber) {
  const [year, month] = period.split('-').map(Number);
  const lastDay = new Date(year, month, 0).getDate();
  const monthNameRu = MONTH_NAMES_RU[month - 1] || '';
  const serviceName = `Услуги по обеспечению подключения к прокси-серверу в ${monthNameRu} ${year}г`;
  const totalAmount = actItems.reduce((s, i) => s + (i.amount || 0), 0);
  const isIP = client.inn && client.inn.length === 12;

  // Build full counterparty name with address (ИНН/КПП добавляется Точкой автоматически)
  let secondSideName = client.legalName || client.name;
  if (client.address) {
    secondSideName += `, ${client.address}`;
  }

  // Build Act object
  // NB: поле "Основание" не поддерживается API Точки для закрывающих документов — заполняется вручную
  const act = {
    Positions: actItems.map((item, idx) => ({
      positionName: serviceName,
      quantity: item.quantity || 1,
      unitCode: 'услуга.',
      totalAmount: item.amount || 0,
      ndsKind: 'without_nds',
      price: item.amount || 0,
      positionNumber: idx + 1
    })),
    actDate: `${period}-${String(lastDay).padStart(2, '0')}`,
    number: actNumber,
    totalAmount: Math.round(totalAmount * 100) / 100
  };

  return {
    Data: {
      accountId: tochkaConfig.accountId,
      customerCode: tochkaConfig.customerCode,
      SecondSide: {
        secondSideType: isIP ? 'individual_entrepreneur' : 'legal_entity',
        type: isIP ? 'ip' : 'company',
        inn: client.inn || '',
        taxCode: client.inn || '',
        kpp: client.kpp || '',
        name: secondSideName
      },
      Content: {
        Act: act,
        PackingList: {},
        Invoicef: {},
        Upd: {}
      }
    }
  };
}

// Helper: build Tochka bill (счёт на оплату) request body
function buildTochkaBillBody(client, amount, billNumber, billDate) {
  const isIP = client.inn && client.inn.length === 12;

  // Build full counterparty name with address (ИНН/КПП добавляется Точкой автоматически)
  let secondSideName = client.legalName || client.name;
  if (client.address) {
    secondSideName += `, ${client.address}`;
  }

  return {
    Data: {
      accountId: tochkaConfig.accountId,
      customerCode: tochkaConfig.customerCode,
      SecondSide: {
        secondSideType: isIP ? 'individual_entrepreneur' : 'legal_entity',
        type: isIP ? 'ip' : 'company',
        inn: client.inn || '',
        taxCode: client.inn || '',
        kpp: client.kpp || '',
        name: secondSideName
      },
      Content: {
        Invoice: {
          Positions: [{
            positionName: 'Предоплата за услуги мобильных прокси',
            quantity: 1,
            unitCode: 'услуга.',
            totalAmount: amount,
            ndsKind: 'without_nds',
            price: amount,
            positionNumber: 1
          }],
          invoiceDate: billDate,
          number: billNumber,
          totalAmount: amount
        }
      }
    }
  };
}

// Helper: calculate monthly bill amount for a client
function calculateMonthlyBillAmount(client, cachedResults) {
  let baseAmount = 0;

  if (client.billingType === 'per_modem') {
    // Fixed: price * modem count
    let modemCount = 0;
    if (cachedResults && cachedResults.length > 0) {
      for (const data of cachedResults) {
        if (typeof data.bw === 'object') {
          for (const [portId, b] of Object.entries(data.bw)) {
            if (b.portName === client.portName) modemCount++;
          }
        }
      }
    }
    if (modemCount === 0) modemCount = 1; // fallback
    baseAmount = client.price * modemCount;
  } else {
    // per_gb: sum charges from previous month
    const now = new Date();
    const prevMonth = new Date(now);
    prevMonth.setMonth(prevMonth.getMonth() - 1);
    const prevPeriod = prevMonth.toISOString().slice(0, 7); // YYYY-MM

    const ledgerEntries = billingLedger[client.id] || [];
    const monthCharges = ledgerEntries.filter(e => e.type === 'charge' && e.date && e.date.startsWith(prevPeriod));
    baseAmount = monthCharges.reduce((sum, e) => sum + (e.cost || 0), 0);

    if (baseAmount <= 0) return 0; // no charges last month — skip
  }

  // Add negative balance (debt) to the amount
  let totalAmount = baseAmount;
  if ((client.balance || 0) < 0) {
    totalAmount += Math.abs(client.balance);
  }

  // For per_gb: round up to nearest 10,000₽
  if (client.billingType !== 'per_modem') {
    totalAmount = Math.ceil(totalAmount / 10000) * 10000;
  }

  return Math.round(totalAmount * 100) / 100;
}

// ==================== DAILY TRAFFIC HISTORY ====================
const DAILY_TRAFFIC_FILE = path.join(__dirname, 'traffic_daily.json');
let dailyTraffic = {}; // { portName: { "2026-03-01": { in: bytes, out: bytes }, ... } }
let lastDailyTrafficDate = '';
try {
  if (fs.existsSync(DAILY_TRAFFIC_FILE)) {
    dailyTraffic = JSON.parse(fs.readFileSync(DAILY_TRAFFIC_FILE, 'utf8'));
  }
} catch (e) { console.error('Failed to load daily_traffic:', e.message); }

function saveDailyTraffic() {
  try { fs.writeFileSync(DAILY_TRAFFIC_FILE, JSON.stringify(dailyTraffic, null, 2)); }
  catch (e) { console.error('Failed to save daily_traffic:', e.message); }
}

// Parse traffic value like "10.5 GB" to bytes
function parseTrafficValue(val) {
  if (!val || val === '0 B') return 0;
  if (typeof val === 'number') return val;
  const str = String(val).trim();
  const match = str.match(/^([\d.]+)\s*(B|KB|MB|GB|TB)?$/i);
  if (!match) return 0;
  const num = parseFloat(match[1]);
  const unit = (match[2] || 'B').toUpperCase();
  const mult = { B: 1, KB: 1024, MB: 1048576, GB: 1073741824, TB: 1099511627776 };
  return num * (mult[unit] || 1);
}

// ==================== KNOWN MODEMS (persistence for offline detection) ====================
const KNOWN_MODEMS_FILE = path.join(__dirname, 'known_modems.json');
let knownModems = {}; // { serverName: { portId: { portName, imei, nick, model, portInfo, lastSeen } } }
try {
  if (fs.existsSync(KNOWN_MODEMS_FILE)) {
    knownModems = JSON.parse(fs.readFileSync(KNOWN_MODEMS_FILE, 'utf8'));
  }
} catch (e) { console.error('Failed to load known_modems:', e.message); }

function saveKnownModems() {
  try { fs.writeFileSync(KNOWN_MODEMS_FILE, JSON.stringify(knownModems, null, 2)); }
  catch (e) { console.error('Failed to save known_modems:', e.message); }
}

/**
 * Update known modems from fresh (non-cached) server data.
 * Remembers each modem ever seen so we can inject them as offline later.
 */
function updateKnownModems(data) {
  if (data._cached) return;
  const srvName = data.serverName;
  if (!knownModems[srvName]) knownModems[srvName] = {};
  const km = knownModems[srvName];
  const now = Date.now();

  // Build portId → imei map from ports data
  const portIdToImei = {};
  if (data.ports && typeof data.ports === 'object') {
    for (const [imei, portList] of Object.entries(data.ports)) {
      if (Array.isArray(portList)) {
        for (const p of portList) {
          if (p.portID) portIdToImei[p.portID] = imei;
        }
      }
    }
  }

  // Update known modems with currently present data
  if (data.bw && typeof data.bw === 'object') {
    for (const [portId, bw] of Object.entries(data.bw)) {
      const imei = portIdToImei[portId] || '';
      let modemStatus = null;
      if (Array.isArray(data.status)) {
        modemStatus = data.status.find(m => m.modem_details && m.modem_details.IMEI === imei);
      }
      let portInfo = null;
      if (data.ports && data.ports[imei]) {
        const arr = Array.isArray(data.ports[imei]) ? data.ports[imei] : [];
        portInfo = arr.find(p => p.portID === portId) || null;
      }

      km[portId] = {
        portName: bw.portName || '',
        imei,
        nick: (modemStatus && modemStatus.modem_details && modemStatus.modem_details.NICK) || (km[portId] && km[portId].nick) || '',
        model: (modemStatus && modemStatus.modem_details && (modemStatus.modem_details.MODEL_SHOWN || modemStatus.modem_details.MODEL)) || (km[portId] && km[portId].model) || '',
        portInfo: portInfo ? JSON.parse(JSON.stringify(portInfo)) : (km[portId] && km[portId].portInfo ? km[portId].portInfo : null),
        lastSeen: now
      };
    }
  }

  saveKnownModems();
}

/**
 * Inject offline modems: for modems in knownModems that are NOT in the current data,
 * add them back with offline status so they appear in the dashboard.
 */
function injectOfflineModems(data) {
  const srvName = data.serverName;
  const km = knownModems[srvName];
  if (!km) return;

  const currentPortIds = new Set(Object.keys(data.bw || {}));

  for (const [portId, info] of Object.entries(km)) {
    if (currentPortIds.has(portId)) continue;

    // Inject into bw
    if (!data.bw) data.bw = {};
    data.bw[portId] = {
      portName: info.portName || '',
      bandwidth_bytes_day_in: '0 B',
      bandwidth_bytes_day_out: '0 B',
      bandwidth_bytes_yesterday_in: '0 B',
      bandwidth_bytes_yesterday_out: '0 B',
      bandwidth_bytes_month_in: '0 B',
      bandwidth_bytes_month_out: '0 B',
      bandwidth_bytes_prevmonth_in: '0 B',
      bandwidth_bytes_prevmonth_out: '0 B',
      _offline: true
    };

    // Inject into status
    if (!Array.isArray(data.status)) data.status = [];
    if (info.imei) {
      data.status.push({
        modem_details: {
          IMEI: info.imei,
          NICK: info.nick || '',
          MODEL_SHOWN: info.model || '',
          MODEL: info.model || ''
        },
        net_details: {
          IS_ONLINE: 'no',
          EXT_IP: '',
          CELLOP: '',
          CurrentNetworkType: ''
        },
        _server: srvName,
        _offline: true
      });
    }

    // Inject into ports
    if (!data.ports) data.ports = {};
    if (info.imei && info.portInfo) {
      if (!data.ports[info.imei]) data.ports[info.imei] = [];
      const existing = data.ports[info.imei].find(p => p.portID === portId);
      if (!existing) {
        data.ports[info.imei].push({
          ...info.portInfo,
          _offline: true
        });
      }
    }
  }
}

// Load clients into users map on startup
let clients = loadClients();

// Ensure all clients have required fields (migration)
let clientsMigrated = false;
for (const c of clients) {
  if (!c.payments) { c.payments = []; clientsMigrated = true; }
  if (!c.apiKey) { c.apiKey = 'prx_' + crypto.randomBytes(24).toString('hex'); clientsMigrated = true; }
  if (!c.referral_code) { c.referral_code = 'REF-' + crypto.randomBytes(4).toString('hex').toUpperCase(); clientsMigrated = true; }
  if (c.referral_balance === undefined) { c.referral_balance = 0; clientsMigrated = true; }
  if (!c.resetToken) { c.resetToken = crypto.randomBytes(16).toString('hex'); clientsMigrated = true; }
  if (!c.documents) { c.documents = []; clientsMigrated = true; }
  // Billing persistence: initialize balance from total payments
  if (c.balance === undefined) {
    c.balance = (c.payments || []).reduce((sum, p) => sum + (parseFloat(p.amount) || 0), 0);
    clientsMigrated = true;
  }
  if (!c.last_traffic_snapshot) {
    c.last_traffic_snapshot = { timestamp: null, month_bytes: 0 };
    clientsMigrated = true;
  }
  // Tochka Bank integration fields
  if (c.inn === undefined) { c.inn = ''; clientsMigrated = true; }
  if (c.kpp === undefined) { c.kpp = ''; clientsMigrated = true; }
  if (c.legalName === undefined) { c.legalName = ''; clientsMigrated = true; }
  if (!c.closingDocuments) { c.closingDocuments = []; clientsMigrated = true; }
  if (c.contractInfo === undefined) { c.contractInfo = ''; clientsMigrated = true; }
  if (c.address === undefined) { c.address = ''; clientsMigrated = true; }
  if (!c.bills) { c.bills = []; clientsMigrated = true; }
}
if (clientsMigrated) saveClients(clients);

// Auto-migrate .env users (non-admin) to clients.json if not already there
for (const [login, u] of Object.entries(users)) {
  if (u.source === 'env' && u.portNameFilter !== '*') {
    const exists = clients.find(c => c.login === login);
    if (!exists) {
      const client = {
        id: crypto.randomBytes(8).toString('hex'),
        name: u.portNameFilter,
        portName: u.portNameFilter,
        login,
        password: u.password,
        contact: '',
        notes: 'Auto-migrated from .env',
        billingType: 'per_gb',
        price: 23,
        currency: 'RUB',
        payments: [],
        apiKey: 'prx_' + crypto.randomBytes(24).toString('hex'),
        referral_code: 'REF-' + crypto.randomBytes(4).toString('hex').toUpperCase(),
        referred_by: null,
        referral_balance: 0,
        resetToken: crypto.randomBytes(16).toString('hex'),
        documents: [],
        balance: 0,
        last_traffic_snapshot: { timestamp: null, month_bytes: 0 },
        createdAt: new Date().toISOString()
      };
      clients.push(client);
      console.log(`  Auto-migrated user ${login} -> client "${u.portNameFilter}"`);
    }
  }
}
// Remove any accidentally created tg_ clients (Telegram bot users don't get dashboard accounts)
const tgClientsRemoved = clients.filter(c => c.portName && c.portName.startsWith('tg_'));
if (tgClientsRemoved.length > 0) {
  for (const tc of tgClientsRemoved) {
    delete users[tc.login];
    console.log(`  Removed tg_ client "${tc.portName}" from dashboard`);
  }
  clients = clients.filter(c => !(c.portName && c.portName.startsWith('tg_')));
}
saveClients(clients);

for (const c of clients) {
  if (c.login && c.password && c.portName) {
    users[c.login] = { password: c.password, portNameFilter: c.portName, source: 'client', clientId: c.id };
  }
}
console.log(`Loaded ${Object.keys(users).length} user(s): ${Object.keys(users).join(', ')}`);
console.log(`  - ${clients.length} client(s) from clients.json`);

// ==================== SESSIONS ====================
const SESSION_FILE = path.join(__dirname, 'sessions.json');
const SESSION_TTL = 365 * 24 * 60 * 60 * 1000;

let sessions = {};
try {
  if (fs.existsSync(SESSION_FILE)) {
    const raw = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
    const now = Date.now();
    for (const [token, sess] of Object.entries(raw)) {
      if (sess.expiresAt > now) sessions[token] = sess;
    }
  }
} catch (e) {}

function saveSessions() {
  try { fs.writeFileSync(SESSION_FILE, JSON.stringify(sessions)); } catch (e) {}
}

function generateToken() { return crypto.randomBytes(32).toString('hex'); }
function generateId() { return crypto.randomBytes(8).toString('hex'); }

// ==================== SETTINGS ====================
const SETTINGS_FILE = path.join(__dirname, 'settings.json');

let appSettings = {
  speedtest_times: ['02:00', '14:00'],
  pricing_tiers: [
    { min_proxies: 1, price: 30, label: '1-4 прокси' },
    { min_proxies: 5, price: 25, label: '5-9 прокси' },
    { min_proxies: 10, price: 23, label: '10-19 прокси' },
    { min_proxies: 20, price: 20, label: '20+ прокси' }
  ]
};
try {
  if (fs.existsSync(SETTINGS_FILE)) {
    appSettings = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
  }
} catch (e) { console.error('Failed to load settings:', e.message); }

function saveSettings() {
  try { fs.writeFileSync(SETTINGS_FILE, JSON.stringify(appSettings, null, 2)); }
  catch (e) { console.error('Failed to save settings:', e.message); }
}

// ==================== PRICING TIERS ====================
function getPriceForProxyCount(count) {
  const tiers = appSettings.pricing_tiers || [];
  // Sort descending by min_proxies to find the right tier
  const sorted = tiers.slice().sort((a, b) => b.min_proxies - a.min_proxies);
  for (const tier of sorted) {
    if (count >= tier.min_proxies) return tier.price;
  }
  return tiers.length > 0 ? tiers[0].price : 23; // fallback
}

// ==================== BANDWIDTH PARSING UTILS ====================
function parseBwToBytes(str) {
  if (!str || str === 0) return 0;
  const s = String(str).trim();
  const m = s.match(/([\d.]+)\s*(TB|GB|MB|KB|B)?/i);
  if (!m) return 0;
  const val = parseFloat(m[1]);
  const u = (m[2] || 'B').toUpperCase();
  const mult = { 'TB': 1024**4, 'GB': 1024**3, 'MB': 1024**2, 'KB': 1024, 'B': 1 };
  return val * (mult[u] || 1);
}

function computeClientMonthBytes(allServerResults, portName) {
  let totalBytes = 0;
  for (const data of allServerResults) {
    if (typeof data.bw === 'object') {
      for (const [portId, b] of Object.entries(data.bw)) {
        if (b.portName === portName) {
          totalBytes += parseBwToBytes(b.bandwidth_bytes_month_in);
          totalBytes += parseBwToBytes(b.bandwidth_bytes_month_out);
        }
      }
    }
  }
  return totalBytes;
}

function computeClientPrevMonthBytes(allServerResults, portName) {
  let totalBytes = 0;
  for (const data of allServerResults) {
    if (typeof data.bw === 'object') {
      for (const [portId, b] of Object.entries(data.bw)) {
        if (b.portName === portName) {
          totalBytes += parseBwToBytes(b.bandwidth_bytes_prevmonth_in);
          totalBytes += parseBwToBytes(b.bandwidth_bytes_prevmonth_out);
        }
      }
    }
  }
  return totalBytes;
}

function getClientCachedServers(allServerResults, portName) {
  const cachedServers = [];
  for (const data of allServerResults) {
    if (data._cached && typeof data.bw === 'object') {
      for (const [portId, b] of Object.entries(data.bw)) {
        if (b.portName === portName) {
          cachedServers.push(data.serverName);
          break;
        }
      }
    }
  }
  return cachedServers;
}

// ==================== DOCUMENTS DIR ====================
const DOCUMENTS_DIR = path.join(__dirname, 'documents');
if (!fs.existsSync(DOCUMENTS_DIR)) fs.mkdirSync(DOCUMENTS_DIR, { recursive: true });

const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ==================== AUTH ====================

function authMiddleware(req, res, next) {
  const token = req.headers['x-auth-token'] || req.query.token;
  const sess = token ? sessions[token] : null;
  if (!sess || sess.expiresAt < Date.now()) {
    if (sess) { delete sessions[token]; saveSessions(); }
    return res.status(401).json({ error: 'Unauthorized' });
  }
  req.user = sess;
  next();
}

function adminMiddleware(req, res, next) {
  if (req.user.portNameFilter !== '*') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

app.post('/api/login', (req, res) => {
  const { login, password } = req.body;
  if (!login || !password) return res.status(400).json({ error: 'Login and password required' });
  const user = users[login];
  if (!user || user.password !== password) return res.status(401).json({ error: 'Invalid login or password' });
  const token = generateToken();
  const isAdmin = user.portNameFilter === '*';
  sessions[token] = { login, portNameFilter: user.portNameFilter, isAdmin, expiresAt: Date.now() + SESSION_TTL };
  saveSessions();
  res.json({ token, login, isAdmin });
});

app.post('/api/logout', (req, res) => {
  const token = req.headers['x-auth-token'];
  if (token) { delete sessions[token]; saveSessions(); }
  res.json({ ok: true });
});

// Admin: impersonate client (create session as client)
app.post('/api/admin/impersonate/:id', authMiddleware, adminMiddleware, (req, res) => {
  const client = clients.find(c => c.id === req.params.id);
  if (!client) return res.status(404).json({ error: 'Client not found' });
  const user = users[client.login];
  if (!user) return res.status(400).json({ error: 'Client user not found' });
  const token = generateToken();
  sessions[token] = { login: client.login, portNameFilter: user.portNameFilter, isAdmin: false, expiresAt: Date.now() + SESSION_TTL };
  saveSessions();
  res.json({ ok: true, token, login: client.login });
});

// ==================== ProxySmart API helpers ====================

function fetchApi(server, apiPath, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const url = new URL(apiPath, server.url);
    const auth = Buffer.from(`${server.user}:${server.pass}`).toString('base64');
    const req = http.request({
      hostname: url.hostname, port: url.port,
      path: url.pathname + url.search, method: 'GET',
      headers: { 'Authorization': `Basic ${auth}`, 'Accept': 'application/json' },
      timeout
    }, (proxyRes) => {
      let data = '';
      proxyRes.on('data', chunk => data += chunk);
      proxyRes.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { resolve({ raw: data }); }
      });
    });
    req.on('error', (err) => reject(err));
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout from ' + server.name)); });
    req.end();
  });
}

function fetchApiRaw(server, apiPath, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const url = new URL(apiPath, server.url);
    const auth = Buffer.from(`${server.user}:${server.pass}`).toString('base64');
    const req = http.request({
      hostname: url.hostname, port: url.port,
      path: url.pathname + url.search, method: 'GET',
      headers: { 'Authorization': `Basic ${auth}` },
      timeout
    }, (proxyRes) => {
      const chunks = [];
      proxyRes.on('data', chunk => chunks.push(chunk));
      proxyRes.on('end', () => resolve({ buffer: Buffer.concat(chunks), contentType: proxyRes.headers['content-type'] || '' }));
    });
    req.on('error', (err) => reject(err));
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout from ' + server.name)); });
    req.end();
  });
}

function postApi(server, apiPath, body, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const url = new URL(apiPath, server.url);
    const auth = Buffer.from(`${server.user}:${server.pass}`).toString('base64');
    const postData = typeof body === 'string' ? body : JSON.stringify(body);
    const req = http.request({
      hostname: url.hostname, port: url.port,
      path: url.pathname + url.search, method: 'POST',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      },
      timeout
    }, (proxyRes) => {
      let data = '';
      proxyRes.on('data', chunk => data += chunk);
      proxyRes.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { resolve({ raw: data }); }
      });
    });
    req.on('error', (err) => reject(err));
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout from ' + server.name)); });
    req.write(postData);
    req.end();
  });
}

function postFormApi(server, apiPath, formData, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const url = new URL(apiPath, server.url);
    const auth = Buffer.from(`${server.user}:${server.pass}`).toString('base64');
    const req = http.request({
      hostname: url.hostname, port: url.port,
      path: url.pathname + url.search, method: 'POST',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(formData)
      },
      timeout
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout from ' + server.name)); });
    req.write(formData);
    req.end();
  });
}

function findServer(serverName) {
  return apiServers.find(s => s.name === serverName);
}

// ==================== DATA FETCHING & MERGING ====================

// ===== SERVER DATA CACHE =====
// Preserves modem data + traffic when a server goes down temporarily
const SERVER_CACHE_FILE = path.join(__dirname, 'server_cache.json');
let serverCache = {};
try {
  if (fs.existsSync(SERVER_CACHE_FILE)) {
    serverCache = JSON.parse(fs.readFileSync(SERVER_CACHE_FILE, 'utf8'));
    console.log(`Loaded server cache: ${Object.keys(serverCache).length} server(s) cached`);
  }
} catch (e) { console.error('Failed to load server_cache:', e.message); }

function saveServerCache() {
  try { fs.writeFileSync(SERVER_CACHE_FILE, JSON.stringify(serverCache)); }
  catch (e) { console.error('Failed to save server_cache:', e.message); }
}

function cacheServerData(data) {
  serverCache[data.serverName] = {
    bw: data.bw,
    status: data.status,
    ports: data.ports,
    serverName: data.serverName,
    cachedAt: Date.now()
  };
  saveServerCache();
}

// When server is down, mark all modems as offline but keep bandwidth + ports
function getCachedDataAsOffline(serverName) {
  const cached = serverCache[serverName];
  if (!cached) return null;

  const ageMinutes = Math.round((Date.now() - cached.cachedAt) / 60000);
  console.log(`[Cache] Using cached data for ${serverName} (${ageMinutes} min old)`);

  // Mark all modems in status as offline + _cached flag
  let offlineStatus = [];
  if (Array.isArray(cached.status)) {
    offlineStatus = cached.status.map(m => {
      const copy = JSON.parse(JSON.stringify(m));
      if (copy.net_details) {
        copy.net_details.IS_ONLINE = 'no';
      }
      copy._cached = true;
      copy._cachedAt = cached.cachedAt;
      return copy;
    });
  }

  return {
    bw: cached.bw || {},
    status: offlineStatus,
    ports: cached.ports || {},
    serverName: serverName,
    _cached: true,
    _cachedAt: cached.cachedAt
  };
}

async function fetchServerData(server) {
  const [bw, status, ports] = await Promise.all([
    fetchApi(server, '/apix/bandwidth_report_all'),
    fetchApi(server, '/apix/show_status_json'),
    fetchApi(server, '/apix/list_ports_json')
  ]);
  const result = { bw, status, ports, serverName: server.name };
  // Cache successful response
  cacheServerData(result);
  return result;
}

// Fetch data from all servers; use cache for unreachable ones
async function fetchAllServersData() {
  const settled = await Promise.allSettled(apiServers.map(s => fetchServerData(s)));
  const results = [];
  for (let i = 0; i < settled.length; i++) {
    if (settled[i].status === 'fulfilled') {
      const data = settled[i].value;
      updateKnownModems(data);   // remember modems we've seen
      injectOfflineModems(data); // add back missing modems as offline
      results.push(data);
    } else {
      const srvName = apiServers[i].name;
      console.log(`[API] Server ${srvName} unreachable: ${settled[i].reason?.message || 'unknown'}`);
      // Try to use cached data
      const cached = getCachedDataAsOffline(srvName);
      if (cached) {
        injectOfflineModems(cached); // add back missing modems as offline
        results.push(cached);
      } else {
        console.log(`[API] No cache available for ${srvName}`);
      }
    }
  }
  return results;
}

function filterByPortName(data, portNameFilter) {
  const { bw, status, ports } = data;
  const allowedPortIds = new Set();
  const allowedImeis = new Set();
  let filteredBw = {};
  if (typeof bw === 'object') {
    for (const [portId, b] of Object.entries(bw)) {
      if (b.portName === portNameFilter) { filteredBw[portId] = b; allowedPortIds.add(portId); }
    }
  }
  if (ports && typeof ports === 'object') {
    for (const [imei, portList] of Object.entries(ports)) {
      if (Array.isArray(portList)) {
        for (const p of portList) { if (p.portID && allowedPortIds.has(p.portID)) allowedImeis.add(imei); }
      }
    }
  }
  let filteredStatus = [];
  if (Array.isArray(status)) {
    filteredStatus = status.filter(m => { const imei = m.modem_details?.IMEI; return imei && allowedImeis.has(imei); });
  }
  let filteredPorts = {};
  if (typeof ports === 'object') {
    for (const [imei, portList] of Object.entries(ports)) {
      if (allowedImeis.has(imei) && Array.isArray(portList)) {
        const filtered = portList.filter(p => allowedPortIds.has(p.portID));
        if (filtered.length > 0) filteredPorts[imei] = filtered;
      }
    }
  }
  return { bw: filteredBw, status: filteredStatus, ports: filteredPorts };
}

function mergeServerData(allData, portNameFilter) {
  const mergedBw = {}, mergedStatus = [], mergedPorts = {};
  const cachedServers = [];
  for (const data of allData) {
    const filtered = portNameFilter === '*' ? data : filterByPortName(data, portNameFilter);
    const prefix = data.serverName + '_';
    const isCached = !!data._cached;
    if (isCached) cachedServers.push({ name: data.serverName, cachedAt: data._cachedAt });
    for (const [portId, b] of Object.entries(filtered.bw)) {
      if (portId.startsWith('tg_') || (b.portName && b.portName.startsWith('tg_'))) continue; // skip Telegram bot ports
      mergedBw[prefix + portId] = { ...b, _server: data.serverName, _cached: isCached };
    }
    const statusArr = Array.isArray(filtered.status) ? filtered.status : [];
    for (const m of statusArr) {
      // Skip ghost entries from deleted ports (no STATE, no proxy_creds)
      if (!m.STATE || m.STATE === '?') continue;
      const entry = { ...m, _server: data.serverName };
      if (isCached) entry._cached = true;
      if (entry.modem_details && entry.modem_details.IMEI) {
        entry.modem_details = { ...entry.modem_details, IMEI: prefix + entry.modem_details.IMEI };
      }
      mergedStatus.push(entry);
    }
    const portsObj = typeof filtered.ports === 'object' ? filtered.ports : {};
    for (const [imei, portList] of Object.entries(portsObj)) {
      const prefixedImei = prefix + imei;
      const filteredPortList = portList.filter(p => !p.portID || (!p.portID.startsWith('tg_') && !(p.portName && p.portName.startsWith('tg_'))));
      const prefixedPorts = filteredPortList.map(p => ({ ...p, portID: p.portID ? prefix + p.portID : p.portID, _server: data.serverName, _cached: isCached }));
      if (prefixedPorts.length > 0) mergedPorts[prefixedImei] = (mergedPorts[prefixedImei] || []).concat(prefixedPorts);
    }
  }
  return { bandwidth: mergedBw, status: mergedStatus, ports: mergedPorts, modemLogins, cachedServers };
}

// ==================== IP TRACKING & UPTIME TRACKING ====================

const IP_TRACKING_FILE = path.join(__dirname, 'ip_tracking.json');
const UPTIME_TRACKING_FILE = path.join(__dirname, 'uptime_tracking.json');
const IP_HISTORY_FILE = path.join(__dirname, 'ip_history.json');
const MAX_IP_HISTORY = 100;

let ipTracking = {};
try {
  if (fs.existsSync(IP_TRACKING_FILE)) {
    ipTracking = JSON.parse(fs.readFileSync(IP_TRACKING_FILE, 'utf8'));
  }
} catch (e) { console.error('Failed to load ip_tracking:', e.message); }

let uptimeTracking = {};
try {
  if (fs.existsSync(UPTIME_TRACKING_FILE)) {
    uptimeTracking = JSON.parse(fs.readFileSync(UPTIME_TRACKING_FILE, 'utf8'));
  }
} catch (e) { console.error('Failed to load uptime_tracking:', e.message); }

let ipHistory = {};
try {
  if (fs.existsSync(IP_HISTORY_FILE)) {
    ipHistory = JSON.parse(fs.readFileSync(IP_HISTORY_FILE, 'utf8'));
  }
} catch (e) { console.error('Failed to load ip_history:', e.message); }

function saveIpTracking() {
  try { fs.writeFileSync(IP_TRACKING_FILE, JSON.stringify(ipTracking, null, 2)); }
  catch (e) { console.error('Failed to save ip_tracking:', e.message); }
}

function saveUptimeTracking() {
  try { fs.writeFileSync(UPTIME_TRACKING_FILE, JSON.stringify(uptimeTracking, null, 2)); }
  catch (e) { console.error('Failed to save uptime_tracking:', e.message); }
}

function saveIpHistory() {
  try { fs.writeFileSync(IP_HISTORY_FILE, JSON.stringify(ipHistory, null, 2)); }
  catch (e) { console.error('Failed to save ip_history:', e.message); }
}

function recordIpChange(key, oldIp, newIp, timestamp) {
  if (!ipHistory[key]) ipHistory[key] = [];
  const entries = ipHistory[key];
  // Close previous entry
  if (entries.length > 0) {
    const last = entries[entries.length - 1];
    if (!last.to) last.to = timestamp;
  }
  // Add new entry
  entries.push({ ip: newIp, from: timestamp, to: null });
  // Trim to MAX_IP_HISTORY
  if (entries.length > MAX_IP_HISTORY) {
    ipHistory[key] = entries.slice(-MAX_IP_HISTORY);
  }
}

// Combined tracking: IP changes + uptime percentage (runs every 10 min)
// Uptime fix: skip rotating/rebooting modems, skip unreachable servers
async function trackModems() {
  const now = Date.now();
  let totalTracked = 0;

  for (const server of apiServers) {
    let statusArr;
    try {
      const data = await fetchServerData(server);
      statusArr = Array.isArray(data.status) ? data.status : [];
    } catch (e) {
      // Server unreachable -- skip all modems on this server (don't count as offline)
      console.log(`[Tracking] Server ${server.name} unreachable, skipping: ${e.message}`);
      continue;
    }

    const prefix = server.name + '_';

    for (const m of statusArr) {
      const imei = m.modem_details?.IMEI;
      if (!imei) continue;
      const key = prefix + imei;
      const extIp = m.net_details?.EXT_IP || '';
      const isOnline = m.net_details?.IS_ONLINE === 'yes';
      const isRotating = m.IS_ROTATED === 'true' || m.IS_ROTATED === true;
      const isRebooting = m.IS_REBOOTING === 'true' || m.IS_REBOOTING === true;

      // IP tracking (always, regardless of status)
      if (extIp && extIp !== 'IP_RESET') {
        if (!ipTracking[key]) {
          ipTracking[key] = { ip: extIp, since: now };
          // Record initial IP in history
          recordIpChange(key, null, extIp, now);
        } else if (ipTracking[key].ip !== extIp) {
          // IP changed! Record in history with timestamp
          recordIpChange(key, ipTracking[key].ip, extIp, now);
          ipTracking[key] = { ip: extIp, since: now };
        }
        // else same IP -- keep existing `since`
      }

      // Uptime tracking -- skip if rotating, rebooting, or IP is resetting
      if (isRotating || isRebooting || extIp === 'IP_RESET' || extIp === '') {
        continue;
      }

      if (!uptimeTracking[key]) {
        uptimeTracking[key] = { total_checks: 0, online_checks: 0, first_check: now, consecutive_failures: 0 };
      }
      if (!uptimeTracking[key].consecutive_failures) uptimeTracking[key].consecutive_failures = 0;

      if (isOnline) {
        // Online: reset consecutive failures, count as online
        uptimeTracking[key].consecutive_failures = 0;
        uptimeTracking[key].total_checks++;
        uptimeTracking[key].online_checks++;
      } else {
        // Offline: increment consecutive failures
        uptimeTracking[key].consecutive_failures++;
        // Only count as downtime after 3 consecutive failures
        if (uptimeTracking[key].consecutive_failures >= 3) {
          uptimeTracking[key].total_checks++;
          // don't increment online_checks = counts as downtime
        } else {
          // Less than 3 failures: still count as online (100%)
          uptimeTracking[key].total_checks++;
          uptimeTracking[key].online_checks++;
        }
      }
      totalTracked++;
    }
  }

  saveIpTracking();
  saveUptimeTracking();
  saveIpHistory();
  console.log(`[Tracking] Updated IP & uptime for ${Object.keys(ipTracking).length} modems (${totalTracked} uptime checks)`);

  // Daily traffic snapshot: capture "yesterday" data once per day
  await captureDailyTrafficSnapshot();
}

async function captureDailyTrafficSnapshot() {
  // Use Moscow timezone for date to match billing
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Moscow' }); // YYYY-MM-DD
  if (lastDailyTrafficDate === today) return; // already captured today

  console.log(`[DailyTraffic] Capturing snapshot for today=${today}...`);

  try {
    const results = await fetchAllServersData();
    const merged = mergeServerData(results, '*');
    const bw = merged.bandwidth || {};
    let captured = 0;

    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayStr = yesterday.toLocaleDateString('en-CA', { timeZone: 'Europe/Moscow' });

    for (const [portId, b] of Object.entries(bw)) {
      const pn = b.portName || '';
      if (pn.startsWith('tg_') || portId.startsWith('tg_')) continue;

      // Key by portId (each modem separately)
      if (!dailyTraffic[portId]) dailyTraffic[portId] = {};

      // Save yesterday's traffic
      const yIn = parseTrafficValue(b.bandwidth_bytes_yesterday_in);
      const yOut = parseTrafficValue(b.bandwidth_bytes_yesterday_out);
      if ((yIn > 0 || yOut > 0) && !dailyTraffic[portId][yesterdayStr]) {
        dailyTraffic[portId][yesterdayStr] = { in: yIn, out: yOut, portName: pn };
        captured++;
      }
    }

    // Prune: keep only last 365 days
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 366);
    const cutoffStr = cutoff.toLocaleDateString('en-CA', { timeZone: 'Europe/Moscow' });
    for (const pid of Object.keys(dailyTraffic)) {
      for (const d of Object.keys(dailyTraffic[pid])) {
        if (d < cutoffStr) delete dailyTraffic[pid][d];
      }
      if (Object.keys(dailyTraffic[pid]).length === 0) delete dailyTraffic[pid];
    }

    lastDailyTrafficDate = today;
    saveDailyTraffic();
    console.log(`[DailyTraffic] Captured ${captured} port snapshots for ${yesterdayStr} (${Object.keys(bw).length} ports total)`);
  } catch (e) {
    console.error('[DailyTraffic] Error:', e.message);
  }
}

// ==================== SPEEDTEST HISTORY ====================

const SPEEDTEST_HISTORY_FILE = path.join(__dirname, 'speedtest_history.json');
const MAX_SPEEDTEST_ENTRIES = 30;

let speedtestHistory = {};
try {
  if (fs.existsSync(SPEEDTEST_HISTORY_FILE)) {
    speedtestHistory = JSON.parse(fs.readFileSync(SPEEDTEST_HISTORY_FILE, 'utf8'));
  }
} catch (e) { console.error('Failed to load speedtest_history:', e.message); }

function saveSpeedtestHistory() {
  try { fs.writeFileSync(SPEEDTEST_HISTORY_FILE, JSON.stringify(speedtestHistory, null, 2)); }
  catch (e) { console.error('Failed to save speedtest_history:', e.message); }
}

let speedtestRunning = false;

async function runNightlySpeedtests() {
  if (speedtestRunning) {
    console.log('[Speedtest] Already running, skipping...');
    return;
  }
  speedtestRunning = true;
  console.log('[Speedtest] Starting speedtest run...');
  let testedCount = 0, errorCount = 0;

  try {
    for (const server of apiServers) {
      try {
        const statusData = await fetchApi(server, '/apix/show_status_json');
        const modems = Array.isArray(statusData) ? statusData : [];
        console.log(`[Speedtest] ${server.name}: ${modems.length} modems to test`);

        for (const m of modems) {
          const nick = m.modem_details?.NICK;
          const imei = m.modem_details?.IMEI;
          const isOnline = m.net_details?.IS_ONLINE === 'yes';
          if (!nick || !imei || !isOnline) continue;

          const key = server.name + '_' + imei;
          try {
            console.log(`[Speedtest] Testing ${nick} (${server.name})...`);
            const result = await fetchApi(server, `/apix/speedtest?arg=${encodeURIComponent(nick)}`, 180000);

            let dl = 0, ul = 0, ping = 0;
            if (result && typeof result === 'object') {
              dl = parseFloat(result.download || result.Download || result.dl || 0);
              ul = parseFloat(result.upload || result.Upload || result.ul || 0);
              ping = parseFloat(result.ping || result.Ping || result.latency || 0);
              if (result.raw && typeof result.raw === 'string') {
                const dlMatch = result.raw.match(/download[:\s]*([\d.]+)/i);
                const ulMatch = result.raw.match(/upload[:\s]*([\d.]+)/i);
                const pingMatch = result.raw.match(/ping[:\s]*([\d.]+)/i);
                if (dlMatch) dl = parseFloat(dlMatch[1]);
                if (ulMatch) ul = parseFloat(ulMatch[1]);
                if (pingMatch) ping = parseFloat(pingMatch[1]);
              }
            }

            const entry = {
              date: new Date().toISOString(),
              download: dl,
              upload: ul,
              ping: ping,
              raw: result
            };

            // Re-test if DL or UL is below 1 Mbps
            if ((dl < 1 || ul < 1)) {
              console.log(`[Speedtest] ${nick}: DL=${dl} UL=${ul} — near-zero detected, re-testing in 10 min...`);
              setTimeout(async () => {
                try {
                  console.log(`[Speedtest] Re-testing ${nick} (${server.name})...`);
                  const retryResult = await fetchApi(server, `/apix/speedtest?arg=${encodeURIComponent(nick)}`, 180000);
                  let rdl = 0, rul = 0, rping = 0;
                  if (retryResult && typeof retryResult === 'object') {
                    rdl = parseFloat(retryResult.download || retryResult.Download || retryResult.dl || 0);
                    rul = parseFloat(retryResult.upload || retryResult.Upload || retryResult.ul || 0);
                    rping = parseFloat(retryResult.ping || retryResult.Ping || retryResult.latency || 0);
                    if (retryResult.raw && typeof retryResult.raw === 'string') {
                      const rdlM = retryResult.raw.match(/download[:\s]*([\d.]+)/i);
                      const rulM = retryResult.raw.match(/upload[:\s]*([\d.]+)/i);
                      const rpM = retryResult.raw.match(/ping[:\s]*([\d.]+)/i);
                      if (rdlM) rdl = parseFloat(rdlM[1]);
                      if (rulM) rul = parseFloat(rulM[1]);
                      if (rpM) rping = parseFloat(rpM[1]);
                    }
                  }
                  // Use retry result if better
                  if (rdl + rul > dl + ul) {
                    const retryEntry = { date: new Date().toISOString(), download: rdl, upload: rul, ping: rping, raw: retryResult, retry: true, ...(rdl < 1 || rul < 1 ? { _lowSpeed: true } : {}) };
                    if (!speedtestHistory[key]) speedtestHistory[key] = [];
                    speedtestHistory[key].push(retryEntry);
                    if (speedtestHistory[key].length > MAX_SPEEDTEST_ENTRIES) speedtestHistory[key] = speedtestHistory[key].slice(-MAX_SPEEDTEST_ENTRIES);
                    saveSpeedtestHistory();
                    console.log(`[Speedtest] Re-test ${nick}: DL=${rdl} UL=${rul} (improved)`);
                  } else {
                    console.log(`[Speedtest] Re-test ${nick}: DL=${rdl} UL=${rul} (not improved)`);
                  }
                } catch (e) { console.error(`[Speedtest] Re-test ${nick} error:`, e.message); }
              }, 10 * 60 * 1000);
            }

            if (!speedtestHistory[key]) speedtestHistory[key] = [];
            speedtestHistory[key].push(entry);
            if (speedtestHistory[key].length > MAX_SPEEDTEST_ENTRIES) {
              speedtestHistory[key] = speedtestHistory[key].slice(-MAX_SPEEDTEST_ENTRIES);
            }
            saveSpeedtestHistory();
            testedCount++;
            console.log(`[Speedtest] ${nick}: DL=${dl} UL=${ul} Ping=${ping}`);
          } catch (e) {
            console.error(`[Speedtest] Error testing ${nick}:`, e.message);
            errorCount++;
          }

          await new Promise(r => setTimeout(r, 2000));
        }
      } catch (e) {
        console.error(`[Speedtest] Error on server ${server.name}:`, e.message);
        errorCount++;
      }
    }
  } finally {
    speedtestRunning = false;
  }

  console.log(`[Speedtest] Complete: ${testedCount} tested, ${errorCount} errors`);
}

function getSpeedtestLatest() {
  const latest = {};
  for (const [key, entries] of Object.entries(speedtestHistory)) {
    if (entries.length > 0) {
      const last = entries[entries.length - 1];
      latest[key] = { download: last.download, upload: last.upload, ping: last.ping, date: last.date, ...(last._lowSpeed ? { _lowSpeed: true } : {}) };
    }
  }
  return latest;
}

// ==================== CLIENT DASHBOARD API ====================

app.get('/api/dashboard_data', authMiddleware, async (req, res) => {
  try {
    const results = await fetchAllServersData();
    const merged = mergeServerData(results, req.user.portNameFilter);
    const clientInfo = clients.find(c => c.login === req.user.login);
    if (clientInfo) {
      const totalPayments = (clientInfo.payments || []).reduce((sum, p) => sum + (parseFloat(p.amount) || 0), 0);
      // Current month expense from billing ledger
      const ledgerEntries = billingLedger[clientInfo.id] || [];
      const currentMonthPrefix = new Date().toISOString().slice(0, 7);
      const monthExpense = ledgerEntries
        .filter(e => e.type === 'charge' && e.date && e.date.startsWith(currentMonthPrefix))
        .reduce((sum, e) => sum + (e.cost || 0), 0);

      merged.billing = {
        billingType: clientInfo.billingType || 'per_gb',
        price: clientInfo.price || 0,
        currency: clientInfo.currency || 'RUB',
        totalPayments,
        balance: clientInfo.balance !== undefined ? clientInfo.balance : totalPayments,
        monthExpense: Math.round(monthExpense * 100) / 100,
        apiKey: clientInfo.apiKey || ''
      };
    }

    // Include tracking data filtered for this user's modems
    if (req.user.portNameFilter !== '*') {
      const filteredIpTracking = {};
      const filteredUptimeTracking = {};
      const filteredSpeedtest = {};
      const filteredIpHistory = {};
      const speedLatest = getSpeedtestLatest();

      const clientImeis = new Set();
      for (const imei of Object.keys(merged.ports)) {
        clientImeis.add(imei);
      }

      for (const imei of clientImeis) {
        if (ipTracking[imei]) filteredIpTracking[imei] = ipTracking[imei];
        if (uptimeTracking[imei]) filteredUptimeTracking[imei] = uptimeTracking[imei];
        if (speedLatest[imei]) filteredSpeedtest[imei] = speedLatest[imei];
        if (ipHistory[imei]) filteredIpHistory[imei] = ipHistory[imei];
      }

      merged.ipTracking = filteredIpTracking;
      merged.uptimeTracking = filteredUptimeTracking;
      merged.speedtestLatest = filteredSpeedtest;
      merged.ipHistory = filteredIpHistory;
    }

    res.json(merged);
  } catch (err) {
    res.status(502).json({ error: 'API request failed', details: err.message });
  }
});

// ==================== CLIENT: DAILY TRAFFIC HISTORY ====================

app.get('/api/client/daily_traffic', authMiddleware, async (req, res) => {
  const clientInfo = clients.find(c => c.login === req.user.login);
  if (!clientInfo) return res.status(404).json({ error: 'Client not found' });

  const portNameFilter = clientInfo.portName || req.user.portNameFilter;
  const fromDate = req.query.from || '';
  const toDate = req.query.to || '';
  const includeToday = req.query.include_today === '1';
  const result = {};

  // Collect daily traffic for ports matching this client's portName
  for (const [portId, days] of Object.entries(dailyTraffic)) {
    let match = false;
    if (portNameFilter === '*') {
      match = true;
    } else {
      const firstDay = Object.values(days)[0];
      if (firstDay && firstDay.portName === portNameFilter) match = true;
    }
    if (match) {
      // Filter by date range
      const filtered = {};
      for (const [d, entry] of Object.entries(days)) {
        if (fromDate && d < fromDate) continue;
        if (toDate && d > toDate) continue;
        filtered[d] = entry;
      }
      if (Object.keys(filtered).length > 0) {
        result[portId] = filtered;
      }
    }
  }

  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Moscow' });

  if (includeToday) {
    // Add today's live data from ProxySmart
    try {
      const results = await fetchAllServersData();
      const merged = mergeServerData(results, portNameFilter);
      const todayData = {};
      for (const [portId, b] of Object.entries(merged.bandwidth || {})) {
        const dIn = parseTrafficValue(b.bandwidth_bytes_day_in);
        const dOut = parseTrafficValue(b.bandwidth_bytes_day_out);
        if (dIn > 0 || dOut > 0) {
          todayData[portId] = { in: dIn, out: dOut, portName: b.portName || '' };
        }
      }
      res.json({ daily: result, today: todayData, todayDate: today });
    } catch (err) {
      res.json({ daily: result, today: {}, todayDate: today });
    }
  } else {
    res.json({ daily: result, today: {}, todayDate: today });
  }
});

// ==================== CLIENT: BILLING HISTORY ====================

app.get('/api/billing_history', authMiddleware, (req, res) => {
  const clientInfo = clients.find(c => c.login === req.user.login);
  if (!clientInfo) return res.status(404).json({ error: 'Client not found' });

  const entries = billingLedger[clientInfo.id] || [];

  // Optional filters
  const { month, limit: limitStr } = req.query;
  let filtered = entries;

  // Filter by month (e.g. "2026-02")
  if (month) {
    filtered = filtered.filter(e => e.date && e.date.startsWith(month));
  }

  // Sort newest first
  filtered = filtered.slice().sort((a, b) => (b.timestamp || b.date || '').localeCompare(a.timestamp || a.date || ''));

  // Limit results
  const limit = parseInt(limitStr) || 200;
  filtered = filtered.slice(0, limit);

  // Summary: payments, charges, adjustments
  const allEntries = entries;
  const totalCharges = allEntries.filter(e => e.type === 'charge').reduce((sum, e) => sum + (e.cost || 0), 0);
  const totalPayments = allEntries.filter(e => e.type === 'payment').reduce((sum, e) => sum + (e.amount || 0), 0);

  // Current month summary
  const currentMonthPrefix = new Date().toISOString().slice(0, 7);
  const monthCharges = allEntries
    .filter(e => e.type === 'charge' && e.date && e.date.startsWith(currentMonthPrefix))
    .reduce((sum, e) => sum + (e.cost || 0), 0);

  res.json({
    balance: clientInfo.balance,
    currency: clientInfo.currency || 'RUB',
    summary: {
      totalCharges: Math.round(totalCharges * 100) / 100,
      totalPayments: Math.round(totalPayments * 100) / 100,
      monthCharges: Math.round(monthCharges * 100) / 100
    },
    entries: filtered
  });
});

// ==================== CLIENT: IP RESET (non-admin) ====================

app.post('/api/client/reset_ip', authMiddleware, async (req, res) => {
  try {
    const { imei, serverName } = req.body;
    if (!imei || !serverName) return res.status(400).json({ error: 'imei and serverName required' });
    const server = findServer(serverName);
    if (!server) return res.status(400).json({ error: 'Server not found' });
    const result = await fetchApi(server, `/apix/reset_modem_by_imei?IMEI=${encodeURIComponent(imei)}`);
    const success = result && result.result === 'success';
    if (success) {
      res.json({ ok: true, result });
    } else {
      res.json({ ok: false, error: result?.message || 'Reset failed', result });
    }
  } catch (err) { res.status(502).json({ ok: false, error: 'Reset failed', details: err.message }); }
});

// ==================== CLIENT: TOKEN-BASED IP RESET (public, no session) ====================

app.get('/api/client/reset_ip_by_token', async (req, res) => {
  const { nick, token } = req.query;
  if (!nick || !token) return res.status(400).json({ error: 'nick and token required' });
  const client = clients.find(c => c.resetToken === token);
  if (!client) return res.status(401).json({ error: 'Invalid token' });
  // Try all servers
  for (const server of apiServers) {
    try {
      const result = await fetchApi(server, `/apix/reset_modem?arg=${encodeURIComponent(nick)}`);
      if (result) return res.json({ ok: true, result });
    } catch (e) { /* try next server */ }
  }
  res.status(404).json({ error: 'Modem not found' });
});

// ==================== CLIENT: ROTATION LOG ====================

app.get('/api/client/rotation_log', authMiddleware, async (req, res) => {
  try {
    const { nick, serverName } = req.query;
    if (!nick || !serverName) return res.status(400).json({ error: 'nick and serverName required' });
    const server = findServer(serverName);
    if (!server) return res.status(400).json({ error: 'Server not found' });
    const result = await fetchApi(server, `/apix/get_rotation_log?arg=${encodeURIComponent(nick)}`);
    res.json(result);
  } catch (err) { res.status(502).json({ error: 'Failed', details: err.message }); }
});

// ==================== CLIENT: IP HISTORY ====================

app.get('/api/client/ip_history', authMiddleware, (req, res) => {
  const { key } = req.query;
  if (!key) return res.status(400).json({ error: 'key required' });
  res.json(ipHistory[key] || []);
});

// ==================== CLIENT: CREDENTIALS EXPORT ====================

app.get('/api/client/credentials_export', authMiddleware, async (req, res) => {
  try {
    const results = await fetchAllServersData();
    const merged = mergeServerData(results, req.user.portNameFilter);

    const COUNTRIES = { S1: { serverIp: '89.149.100.92' }, S2: { serverIp: '31.5.194.89' } };
    // Build server URL map for direct reset URLs
    const credentials = [];

    for (const [imei, portList] of Object.entries(merged.ports)) {
      const serverName = imei.startsWith('S1_') ? 'S1' : imei.startsWith('S2_') ? 'S2' : '';
      const ci = COUNTRIES[serverName] || {};
      let modemNick = imei;
      for (const m of merged.status) {
        if (m.modem_details?.IMEI === imei) {
          modemNick = m.modem_details.NICK || imei;
          break;
        }
      }
      for (const p of portList) {
        if (p.LOGIN && p.PASSWORD) {
          credentials.push({
            modem: modemNick,
            server: serverName,
            serverIp: ci.serverIp || '',
            httpPort: p.HTTP_PORT || '',
            socksPort: p.SOCKS_PORT || '',
            login: p.LOGIN,
            password: p.PASSWORD,
            httpProxy: ci.serverIp ? `${ci.serverIp}:${p.HTTP_PORT}` : '',
            socks5Proxy: ci.serverIp ? `${ci.serverIp}:${p.SOCKS_PORT}` : '',
            httpCreds: p.http_creds || '',
            socks5Creds: p.socks5_creds || '',
            resetUrl: p.RESET_SECURE_LINK?.URL || ''
          });
        }
      }
    }

    // Also include server info so frontend can build direct URLs
    const serverInfo = {};
    for (const s of apiServers) {
      const urlObj = new URL(s.url);
      serverInfo[s.name] = { url: s.url, user: s.user, pass: s.pass, host: urlObj.host };
    }

    const clientInfo = clients.find(c => c.login === req.user.login);
    res.json({
      credentials,
      clientName: req.user.login,
      exportDate: new Date().toISOString(),
      resetToken: clientInfo ? clientInfo.resetToken : '',
      serverInfo
    });
  } catch (err) { res.status(502).json({ error: 'Export failed', details: err.message }); }
});

// ==================== CLIENT: REFERRAL PROGRAM ====================

app.get('/api/client/referral', authMiddleware, (req, res) => {
  const client = clients.find(c => c.login === req.user.login);
  if (!client) return res.status(404).json({ error: 'Client not found' });
  const referrals = clients.filter(c => c.referred_by === client.id);
  res.json({
    referrals_count: referrals.length,
    referral_balance: client.referral_balance || 0,
    referrals: referrals.map(r => ({ name: r.name, createdAt: r.createdAt }))
  });
});

// ==================== CLIENT: DOCUMENTS ====================

app.get('/api/client/documents', authMiddleware, (req, res) => {
  const client = clients.find(c => c.login === req.user.login);
  if (!client) return res.json([]);
  res.json((client.documents || []).map(d => ({ id: d.id, name: d.name, date: d.date })));
});

app.get('/api/client/documents/:docId/download', authMiddleware, (req, res) => {
  const client = clients.find(c => c.login === req.user.login);
  if (!client) return res.status(404).json({ error: 'Not found' });
  const doc = (client.documents || []).find(d => d.id === req.params.docId);
  if (!doc) return res.status(404).json({ error: 'Document not found' });
  const filePath = path.join(DOCUMENTS_DIR, doc.fileName);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });
  res.download(filePath, doc.name);
});

// ==================== CORS for Public API (Bug #6) ====================
app.use('/api/v1', (req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'X-API-Key, Content-Type');
  res.header('Access-Control-Max-Age', '86400');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }
  next();
});

// ==================== PUBLIC: PROXY API v2 (Evomi-style, apiKey via header or query) ====================

app.get('/api/v1/proxy', async (req, res) => {
  const apiKey = req.headers['x-api-key'] || req.query.apikey;
  if (!apiKey) return res.status(401).json({ success: false, error: 'API key required. Pass via X-API-Key header or ?apikey= query parameter.' });

  const client = clients.find(c => c.apiKey === apiKey);
  if (!client) return res.status(401).json({ success: false, error: 'Invalid API key' });

  try {
    const results = await fetchAllServersData();
    const merged = mergeServerData(results, client.portName);

    const COUNTRIES = { S1: { serverIp: '89.149.100.92', country: 'MD', name: 'Moldova' }, S2: { serverIp: '31.5.194.89', country: 'RO', name: 'Romania' } };

    const proxies = [];
    for (const [imei, portList] of Object.entries(merged.ports)) {
      const serverName = imei.startsWith('S1_') ? 'S1' : imei.startsWith('S2_') ? 'S2' : '';
      const ci = COUNTRIES[serverName] || {};
      let modemNick = imei;
      let operator = '', isOnline = false;
      for (const m of merged.status) {
        if (m.modem_details?.IMEI === imei) {
          modemNick = m.modem_details.NICK || imei;
          operator = m.net_details?.CELLOP || '';
          isOnline = m.net_details?.IS_ONLINE === 'yes';
          break;
        }
      }
      for (const p of portList) {
        if (p.LOGIN && p.PASSWORD && ci.serverIp) {
          // Use RESET_SECURE_LINK from port data (direct modem server URL)
          const changeIpUrl = p.RESET_SECURE_LINK?.URL || '';
          proxies.push({
            id: modemNick,
            host: ci.serverIp,
            ports: { http: parseInt(p.HTTP_PORT) || 0, socks5: parseInt(p.SOCKS_PORT) || 0 },
            username: p.LOGIN,
            password: p.PASSWORD,
            country: ci.country || '',
            country_name: ci.name || '',
            operator,
            online: isOnline,
            change_ip_url: changeIpUrl
          });
        }
      }
    }

    // Billing
    const clientInfo = clients.find(c => c.login === client.login);
    const totalPayments = clientInfo ? (clientInfo.payments || []).reduce((s, p) => s + (parseFloat(p.amount) || 0), 0) : 0;

    // Bandwidth totals (in MB)
    let monthMb = 0;
    const parseToMb = (str) => {
      if (!str || str === 0) return 0;
      const s = String(str);
      const m = s.match(/([\d.]+)\s*(TB|GB|MB|KB|B)?/i);
      if (!m) return 0;
      const val = parseFloat(m[1]);
      const u = (m[2] || '').toUpperCase();
      if (u === 'TB') return val * 1024 * 1024;
      if (u === 'GB') return val * 1024;
      if (u === 'MB') return val;
      if (u === 'KB') return val / 1024;
      return 0; // no unit = likely 0
    };
    for (const b of Object.values(merged.bandwidth)) {
      monthMb += parseToMb(b.bandwidth_bytes_month_in);
      monthMb += parseToMb(b.bandwidth_bytes_month_out);
    }

    res.json({
      success: true,
      client: client.name,
      billing: {
        type: clientInfo?.billingType || 'per_gb',
        price_per_gb: clientInfo?.price || 0,
        currency: clientInfo?.currency || 'RUB',
        balance: clientInfo?.balance !== undefined ? clientInfo.balance : totalPayments,
        usage_mb: Math.round(monthMb)
      },
      proxies,
      proxy_count: proxies.length
    });
  } catch (err) {
    res.status(502).json({ success: false, error: 'Failed to fetch proxy data' });
  }
});

// ==================== PUBLIC: PROXY API v1 (legacy, kept for backward compat) ====================

app.get('/api/v1/proxies', async (req, res) => {
  const { apiKey, format } = req.query;
  if (!apiKey) return res.status(400).json({ error: 'apiKey required' });

  const client = clients.find(c => c.apiKey === apiKey);
  if (!client) return res.status(401).json({ error: 'Invalid API key' });

  try {
    const results = await fetchAllServersData();
    const merged = mergeServerData(results, client.portName);

    const COUNTRIES = { S1: { serverIp: '89.149.100.92' }, S2: { serverIp: '31.5.194.89' } };
    const proxies = [];

    for (const [imei, portList] of Object.entries(merged.ports)) {
      const serverName = imei.startsWith('S1_') ? 'S1' : imei.startsWith('S2_') ? 'S2' : '';
      const ci = COUNTRIES[serverName] || {};
      let modemNick = imei;
      for (const m of merged.status) {
        if (m.modem_details?.IMEI === imei) { modemNick = m.modem_details.NICK || imei; break; }
      }
      for (const p of portList) {
        if (p.LOGIN && p.PASSWORD && ci.serverIp) {
          proxies.push({
            modem: modemNick,
            ip: ci.serverIp,
            httpPort: parseInt(p.HTTP_PORT) || 0,
            socksPort: parseInt(p.SOCKS_PORT) || 0,
            login: p.LOGIN,
            password: p.PASSWORD,
            resetUrl: p.RESET_SECURE_LINK?.URL || ''
          });
        }
      }
    }

    const fmt = (format || 'json').toLowerCase();
    if (fmt === 'txt') {
      const lines = proxies.map(p => `${p.ip}:${p.httpPort}:${p.login}:${p.password}|${p.resetUrl}`);
      res.type('text/plain').send(lines.join('\n'));
    } else if (fmt === 'csv') {
      const lines = ['ip,http_port,socks_port,login,password,reset_url'];
      proxies.forEach(p => lines.push([p.ip, p.httpPort, p.socksPort, p.login, p.password, p.resetUrl].join(',')));
      res.type('text/csv').send(lines.join('\n'));
    } else {
      res.json({ proxies, count: proxies.length, client: client.name });
    }
  } catch (err) {
    res.status(502).json({ error: 'Failed to fetch proxy data' });
  }
});

// ==================== ADMIN: FULL DATA ====================

app.get('/api/admin/data', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const results = await fetchAllServersData();
    const merged = mergeServerData(results, '*');
    const servers = apiServers.map(s => ({ name: s.name, url: s.url }));
    // Include server auth info for direct reset URLs
    const serverAuth = {};
    for (const s of apiServers) {
      const urlObj = new URL(s.url);
      serverAuth[s.name] = { user: s.user, pass: s.pass, host: urlObj.host, protocol: urlObj.protocol };
    }
    res.json({
      ...merged,
      servers,
      serverAuth,
      clients,
      billingLedger,
      ipTracking,
      uptimeTracking,
      speedtestLatest: getSpeedtestLatest(),
      ipHistory,
      settings: appSettings,
      telegramUsers: tgUsers,
      telegramProxies: tgProxies,
      telegramFeedback: tgFeedback,
      bankPayments: bankPayments,
      tochkaConfigured: !!tochkaConfig.jwt,
      tochkaConfig: { jwt: tochkaConfig.jwt ? '****' + tochkaConfig.jwt.slice(-8) : '', clientId: tochkaConfig.clientId, customerCode: tochkaConfig.customerCode, accountId: tochkaConfig.accountId, companyName: tochkaConfig.companyName, companyInn: tochkaConfig.companyInn, companyKpp: tochkaConfig.companyKpp }
    });
  } catch (err) {
    res.status(502).json({ error: 'API request failed', details: err.message });
  }
});

// ==================== ADMIN: CLIENT MANAGEMENT ====================

app.get('/api/admin/clients', authMiddleware, adminMiddleware, (req, res) => {
  res.json(clients);
});

app.post('/api/admin/clients', authMiddleware, adminMiddleware, (req, res) => {
  const { name, portName, login, password, contact, notes, billingType, price, currency, referred_by, inn, kpp, legalName, contractInfo, address } = req.body;
  if (!name || !portName || !login || !password) {
    return res.status(400).json({ error: 'name, portName, login, password required' });
  }
  if (users[login]) {
    return res.status(400).json({ error: 'Login already exists: ' + login });
  }
  const client = {
    id: generateId(),
    name, portName, login, password,
    contact: contact || '',
    notes: notes || '',
    billingType: billingType || 'per_gb',
    price: parseFloat(price) || 0,
    currency: currency || 'RUB',
    payments: [],
    apiKey: 'prx_' + crypto.randomBytes(24).toString('hex'),
    referral_code: 'REF-' + crypto.randomBytes(4).toString('hex').toUpperCase(),
    referred_by: null,
    referral_balance: 0,
    resetToken: crypto.randomBytes(16).toString('hex'),
    documents: [],
    balance: 0,
    last_traffic_snapshot: { timestamp: null, month_bytes: 0 },
    inn: inn || '',
    kpp: kpp || '',
    legalName: legalName || '',
    contractInfo: contractInfo || '',
    address: address || '',
    closingDocuments: [],
    bills: [],
    createdAt: new Date().toISOString()
  };

  // Handle referral: if referred_by code is provided
  if (referred_by) {
    const referrer = clients.find(c => c.referral_code === referred_by);
    if (referrer) {
      client.referred_by = referrer.id;
    }
  }

  clients.push(client);
  saveClients(clients);
  users[login] = { password, portNameFilter: portName, source: 'client', clientId: client.id };
  res.json({ ok: true, client });
});

app.put('/api/admin/clients/:id', authMiddleware, adminMiddleware, (req, res) => {
  const idx = clients.findIndex(c => c.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Client not found' });
  const old = clients[idx];
  const { name, portName, login, password, contact, notes, billingType, price, currency, inn, kpp, legalName, contractInfo, address } = req.body;
  if (login && login !== old.login) {
    if (users[login]) return res.status(400).json({ error: 'Login already exists: ' + login });
    delete users[old.login];
  }
  const updated = {
    ...old,
    name: name || old.name,
    portName: portName || old.portName,
    login: login || old.login,
    password: password || old.password,
    contact: contact !== undefined ? contact : old.contact,
    notes: notes !== undefined ? notes : old.notes,
    billingType: billingType !== undefined ? billingType : (old.billingType || 'per_gb'),
    price: price !== undefined ? parseFloat(price) : (old.price || 0),
    currency: currency !== undefined ? currency : (old.currency || 'RUB'),
    inn: inn !== undefined ? inn : (old.inn || ''),
    kpp: kpp !== undefined ? kpp : (old.kpp || ''),
    legalName: legalName !== undefined ? legalName : (old.legalName || ''),
    contractInfo: contractInfo !== undefined ? contractInfo : (old.contractInfo || ''),
    address: address !== undefined ? address : (old.address || '')
  };
  clients[idx] = updated;
  saveClients(clients);
  users[updated.login] = { password: updated.password, portNameFilter: updated.portName, source: 'client', clientId: updated.id };
  res.json({ ok: true, client: updated });
});

// DELETE client -- with port protection
app.delete('/api/admin/clients/:id', authMiddleware, adminMiddleware, async (req, res) => {
  const idx = clients.findIndex(c => c.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Client not found' });

  const client = clients[idx];

  try {
    const results = await fetchAllServersData();
    let hasActivePorts = false;
    for (const data of results) {
      if (typeof data.bw === 'object') {
        for (const [portId, b] of Object.entries(data.bw)) {
          if (b.portName === client.portName) { hasActivePorts = true; break; }
        }
      }
      if (hasActivePorts) break;
    }

    if (hasActivePorts) {
      return res.status(400).json({
        error: `Нельзя удалить: у клиента есть активные порты (portName: ${client.portName}). Сначала закройте все порты.`
      });
    }
  } catch (e) {
    console.warn('[DeleteClient] Could not verify ports, proceeding with deletion:', e.message);
  }

  const removed = clients.splice(idx, 1)[0];
  saveClients(clients);
  delete users[removed.login];
  for (const [token, sess] of Object.entries(sessions)) {
    if (sess.login === removed.login) delete sessions[token];
  }
  saveSessions();
  res.json({ ok: true });
});

// ==================== ADMIN: PAYMENTS ====================

app.post('/api/admin/clients/:id/payment', authMiddleware, adminMiddleware, (req, res) => {
  const idx = clients.findIndex(c => c.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Client not found' });
  const { amount, date, note } = req.body;
  if (!amount || !date) return res.status(400).json({ error: 'amount and date required' });
  if (!clients[idx].payments) clients[idx].payments = [];
  clients[idx].payments.push({
    amount: parseFloat(amount),
    date,
    note: note || '',
    createdAt: new Date().toISOString()
  });

  // Update persistent balance
  const paymentAmount = parseFloat(amount);
  const balanceBefore = clients[idx].balance || 0;
  clients[idx].balance = Math.round((balanceBefore + paymentAmount) * 100) / 100;

  // Ledger entry for payment
  const ledgerKey = clients[idx].id;
  if (!billingLedger[ledgerKey]) billingLedger[ledgerKey] = [];
  billingLedger[ledgerKey].push({
    type: 'payment',
    date: date,
    timestamp: new Date().toISOString(),
    amount: paymentAmount,
    currency: clients[idx].currency || 'RUB',
    balance_before: balanceBefore,
    balance_after: clients[idx].balance,
    note: note || 'Пополнение баланса'
  });

  // Referral: credit 15% to referrer
  if (clients[idx].referred_by) {
    const referrer = clients.find(c => c.id === clients[idx].referred_by);
    if (referrer) {
      const commission = paymentAmount * 0.15;
      referrer.referral_balance = (referrer.referral_balance || 0) + commission;
      console.log(`[Referral] Credited ${commission.toFixed(2)} to ${referrer.name} (15% of ${amount})`);
    }
  }

  saveClients(clients);
  saveBillingLedger();
  res.json({ ok: true, payments: clients[idx].payments, balance: clients[idx].balance });
});

app.get('/api/admin/clients/:id/payments', authMiddleware, adminMiddleware, (req, res) => {
  const client = clients.find(c => c.id === req.params.id);
  if (!client) return res.status(404).json({ error: 'Client not found' });
  res.json(client.payments || []);
});

app.delete('/api/admin/clients/:id/payment/:index', authMiddleware, adminMiddleware, (req, res) => {
  const idx = clients.findIndex(c => c.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Client not found' });
  const payIdx = parseInt(req.params.index);
  if (!clients[idx].payments || payIdx < 0 || payIdx >= clients[idx].payments.length) {
    return res.status(400).json({ error: 'Invalid payment index' });
  }
  const deletedPayment = clients[idx].payments[payIdx];
  const deletedAmount = parseFloat(deletedPayment.amount) || 0;
  clients[idx].payments.splice(payIdx, 1);

  // Update persistent balance
  const balanceBefore = clients[idx].balance || 0;
  clients[idx].balance = Math.round((balanceBefore - deletedAmount) * 100) / 100;

  // Ledger entry for reversal
  const ledgerKey = clients[idx].id;
  if (!billingLedger[ledgerKey]) billingLedger[ledgerKey] = [];
  billingLedger[ledgerKey].push({
    type: 'payment_reversal',
    date: new Date().toISOString().slice(0, 10),
    timestamp: new Date().toISOString(),
    amount: -deletedAmount,
    currency: clients[idx].currency || 'RUB',
    balance_before: balanceBefore,
    balance_after: clients[idx].balance,
    note: 'Отмена оплаты администратором'
  });

  saveClients(clients);
  saveBillingLedger();
  res.json({ ok: true, payments: clients[idx].payments, balance: clients[idx].balance });
});

// ==================== ADMIN: BILLING LEDGER ====================

app.get('/api/admin/clients/:id/ledger', authMiddleware, adminMiddleware, (req, res) => {
  const client = clients.find(c => c.id === req.params.id);
  if (!client) return res.status(404).json({ error: 'Client not found' });
  const entries = billingLedger[client.id] || [];
  res.json({
    balance: client.balance,
    last_snapshot: client.last_traffic_snapshot,
    entries: entries
  });
});

// Delete ledger entry + revert balance
app.delete('/api/admin/clients/:id/ledger/:entryIndex', authMiddleware, adminMiddleware, (req, res) => {
  const client = clients.find(c => c.id === req.params.id);
  if (!client) return res.status(404).json({ error: 'Client not found' });
  const entries = billingLedger[client.id] || [];
  const idx = parseInt(req.params.entryIndex, 10);
  if (isNaN(idx) || idx < 0 || idx >= entries.length) return res.status(400).json({ error: 'Invalid entry index' });

  const entry = entries[idx];
  // Revert balance impact
  if (entry.type === 'charge' && entry.cost) {
    client.balance = (client.balance || 0) + entry.cost; // refund charge
  } else if ((entry.type === 'payment' || entry.type === 'bank_payment') && entry.amount) {
    client.balance = (client.balance || 0) - entry.amount; // remove payment
  } else if (entry.type === 'adjustment' && entry.amount) {
    client.balance = (client.balance || 0) - entry.amount;
  }
  client.balance = Math.round(client.balance * 100) / 100;

  entries.splice(idx, 1);
  billingLedger[client.id] = entries;
  saveBillingLedger();
  saveClients();
  console.log(`[Ledger] Deleted entry #${idx} (${entry.type}) for client ${client.name}, new balance: ${client.balance}`);
  res.json({ ok: true, newBalance: client.balance });
});

app.post('/api/admin/clients/:id/balance_adjust', authMiddleware, adminMiddleware, (req, res) => {
  const idx = clients.findIndex(c => c.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Client not found' });
  const { amount, note } = req.body;
  if (amount === undefined) return res.status(400).json({ error: 'amount required' });

  const adjustment = parseFloat(amount);
  const balanceBefore = clients[idx].balance || 0;
  clients[idx].balance = Math.round((balanceBefore + adjustment) * 100) / 100;

  const ledgerKey = clients[idx].id;
  if (!billingLedger[ledgerKey]) billingLedger[ledgerKey] = [];
  billingLedger[ledgerKey].push({
    type: 'adjustment',
    date: new Date().toISOString().slice(0, 10),
    timestamp: new Date().toISOString(),
    amount: adjustment,
    currency: clients[idx].currency || 'RUB',
    balance_before: balanceBefore,
    balance_after: clients[idx].balance,
    note: note || 'Ручная корректировка баланса'
  });

  saveClients(clients);
  saveBillingLedger();
  res.json({ ok: true, balance: clients[idx].balance });
});

// ==================== ADMIN: DOCUMENTS ====================

app.post('/api/admin/clients/:id/document', authMiddleware, adminMiddleware, (req, res) => {
  const idx = clients.findIndex(c => c.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Client not found' });
  const { name, fileBase64, mimeType } = req.body;
  if (!name || !fileBase64) return res.status(400).json({ error: 'name and fileBase64 required' });

  const docId = generateId();
  const ext = name.split('.').pop() || 'pdf';
  const fileName = `${docId}.${ext}`;
  const filePath = path.join(DOCUMENTS_DIR, fileName);

  fs.writeFileSync(filePath, Buffer.from(fileBase64, 'base64'));

  if (!clients[idx].documents) clients[idx].documents = [];
  clients[idx].documents.push({
    id: docId,
    name,
    fileName,
    mimeType: mimeType || 'application/pdf',
    date: new Date().toISOString()
  });
  saveClients(clients);
  res.json({ ok: true });
});

app.delete('/api/admin/clients/:id/document/:docId', authMiddleware, adminMiddleware, (req, res) => {
  const idx = clients.findIndex(c => c.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Client not found' });
  if (!clients[idx].documents) return res.status(404).json({ error: 'No documents' });
  const docIdx = clients[idx].documents.findIndex(d => d.id === req.params.docId);
  if (docIdx === -1) return res.status(404).json({ error: 'Document not found' });
  const doc = clients[idx].documents[docIdx];
  // Delete file
  try { fs.unlinkSync(path.join(DOCUMENTS_DIR, doc.fileName)); } catch (e) {}
  clients[idx].documents.splice(docIdx, 1);
  saveClients(clients);
  res.json({ ok: true });
});

// ==================== ADMIN: API KEY MANAGEMENT ====================

app.post('/api/admin/clients/:id/regenerate_key', authMiddleware, adminMiddleware, (req, res) => {
  const idx = clients.findIndex(c => c.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Client not found' });
  clients[idx].apiKey = 'prx_' + crypto.randomBytes(24).toString('hex');
  saveClients(clients);
  res.json({ ok: true, apiKey: clients[idx].apiKey });
});

// ==================== ADMIN: SETTINGS ====================

app.get('/api/admin/settings', authMiddleware, adminMiddleware, (req, res) => {
  res.json(appSettings);
});

app.put('/api/admin/settings', authMiddleware, adminMiddleware, (req, res) => {
  const { speedtest_times, pricing_tiers } = req.body;
  if (speedtest_times && Array.isArray(speedtest_times)) {
    appSettings.speedtest_times = speedtest_times.filter(t => /^\d{2}:\d{2}$/.test(t));
  }
  if (pricing_tiers && Array.isArray(pricing_tiers)) {
    appSettings.pricing_tiers = pricing_tiers.map(t => ({
      min_proxies: parseInt(t.min_proxies) || 1,
      price: parseFloat(t.price) || 0,
      label: t.label || ''
    }));
  }
  saveSettings();
  rescheduleSpeedtests();
  res.json({ ok: true, settings: appSettings });
});

// ==================== ADMIN: MODEM ACTIONS ====================

app.post('/api/admin/reset_ip', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { imei, serverName } = req.body;
    if (!imei || !serverName) return res.status(400).json({ error: 'imei and serverName required' });
    const server = findServer(serverName);
    if (!server) return res.status(400).json({ error: 'Server not found' });
    const result = await fetchApi(server, `/apix/reset_modem_by_imei?IMEI=${encodeURIComponent(imei)}`);
    res.json({ ok: true, result });
  } catch (err) { res.status(502).json({ error: 'Reset failed', details: err.message }); }
});

app.post('/api/admin/reboot', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { imei, serverName } = req.body;
    if (!imei || !serverName) return res.status(400).json({ error: 'imei and serverName required' });
    const server = findServer(serverName);
    if (!server) return res.status(400).json({ error: 'Server not found' });
    const result = await fetchApi(server, `/apix/reboot_modem_by_imei?IMEI=${encodeURIComponent(imei)}`);
    res.json({ ok: true, result });
  } catch (err) { res.status(502).json({ error: 'Reboot failed', details: err.message }); }
});

app.post('/api/admin/usb_reset', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { nick, serverName } = req.body;
    if (!nick || !serverName) return res.status(400).json({ error: 'nick and serverName required' });
    const server = findServer(serverName);
    if (!server) return res.status(400).json({ error: 'Server not found' });
    const result = await fetchApi(server, `/apix/usb_reset_modem_json?arg=${encodeURIComponent(nick)}`);
    res.json({ ok: true, result });
  } catch (err) { res.status(502).json({ error: 'USB reset failed', details: err.message }); }
});

app.post('/api/admin/store_modem', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { serverName, ...modemData } = req.body;
    if (!serverName || !modemData.IMEI) return res.status(400).json({ error: 'serverName and IMEI required' });
    const server = findServer(serverName);
    if (!server) return res.status(400).json({ error: 'Server not found' });
    const result = await postApi(server, '/crud/store_modem', modemData);
    res.json({ ok: true, result });
  } catch (err) { res.status(502).json({ error: 'Store modem failed', details: err.message }); }
});

app.post('/api/admin/apply_modem', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { serverName, imei } = req.body;
    if (!serverName || !imei) return res.status(400).json({ error: 'serverName and imei required' });
    const server = findServer(serverName);
    if (!server) return res.status(400).json({ error: 'Server not found' });
    const result = await postApi(server, '/modem/settings', { imei });
    res.json({ ok: true, result });
  } catch (err) { res.status(502).json({ error: 'Apply modem failed', details: err.message }); }
});

app.get('/api/admin/modem_status', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { nick, serverName } = req.query;
    if (!nick || !serverName) return res.status(400).json({ error: 'nick and serverName required' });
    const server = findServer(serverName);
    if (!server) return res.status(400).json({ error: 'Server not found' });
    const result = await fetchApi(server, `/apix/show_single_status_json?arg=${encodeURIComponent(nick)}`);
    res.json(result);
  } catch (err) { res.status(502).json({ error: 'Failed', details: err.message }); }
});

app.get('/api/admin/rotation_log', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { nick, serverName } = req.query;
    if (!nick || !serverName) return res.status(400).json({ error: 'nick and serverName required' });
    const server = findServer(serverName);
    if (!server) return res.status(400).json({ error: 'Server not found' });
    const result = await fetchApi(server, `/apix/get_rotation_log?arg=${encodeURIComponent(nick)}`);
    res.json(result);
  } catch (err) { res.status(502).json({ error: 'Failed', details: err.message }); }
});

app.get('/api/admin/speedtest', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { nick, serverName } = req.query;
    if (!nick || !serverName) return res.status(400).json({ error: 'nick and serverName required' });
    const server = findServer(serverName);
    if (!server) return res.status(400).json({ error: 'Server not found' });
    const result = await fetchApi(server, `/apix/speedtest?arg=${encodeURIComponent(nick)}`, 120000);
    res.json(result);
  } catch (err) { res.status(502).json({ error: 'Speedtest failed', details: err.message }); }
});

app.get('/api/admin/speedtest_history', authMiddleware, adminMiddleware, (req, res) => {
  res.json(speedtestHistory);
});

app.get('/api/admin/top_hosts', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { portId, serverName } = req.query;
    if (!portId || !serverName) return res.status(400).json({ error: 'portId and serverName required' });
    const server = findServer(serverName);
    if (!server) return res.status(400).json({ error: 'Server not found' });
    const result = await fetchApi(server, `/apix/top_hosts?arg=${encodeURIComponent(portId)}`);
    res.json(result);
  } catch (err) { res.status(502).json({ error: 'Failed', details: err.message }); }
});

app.get('/api/admin/ip_history', authMiddleware, adminMiddleware, (req, res) => {
  const { key } = req.query;
  if (key) {
    res.json(ipHistory[key] || []);
  } else {
    res.json(ipHistory);
  }
});

// ==================== ADMIN: SMS / USSD ====================

app.get('/api/admin/sms', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { imei, serverName } = req.query;
    if (!imei || !serverName) return res.status(400).json({ error: 'imei and serverName required' });
    const server = findServer(serverName);
    if (!server) return res.status(400).json({ error: 'Server not found' });
    const result = await fetchApi(server, `/modem/sms/${encodeURIComponent(imei)}?json=1`);
    res.json(result);
  } catch (err) { res.status(502).json({ error: 'Read SMS failed', details: err.message }); }
});

app.post('/api/admin/send_sms', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { imei, serverName, phone, sms } = req.body;
    if (!imei || !serverName || !phone || !sms) return res.status(400).json({ error: 'imei, serverName, phone, sms required' });
    const server = findServer(serverName);
    if (!server) return res.status(400).json({ error: 'Server not found' });
    const result = await postApi(server, '/modem/send-sms', { imei, phone, sms });
    res.json({ ok: true, result });
  } catch (err) { res.status(502).json({ error: 'Send SMS failed', details: err.message }); }
});

app.post('/api/admin/send_ussd', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { imei, serverName, ussd } = req.body;
    if (!imei || !serverName || !ussd) return res.status(400).json({ error: 'imei, serverName, ussd required' });
    const server = findServer(serverName);
    if (!server) return res.status(400).json({ error: 'Server not found' });
    const result = await postApi(server, '/modem/send-ussd', { imei, ussd });
    res.json({ ok: true, result });
  } catch (err) { res.status(502).json({ error: 'Send USSD failed', details: err.message }); }
});

app.post('/api/admin/purge_sms', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { nick, serverName } = req.body;
    if (!nick || !serverName) return res.status(400).json({ error: 'nick and serverName required' });
    const server = findServer(serverName);
    if (!server) return res.status(400).json({ error: 'Server not found' });
    const result = await fetchApi(server, `/apix/purge_sms_json?arg=${encodeURIComponent(nick)}`);
    res.json({ ok: true, result });
  } catch (err) { res.status(502).json({ error: 'Purge SMS failed', details: err.message }); }
});

// ==================== ADMIN: PORT CRUD ====================

app.post('/api/admin/store_port', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { serverName, ...portData } = req.body;
    if (!serverName || !portData.IMEI || !portData.portID) return res.status(400).json({ error: 'serverName, IMEI, portID required' });
    const server = findServer(serverName);
    if (!server) return res.status(400).json({ error: 'Server not found' });
    const result = await postApi(server, '/crud/store_port', portData);
    res.json({ ok: true, result });
  } catch (err) { res.status(502).json({ error: 'Store port failed', details: err.message }); }
});

// Update proxy credentials (login/password) for an existing port
app.post('/api/admin/update_port_creds', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { serverName, IMEI, portID, proxy_login, proxy_password } = req.body;
    if (!serverName || !IMEI || !portID) return res.status(400).json({ error: 'serverName, IMEI, portID required' });
    if (!proxy_login && !proxy_password) return res.status(400).json({ error: 'proxy_login or proxy_password required' });
    const server = findServer(serverName);
    if (!server) return res.status(400).json({ error: 'Server not found' });
    // Send to ProxySmart store_port (updates existing port)
    const portData = { IMEI, portID };
    if (proxy_login) portData.proxy_login = proxy_login;
    if (proxy_password) portData.proxy_password = proxy_password;
    const storeResult = await postApi(server, '/crud/store_port', portData);
    // Apply changes
    const applyResult = await fetchApi(server, `/apix/apply_port?arg=${encodeURIComponent(portID)}`);
    res.json({ ok: true, storeResult, applyResult });
  } catch (err) { res.status(502).json({ error: 'Update credentials failed', details: err.message }); }
});

app.post('/api/admin/apply_port', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { portId, serverName } = req.body;
    if (!portId || !serverName) return res.status(400).json({ error: 'portId and serverName required' });
    const server = findServer(serverName);
    if (!server) return res.status(400).json({ error: 'Server not found' });
    const result = await fetchApi(server, `/apix/apply_port?arg=${encodeURIComponent(portId)}`);
    res.json({ ok: true, result });
  } catch (err) { res.status(502).json({ error: 'Apply port failed', details: err.message }); }
});

app.post('/api/admin/purge_port', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { portId, serverName } = req.body;
    if (!portId || !serverName) return res.status(400).json({ error: 'portId and serverName required' });
    const server = findServer(serverName);
    if (!server) return res.status(400).json({ error: 'Server not found' });
    const result = await fetchApi(server, `/conf/delete_port/${encodeURIComponent(portId)}`);
    console.log(`[Admin] Deleted port ${portId} from ${serverName} via ProxySmart`);
    res.json({ ok: true, result });
  } catch (err) { res.status(502).json({ error: 'Delete port failed', details: err.message }); }
});

app.get('/api/admin/free_ports', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { serverName } = req.query;
    if (!serverName) return res.status(400).json({ error: 'serverName required' });
    const server = findServer(serverName);
    if (!server) return res.status(400).json({ error: 'Server not found' });
    const result = await fetchApi(server, '/apix/get_free_tcp_ports');
    res.json(result);
  } catch (err) { res.status(502).json({ error: 'Failed', details: err.message }); }
});

// ==================== ADMIN: BANDWIDTH ====================

app.get('/api/admin/bandwidth_single', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { portId, serverName } = req.query;
    if (!portId || !serverName) return res.status(400).json({ error: 'portId and serverName required' });
    const server = findServer(serverName);
    if (!server) return res.status(400).json({ error: 'Server not found' });
    const result = await fetchApi(server, `/apix/bandwidth_report_json?arg=${encodeURIComponent(portId)}`);
    res.json(result);
  } catch (err) { res.status(502).json({ error: 'Failed', details: err.message }); }
});

app.get('/api/admin/bandwidth_period', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { portId, serverName, start, end } = req.query;
    if (!portId || !serverName || !start || !end) return res.status(400).json({ error: 'portId, serverName, start, end required' });
    const server = findServer(serverName);
    if (!server) return res.status(400).json({ error: 'Server not found' });
    const result = await fetchApi(server, `/apix/get_counters_port?PORTID=${encodeURIComponent(portId)}&START=${encodeURIComponent(start)}&END=${encodeURIComponent(end)}`);
    res.json(result);
  } catch (err) { res.status(502).json({ error: 'Failed', details: err.message }); }
});

app.post('/api/admin/reset_bandwidth', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { portId, serverName } = req.body;
    if (!portId || !serverName) return res.status(400).json({ error: 'portId and serverName required' });
    const server = findServer(serverName);
    if (!server) return res.status(400).json({ error: 'Server not found' });
    const result = await fetchApi(server, `/apix/bandwidth_reset_counter?arg=${encodeURIComponent(portId)}`);
    res.json({ ok: true, result });
  } catch (err) { res.status(502).json({ error: 'Failed', details: err.message }); }
});

// ==================== ADMIN: ANALYTICS ====================

app.get('/api/admin/unique_ips', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { serverName } = req.query;
    if (!serverName) return res.status(400).json({ error: 'serverName required' });
    const server = findServer(serverName);
    if (!server) return res.status(400).json({ error: 'Server not found' });
    const result = await fetchApi(server, '/apix/unique_ips_json');
    res.json(result);
  } catch (err) { res.status(502).json({ error: 'Failed', details: err.message }); }
});

app.get('/api/admin/backup', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { serverName } = req.query;
    if (!serverName) return res.status(400).json({ error: 'serverName required' });
    const server = findServer(serverName);
    if (!server) return res.status(400).json({ error: 'Server not found' });
    const result = await fetchApi(server, '/crud/backup_export');
    res.json(result);
  } catch (err) { res.status(502).json({ error: 'Backup failed', details: err.message }); }
});

app.get('/api/admin/vpn_profile', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { portId, serverName } = req.query;
    if (!portId || !serverName) return res.status(400).json({ error: 'portId and serverName required' });
    const server = findServer(serverName);
    if (!server) return res.status(400).json({ error: 'Server not found' });
    const { buffer, contentType } = await fetchApiRaw(server, `/get_vpn_profile/${encodeURIComponent(portId)}.ovpn`);
    res.set('Content-Type', contentType || 'application/x-openvpn-profile');
    res.set('Content-Disposition', `attachment; filename="${portId}.ovpn"`);
    res.send(buffer);
  } catch (err) { res.status(502).json({ error: 'VPN profile failed', details: err.message }); }
});

app.get('/api/admin/shop_report', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { shop, period, serverName } = req.query;
    if (!shop || !period || !serverName) return res.status(400).json({ error: 'shop, period, serverName required' });
    const server = findServer(serverName);
    if (!server) return res.status(400).json({ error: 'Server not found' });
    const result = await fetchApi(server, `/apix/shop_report/${encodeURIComponent(shop)}/${encodeURIComponent(period)}`);
    res.json(result);
  } catch (err) { res.status(502).json({ error: 'Failed', details: err.message }); }
});

// ==================== TOOLS: PROXY CHECKER ====================

app.post('/api/tools/check_proxy', authMiddleware, async (req, res) => {
  const { proxies } = req.body;
  if (!Array.isArray(proxies) || proxies.length === 0) {
    return res.status(400).json({ error: 'proxies array required' });
  }
  const toCheck = proxies.slice(0, 50);

  // Check targets in order of reliability
  const checkTargets = [
    { url: 'http://api.ipify.org?format=json', host: 'api.ipify.org', parseIp: d => { try { return JSON.parse(d).ip; } catch(e) { return null; } } },
    { url: 'http://ip-api.com/json', host: 'ip-api.com', parseIp: d => { try { return JSON.parse(d).query; } catch(e) { return null; } } }
  ];

  async function checkOneProxy(proxy) {
    const start = Date.now();
    const proxyAuth = proxy.login && proxy.password
      ? `${proxy.login}:${proxy.password}` : null;
    for (const target of checkTargets) {
      try {
        const result = await new Promise((resolve, reject) => {
          const r = http.request({
            hostname: proxy.ip,
            port: parseInt(proxy.port),
            path: target.url,
            method: 'GET',
            headers: {
              'Host': target.host,
              ...(proxyAuth ? { 'Proxy-Authorization': 'Basic ' + Buffer.from(proxyAuth).toString('base64') } : {})
            },
            timeout: 15000
          }, (proxyRes) => {
            let data = '';
            proxyRes.on('data', chunk => data += chunk);
            proxyRes.on('end', () => resolve({ body: data, status: proxyRes.statusCode }));
          });
          r.on('error', reject);
          r.on('timeout', () => { r.destroy(); reject(new Error('Timeout')); });
          r.end();
        });
        if (result.status >= 200 && result.status < 400) {
          const detectedIp = target.parseIp(result.body) || result.body.trim();
          return { ip: proxy.ip, port: proxy.port, working: true, responseTime: Date.now() - start, detectedIp, status: result.status };
        }
      } catch (e) { continue; }
    }
    // TCP fallback — proxy port is open but HTTP check failed
    try {
      await new Promise((resolve, reject) => {
        const net = require('net');
        const sock = new net.Socket();
        sock.setTimeout(5000);
        sock.connect(parseInt(proxy.port), proxy.ip, () => { sock.destroy(); resolve(true); });
        sock.on('error', (err) => { sock.destroy(); reject(err); });
        sock.on('timeout', () => { sock.destroy(); reject(new Error('Timeout')); });
      });
      return { ip: proxy.ip, port: proxy.port, working: true, responseTime: Date.now() - start, detectedIp: '(порт открыт, IP не определён)', status: 0 };
    } catch (e) {
      return { ip: proxy.ip, port: proxy.port, working: false, responseTime: Date.now() - start, error: e.message };
    }
  }

  // Run checks in parallel (batches of 15)
  const results = [];
  for (let i = 0; i < toCheck.length; i += 15) {
    const batch = toCheck.slice(i, i + 15);
    const batchResults = await Promise.all(batch.map(p => checkOneProxy(p)));
    results.push(...batchResults);
  }

  res.json({ results });
});

// ==================== TOP HOSTS AGGREGATION (auto-nightly) ====================
const TOP_HOSTS_CACHE_FILE = path.join(__dirname, 'top_hosts_cache.json');

let topHostsCache = { data: {}, perPort: {}, updatedAt: null };
try {
  if (fs.existsSync(TOP_HOSTS_CACHE_FILE)) {
    topHostsCache = JSON.parse(fs.readFileSync(TOP_HOSTS_CACHE_FILE, 'utf8'));
    if (!topHostsCache.perPort) topHostsCache.perPort = {};
  }
} catch (e) { console.error('Failed to load top_hosts cache:', e.message); }

async function aggregateTopHosts() {
  console.log('[TopHosts] Starting aggregation...');
  const merged = {};
  const perPort = {};
  let fetchedCount = 0;
  let errorCount = 0;

  for (const server of apiServers) {
    try {
      const [portsResult, bwResult] = await Promise.all([
        fetchApi(server, '/apix/list_ports_json'),
        fetchApi(server, '/apix/bandwidth_report_all')
      ]);

      const portNameMap = {};
      if (bwResult && typeof bwResult === 'object') {
        for (const [portId, b] of Object.entries(bwResult)) {
          if (b.portName) portNameMap[portId] = b.portName;
        }
      }

      const portKeys = portsResult ? Object.keys(portsResult).filter(k => k !== 'raw') : [];
      console.log(`[TopHosts] ${server.name} list_ports_json: ${portKeys.length} IMEIs`);

      let portsMap = {};
      if (portsResult && typeof portsResult === 'object' && !portsResult.raw) {
        portsMap = portsResult;
      } else if (portsResult && portsResult.raw) {
        try { portsMap = JSON.parse(portsResult.raw); } catch(e) { console.log('[TopHosts] Failed to parse raw'); }
      }

      const portIds = [];
      for (const imei in portsMap) {
        if (imei === 'raw' || imei === '_server') continue;
        const ports = portsMap[imei];
        if (Array.isArray(ports)) {
          ports.forEach(p => { if (p.portID) portIds.push(p.portID); });
        }
      }
      console.log(`[TopHosts] ${server.name}: found ${portIds.length} ports to scan`);

      for (const portId of portIds) {
        try {
          const result = await fetchApi(server, `/apix/top_hosts?arg=${encodeURIComponent(portId)}`, 15000);
          if (result && typeof result === 'object') {
            let entries = [];
            if (Array.isArray(result)) entries = result;
            else {
              for (const k in result) {
                if (k !== 'raw' && typeof result[k] !== 'object') entries.push({ host: k, count: parseInt(result[k]) || 0 });
              }
            }

            const portName = portNameMap[portId] || portId;

            entries.forEach(e => {
              const h = e.host || e.domain || 'unknown';
              const count = e.count || e.requests || 1;
              merged[h] = (merged[h] || 0) + count;
              if (!perPort[portName]) perPort[portName] = {};
              perPort[portName][h] = (perPort[portName][h] || 0) + count;
            });
            if (entries.length > 0) fetchedCount++;
          }
        } catch (e) { errorCount++; }
      }
    } catch (e) {
      console.error(`[TopHosts] Error on server ${server.name}:`, e.message);
      errorCount++;
    }
  }

  topHostsCache = {
    data: merged,
    perPort,
    updatedAt: new Date().toISOString(),
    stats: { domains: Object.keys(merged).length, portsScanned: fetchedCount, errors: errorCount }
  };
  try {
    fs.writeFileSync(TOP_HOSTS_CACHE_FILE, JSON.stringify(topHostsCache, null, 2));
  } catch (e) { console.error('[TopHosts] Failed to save cache:', e.message); }
  console.log(`[TopHosts] Aggregation complete: ${Object.keys(merged).length} domains from ${fetchedCount} ports (${errorCount} errors), ${Object.keys(perPort).length} portNames`);
  return topHostsCache;
}

app.get('/api/admin/top_hosts_aggregated', authMiddleware, adminMiddleware, (req, res) => {
  res.json(topHostsCache);
});

app.post('/api/admin/top_hosts_refresh', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const result = await aggregateTopHosts();
    res.json({ ok: true, stats: result.stats, updatedAt: result.updatedAt });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ==================== SCHEDULERS ====================

// Dynamic speedtest scheduler (supports multiple times per day)
let speedtestTimers = [];

function rescheduleSpeedtests() {
  // Clear existing timers
  speedtestTimers.forEach(t => { if (t.timeout) clearTimeout(t.timeout); if (t.interval) clearInterval(t.interval); });
  speedtestTimers = [];

  const times = appSettings.speedtest_times || ['02:00', '14:00'];
  for (const timeStr of times) {
    const parts = timeStr.split(':').map(Number);
    if (parts.length !== 2 || isNaN(parts[0]) || isNaN(parts[1])) continue;
    scheduleRepeating(parts[0], parts[1], 'Speedtest-' + timeStr, runNightlySpeedtests);
  }
}

function scheduleRepeating(hour, minute, label, fn) {
  const now = new Date();
  const next = new Date();
  next.setUTCHours(hour, minute, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  const msUntil = next - now;
  console.log(`[${label}] Next run at ${next.toISOString()} (in ${Math.round(msUntil / 60000)} min)`);
  const entry = {};
  entry.timeout = setTimeout(() => {
    fn().catch(e => console.error(`[${label}] Error:`, e.message));
    entry.interval = setInterval(() => {
      fn().catch(e => console.error(`[${label}] Error:`, e.message));
    }, 24 * 60 * 60 * 1000);
  }, msUntil);
  speedtestTimers.push(entry);
}

// Schedule nightly TopHosts at 03:00
function scheduleNightly(hour, label, fn) {
  const now = new Date();
  const next = new Date();
  next.setUTCHours(hour, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  const msUntil = next - now;
  console.log(`[${label}] Next run at ${next.toISOString()} (in ${Math.round(msUntil / 60000)} min)`);
  setTimeout(() => {
    fn().catch(e => console.error(`[${label}] Error:`, e.message));
    setInterval(() => {
      fn().catch(e => console.error(`[${label}] Error:`, e.message));
    }, 24 * 60 * 60 * 1000);
  }, msUntil);
}

// ==================== DAILY BILLING ====================
async function runDailyBilling() {
  console.log('[Billing] Starting daily billing run...');
  let results;
  try {
    results = await fetchAllServersData();
  } catch (e) {
    console.error('[Billing] Failed to fetch server data:', e.message);
    return;
  }

  let charged = 0, skipped = 0;

  for (const client of clients) {
    if (!client.portName || !client.price || client.price <= 0) {
      skipped++;
      continue;
    }

    // Skip billing if not all servers returned data (prevents partial billing)
    if (results.length < apiServers.length) {
      console.log(`[Billing] Skipping ${client.name}: only ${results.length}/${apiServers.length} servers returned data`);
      skipped++;
      continue;
    }

    // Skip billing if any server with this client's ports has cached/stale data
    const cachedServers = getClientCachedServers(results, client.portName);
    if (cachedServers.length > 0) {
      console.log(`[Billing] Skipping ${client.name}: servers [${cachedServers.join(', ')}] have cached data, snapshot preserved`);
      skipped++;
      continue;
    }

    try {
      const currentMonthBytes = computeClientMonthBytes(results, client.portName);
      const snapshot = client.last_traffic_snapshot || { timestamp: null, month_bytes: 0 };
      const previousBytes = snapshot.month_bytes || 0;

      // Compute delta
      let deltaBytes;
      if (currentMonthBytes < previousBytes) {
        // Month reset detected: ProxySmart zeroed the counters
        // Charge the gap from last snapshot to real end of prev month (from prevmonth counters)
        const prevMonthTotal = computeClientPrevMonthBytes(results, client.portName);
        const gapBytes = Math.max(0, prevMonthTotal - previousBytes);
        console.log(`[Billing] Month reset detected for ${client.name}: snapshot=${previousBytes}, prevMonthTotal=${prevMonthTotal}, gap=${gapBytes}, newMonth=${currentMonthBytes}`);
        deltaBytes = gapBytes + currentMonthBytes;
      } else {
        deltaBytes = currentMonthBytes - previousBytes;
      }

      // Always update snapshot
      client.last_traffic_snapshot = {
        timestamp: new Date().toISOString(),
        month_bytes: currentMonthBytes
      };

      if (deltaBytes <= 0) {
        skipped++;
        continue;
      }

      // Compute cost based on billing type
      let cost = 0;
      const deltaGb = deltaBytes / (1024 * 1024 * 1024);

      if (client.billingType === 'per_modem') {
        // Per-modem: daily proration of monthly rate
        let modemCount = 0;
        for (const data of results) {
          if (typeof data.bw === 'object') {
            for (const [portId, b] of Object.entries(data.bw)) {
              if (b.portName === client.portName) modemCount++;
            }
          }
        }
        cost = (client.price * modemCount) / 30;
      } else {
        // per_gb billing (default)
        cost = client.price * deltaGb;
      }

      cost = Math.round(cost * 100) / 100;

      if (cost <= 0) {
        skipped++;
        continue;
      }

      // Deduct from balance
      const balanceBefore = client.balance || 0;
      client.balance = Math.round((balanceBefore - cost) * 100) / 100;

      // Record in ledger
      const ledgerKey = client.id;
      if (!billingLedger[ledgerKey]) billingLedger[ledgerKey] = [];
      billingLedger[ledgerKey].push({
        type: 'charge',
        date: new Date().toISOString().slice(0, 10),
        timestamp: new Date().toISOString(),
        delta_bytes: Math.round(deltaBytes),
        delta_gb: Math.round(deltaGb * 1000) / 1000,
        price_per_unit: client.price,
        billing_type: client.billingType || 'per_gb',
        cost,
        currency: client.currency || 'RUB',
        balance_before: balanceBefore,
        balance_after: client.balance,
        note: 'Списание за трафик (' + new Date().toLocaleDateString('ru-RU', {day:'2-digit',month:'2-digit',year:'numeric'}) + ')'
      });

      charged++;
      console.log(`[Billing] ${client.name}: delta=${deltaGb.toFixed(3)}GB, cost=${cost} ${client.currency || 'RUB'}, balance=${client.balance}`);
    } catch (e) {
      console.error(`[Billing] Error billing ${client.name}:`, e.message);
    }
  }

  saveClients(clients);
  saveBillingLedger();
  console.log(`[Billing] Complete: ${charged} charged, ${skipped} skipped`);
}

// ==================== AUTO-CREATE MISSING CLIENTS ====================

async function autoCreateMissingClients() {
  try {
    const results = await fetchAllServersData();
    const existingPortNames = new Set(clients.map(c => c.portName));
    const allPortNames = new Set();

    for (const data of results) {
      if (typeof data.bw === 'object') {
        for (const [portId, b] of Object.entries(data.bw)) {
          if (b.portName && !portId.startsWith('tg_') && !b.portName.startsWith('tg_')) {
            allPortNames.add(b.portName);
          }
        }
      }
    }

    // Count ports per portName for pricing
    const portCountMap = {};
    for (const data of results) {
      if (typeof data.bw === 'object') {
        for (const [portId, b] of Object.entries(data.bw)) {
          if (b.portName && !portId.startsWith('tg_') && !b.portName.startsWith('tg_')) {
            portCountMap[b.portName] = (portCountMap[b.portName] || 0) + 1;
          }
        }
      }
    }

    let created = 0;
    for (const pn of allPortNames) {
      if (existingPortNames.has(pn)) continue;
      if (pn.startsWith('tg_')) continue; // Telegram bot clients don't get dashboard accounts
      const login = pn.toLowerCase().replace(/[^a-z0-9_]/g, '_');
      if (users[login]) continue;

      const proxyCount = portCountMap[pn] || 1;
      const autoPrice = getPriceForProxyCount(proxyCount);
      const password = crypto.randomBytes(8).toString('hex');
      const client = {
        id: generateId(),
        name: pn,
        portName: pn,
        login: login,
        password: password,
        contact: '',
        notes: 'Auto-created from portName',
        billingType: 'per_gb',
        price: autoPrice,
        currency: 'RUB',
        payments: [],
        apiKey: 'prx_' + crypto.randomBytes(24).toString('hex'),
        referral_code: 'REF-' + crypto.randomBytes(4).toString('hex').toUpperCase(),
        referred_by: null,
        referral_balance: 0,
        resetToken: crypto.randomBytes(16).toString('hex'),
        documents: [],
        balance: 0,
        last_traffic_snapshot: { timestamp: null, month_bytes: 0 },
        createdAt: new Date().toISOString()
      };
      clients.push(client);
      users[login] = { password, portNameFilter: pn, source: 'client', clientId: client.id };
      created++;
      console.log(`  Auto-created client for portName "${pn}" (login: ${login}, pass: ${password})`);
    }

    if (created > 0) {
      saveClients(clients);
      console.log(`[AutoCreate] Created ${created} new client(s)`);
    } else {
      console.log('[AutoCreate] All portNames have client accounts');
    }
  } catch (e) {
    console.error('[AutoCreate] Error:', e.message);
  }
}

// ==================== PAGES ====================

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// ==================== API DOCUMENTATION ====================

app.get('/api/docs', (req, res) => {
  const baseUrl = `${req.protocol}://${req.get('host')}`;
  res.json({
    title: 'Proxies.Rent API Documentation',
    version: '1.0',
    baseUrl,
    authentication: {
      description: 'Используйте API ключ из вашего личного кабинета',
      methods: [
        { name: 'Query parameter', example: `${baseUrl}/api/v1/proxies?apiKey=YOUR_API_KEY` },
        { name: 'Session token', header: 'X-Auth-Token', description: 'Получается через /api/login' }
      ]
    },
    endpoints: {
      public: [
        {
          method: 'GET',
          path: '/api/v1/proxies',
          description: 'Получить список всех ваших прокси',
          params: {
            apiKey: { required: true, description: 'Ваш API ключ (найдите в личном кабинете)' },
            format: { required: false, default: 'json', options: ['json', 'txt', 'csv'], description: 'Формат ответа' }
          },
          examples: {
            json: `curl "${baseUrl}/api/v1/proxies?apiKey=YOUR_KEY&format=json"`,
            txt: `curl "${baseUrl}/api/v1/proxies?apiKey=YOUR_KEY&format=txt"`,
            csv: `curl "${baseUrl}/api/v1/proxies?apiKey=YOUR_KEY&format=csv"`
          },
          response_json: {
            proxies: [{ modem: 'MD2_64', ip: '89.149.100.92', httpPort: 8040, socksPort: 9040, login: 'user', password: 'pass', resetUrl: 'http://...' }],
            count: 1,
            client: 'ClientName'
          },
          response_txt: 'ip:port:login:password|reset_url (по одному на строку)'
        },
        {
          method: 'GET',
          path: '/api/client/reset_ip_by_token',
          description: 'Сброс IP модема по токену (не требует авторизации)',
          params: {
            nick: { required: true, description: 'Ник модема (например MD2_64)' },
            token: { required: true, description: 'Токен сброса из вашего аккаунта' }
          },
          example: `curl "${baseUrl}/api/client/reset_ip_by_token?nick=MD2_64&token=YOUR_TOKEN"`
        }
      ],
      authenticated: [
        {
          method: 'POST',
          path: '/api/login',
          description: 'Авторизация — получение токена сессии',
          body: { login: 'string', password: 'string' },
          response: { token: 'string', login: 'string', isAdmin: 'boolean' }
        },
        {
          method: 'GET',
          path: '/api/client/data',
          description: 'Получить все данные клиента (модемы, трафик, порты)',
          headers: { 'X-Auth-Token': 'YOUR_TOKEN' }
        },
        {
          method: 'GET',
          path: '/api/client/credentials_export',
          description: 'Экспорт доступов прокси с прямыми ссылками на смену IP',
          headers: { 'X-Auth-Token': 'YOUR_TOKEN' }
        },
        {
          method: 'POST',
          path: '/api/client/reset_ip',
          description: 'Сброс IP модема',
          headers: { 'X-Auth-Token': 'YOUR_TOKEN', 'Content-Type': 'application/json' },
          body: { imei: 'IMEI модема', serverName: 'S1 или S2' }
        },
        {
          method: 'GET',
          path: '/api/client/rotation_log',
          description: 'Лог ротации IP модема',
          params: { nick: 'Ник модема', serverName: 'S1 или S2' }
        },
        {
          method: 'GET',
          path: '/api/client/ip_history',
          description: 'История смены IP с точными временными метками',
          params: { key: 'IMEI ключ (формат: S1_IMEI или S2_IMEI)' }
        },
        {
          method: 'GET',
          path: '/api/client/referral',
          description: 'Информация о партнёрской программе'
        },
        {
          method: 'GET',
          path: '/api/client/documents',
          description: 'Список закрывающих документов'
        },
        {
          method: 'POST',
          path: '/api/tools/check_proxy',
          description: 'Проверка работоспособности прокси (макс. 50 штук)',
          body: { proxies: [{ ip: 'string', port: 'number', login: 'string (опц.)', password: 'string (опц.)' }] }
        }
      ]
    },
    formats: {
      txt: 'ip:port:login:password|direct_reset_url',
      csv: 'ip,http_port,socks_port,login,password,reset_url',
      json: 'Полный JSON объект со всеми данными'
    },
    notes: [
      'Ссылка для смены IP работает напрямую с сервером — не требует работы нашего сервера',
      'API ключ можно найти в личном кабинете',
      'Спидтесты выполняются автоматически в 02:00 и 14:00 UTC',
      'IP история обновляется каждые 10 минут'
    ]
  });
});

// ==================== TOCHKA BANK: WEBHOOK (public, no auth) ====================

// Accept raw text body for webhook
app.post('/api/tochka/webhook', express.text({ type: '*/*', limit: '1mb' }), (req, res) => {
  console.log('[Tochka Webhook] Received webhook');
  try {
    // Body is JWT string
    const jwtToken = typeof req.body === 'string' ? req.body.trim() : JSON.stringify(req.body);
    const payload = decodeJwtPayload(jwtToken);
    if (!payload) {
      console.error('[Tochka Webhook] Failed to decode JWT payload');
      return res.status(200).json({ ok: true, processed: false, reason: 'invalid_jwt' });
    }

    console.log('[Tochka Webhook] Decoded payload:', JSON.stringify(payload).slice(0, 500));

    const webhookType = payload.webhookType || '';
    const payerInn = payload.SidePayer?.inn || '';
    const payerName = payload.SidePayer?.name || '';
    const amount = parseFloat(payload.SidePayer?.amount || payload.amount || '0');
    const purpose = payload.purpose || '';
    const paymentId = payload.paymentId || '';
    const paymentDate = payload.date || new Date().toISOString().slice(0, 10);
    const customerCode = payload.customerCode || '';

    // Log the payment
    const bankPayment = {
      id: crypto.randomBytes(8).toString('hex'),
      webhookType,
      payerInn,
      payerName,
      amount,
      purpose,
      paymentId,
      date: paymentDate,
      customerCode,
      receivedAt: new Date().toISOString(),
      matched: false,
      matchedClientId: null,
      autoCredit: false
    };

    // Only process incoming payments
    if (webhookType === 'incomingPayment') {
      // Find client by INN
      const matchedClient = payerInn ? clients.find(c => c.inn && c.inn === payerInn) : null;

      if (matchedClient) {
        bankPayment.matched = true;
        bankPayment.matchedClientId = matchedClient.id;
        bankPayment.matchedClientName = matchedClient.name;

        // Auto-credit balance
        const idx = clients.findIndex(c => c.id === matchedClient.id);
        if (idx !== -1) {
          const balanceBefore = clients[idx].balance || 0;
          clients[idx].balance = Math.round((balanceBefore + amount) * 100) / 100;

          // Add payment record
          if (!clients[idx].payments) clients[idx].payments = [];
          clients[idx].payments.push({
            amount,
            date: paymentDate,
            note: `Банк Точка: ${payerName} — ${purpose}`.slice(0, 200),
            createdAt: new Date().toISOString(),
            source: 'tochka_webhook',
            paymentId
          });

          // Ledger entry
          const ledgerKey = clients[idx].id;
          if (!billingLedger[ledgerKey]) billingLedger[ledgerKey] = [];
          billingLedger[ledgerKey].push({
            type: 'bank_payment',
            date: paymentDate,
            timestamp: new Date().toISOString(),
            amount,
            currency: 'RUB',
            balance_before: balanceBefore,
            balance_after: clients[idx].balance,
            note: `Банк Точка (ИНН: ${payerInn}): ${purpose}`.slice(0, 300),
            source: 'tochka_webhook',
            paymentId
          });

          // Referral commission
          if (clients[idx].referred_by) {
            const referrer = clients.find(c => c.id === clients[idx].referred_by);
            if (referrer) {
              const commission = amount * 0.15;
              referrer.referral_balance = (referrer.referral_balance || 0) + commission;
            }
          }

          bankPayment.autoCredit = true;
          saveClients(clients);
          saveBillingLedger();
          console.log(`[Tochka Webhook] Auto-credited ${amount} RUB to ${matchedClient.name} (INN: ${payerInn})`);
        }
      } else {
        console.log(`[Tochka Webhook] Unmatched payment: INN=${payerInn}, amount=${amount}, purpose=${purpose}`);
      }
    }

    bankPayments.push(bankPayment);
    // Keep last 1000 entries
    if (bankPayments.length > 1000) bankPayments = bankPayments.slice(-1000);
    saveBankPayments();

    res.status(200).json({ ok: true, processed: true, matched: bankPayment.matched });
  } catch (err) {
    console.error('[Tochka Webhook] Error:', err.message);
    res.status(200).json({ ok: true, processed: false, reason: err.message });
  }
});

// ==================== TOCHKA BANK: ADMIN ENDPOINTS ====================

// Save Tochka config from admin UI
app.post('/api/admin/tochka/config', authMiddleware, adminMiddleware, (req, res) => {
  const { jwt, clientId, customerCode, accountId, companyName, companyInn, companyKpp } = req.body;
  if (jwt !== undefined) tochkaConfig.jwt = jwt.trim();
  if (clientId !== undefined) tochkaConfig.clientId = clientId.trim();
  if (customerCode !== undefined) tochkaConfig.customerCode = customerCode.trim();
  if (accountId !== undefined) tochkaConfig.accountId = accountId.trim();
  if (companyName !== undefined) tochkaConfig.companyName = companyName.trim();
  if (companyInn !== undefined) tochkaConfig.companyInn = companyInn.trim();
  if (companyKpp !== undefined) tochkaConfig.companyKpp = companyKpp.trim();
  saveTochkaConfig();
  console.log('[Tochka] Config updated from admin UI, jwt=' + (tochkaConfig.jwt ? 'set' : 'empty') + ', clientId=' + tochkaConfig.clientId);
  res.json({ ok: true, configured: !!tochkaConfig.jwt });
});

// Get Tochka config
app.get('/api/admin/tochka/config', authMiddleware, adminMiddleware, (req, res) => {
  res.json({
    jwt: tochkaConfig.jwt,
    clientId: tochkaConfig.clientId,
    customerCode: tochkaConfig.customerCode,
    accountId: tochkaConfig.accountId,
    companyName: tochkaConfig.companyName,
    companyInn: tochkaConfig.companyInn,
    companyKpp: tochkaConfig.companyKpp
  });
});

// Auto-detect Customer Code and Account ID from Tochka API
app.post('/api/admin/tochka/autodetect', authMiddleware, adminMiddleware, async (req, res) => {
  if (!tochkaConfig.jwt) {
    return res.status(400).json({ error: 'JWT токен не заполнен' });
  }
  try {
    const results = {};
    // 1. Get customers list -> customerCode
    try {
      const custResult = await tochkaRequest('GET', '/uapi/open-banking/v1.0/customers');
      const cd = custResult.data?.Data || custResult.data || {};
      const customers = cd.Customer || cd.Customers || cd.customers || (Array.isArray(cd) ? cd : []);
      console.log('[Tochka Autodetect] Customers raw:', JSON.stringify(custResult.data).slice(0, 500));
      if (Array.isArray(customers) && customers.length > 0) {
        const c = customers[0];
        results.customerCode = c.customerCode || c.CustomerCode || c.code || '';
        results.companyName = c.fullName || c.shortName || c.name || c.Name || c.organizationName || '';
        results.companyInn = c.taxCode || c.inn || c.Inn || c.INN || '';
        results.companyKpp = c.kpp || c.Kpp || c.KPP || '';
      }
    } catch (e) { console.log('[Tochka Autodetect] Customers error:', e.message); }
    // 2. Get accounts list -> accountId
    try {
      const accResult = await tochkaRequest('GET', '/uapi/open-banking/v1.0/accounts');
      const ad = accResult.data?.Data || accResult.data || {};
      const accounts = ad.Account || ad.Accounts || ad.accounts || (Array.isArray(ad) ? ad : []);
      console.log('[Tochka Autodetect] Accounts raw:', JSON.stringify(accResult.data).slice(0, 500));
      if (Array.isArray(accounts) && accounts.length > 0) {
        const rub = accounts.find(a => (a.currency === 'RUB' || a.Currency === 'RUB')) || accounts[0];
        results.accountId = rub.accountId || rub.AccountId || rub.resourceId || '';
        if (!results.customerCode && rub.customerCode) results.customerCode = rub.customerCode;
      }
    } catch (e) { console.log('[Tochka Autodetect] Accounts error:', e.message); }
    // Save detected values
    if (results.customerCode) tochkaConfig.customerCode = results.customerCode;
    if (results.accountId) tochkaConfig.accountId = results.accountId;
    if (results.companyName) tochkaConfig.companyName = results.companyName;
    if (results.companyInn) tochkaConfig.companyInn = results.companyInn;
    if (results.companyKpp) tochkaConfig.companyKpp = results.companyKpp;
    saveTochkaConfig();
    console.log('[Tochka Autodetect] Results:', JSON.stringify(results));
    res.json({ ok: true, detected: results });
  } catch (err) {
    res.status(502).json({ error: 'Ошибка автоопределения', details: err.message });
  }
});

// Register webhook in Tochka
app.post('/api/admin/tochka/register_webhook', authMiddleware, adminMiddleware, async (req, res) => {
  if (!tochkaConfig.jwt || !tochkaConfig.clientId) {
    return res.status(400).json({ error: 'Tochka API not configured. Введите JWT токен и Client ID в разделе Банк.' });
  }
  const { webhookUrl } = req.body;
  if (!webhookUrl) return res.status(400).json({ error: 'webhookUrl required' });

  try {
    const result = await tochkaRequest('PUT', `/uapi/webhook/v1.0/${tochkaConfig.clientId}`, {
      webhookUrl,
      webhookType: 'incomingPayment'
    });
    console.log('[Tochka] Webhook registered:', JSON.stringify(result.data));
    res.json({ ok: true, result: result.data });
  } catch (err) {
    res.status(502).json({ error: 'Failed to register webhook', details: err.message });
  }
});

// Sync historical payments from Tochka (Init Statement → poll → match)
app.post('/api/admin/tochka/sync', authMiddleware, adminMiddleware, async (req, res) => {
  if (!tochkaConfig.jwt || !tochkaConfig.accountId) {
    return res.status(400).json({ error: 'Tochka API не настроен. Заполните JWT и Account ID.' });
  }

  const { dateFrom, dateTo } = req.body;
  const from = dateFrom || '2024-01-01';
  const to = dateTo || new Date().toISOString().slice(0, 10);

  console.log(`[Tochka Sync] Requesting statement ${from} — ${to}`);

  try {
    // Step 1: Init Statement
    const initResult = await tochkaRequest('POST', '/uapi/open-banking/v1.0/statements', {
      Data: {
        Statement: {
          accountId: tochkaConfig.accountId,
          startDateTime: from + 'T00:00:00+00:00',
          endDateTime: to + 'T00:00:00+00:00'
        }
      }
    });

    const statementId = initResult.data?.Data?.Statement?.statementId
      || initResult.data?.Data?.statementId
      || initResult.data?.statementId;

    if (!statementId) {
      console.log('[Tochka Sync] Init response:', JSON.stringify(initResult.data));
      return res.status(502).json({ error: 'Не удалось создать выписку', details: initResult.data });
    }

    console.log(`[Tochka Sync] Statement initiated: ${statementId}`);

    // Step 2: Poll for Ready status (max 30 seconds)
    let statement = null;
    for (let attempt = 0; attempt < 15; attempt++) {
      await new Promise(r => setTimeout(r, 2000));
      const getResult = await tochkaRequest('GET',
        `/uapi/open-banking/v1.0/accounts/${tochkaConfig.accountId}/statements/${statementId}`);
      const stData = getResult.data?.Data?.Statement?.[0] || getResult.data?.Data?.Statement || getResult.data;
      const status = stData?.status || stData?.Status || '';
      console.log(`[Tochka Sync] Poll #${attempt + 1}: status=${status}`);
      if (status === 'Ready' || status === 'ready') {
        statement = stData;
        break;
      }
    }

    if (!statement) {
      return res.status(504).json({ error: 'Выписка не готова. Попробуйте позже.' });
    }

    // Step 3: Extract transactions
    const transactions = statement.Transaction || statement.transactions || [];
    console.log(`[Tochka Sync] Got ${transactions.length} transactions`);

    let imported = 0, matched = 0, skipped = 0;
    let loggedSample = false;

    for (const tx of transactions) {
      // Only process incoming (credit) payments
      const indicator = tx.creditDebitIndicator || tx.CreditDebitIndicator || '';
      if (indicator !== 'Credit' && indicator !== 'credit') continue;

      if (!loggedSample) {
        console.log('[Tochka Sync] Sample credit transaction:', JSON.stringify(tx).slice(0, 1500));
        loggedSample = true;
      }

      const amount = parseFloat(tx.Amount?.amount || tx.amount || 0);
      // DebtorParty = плательщик (кто платит нам), CreditorParty = получатель
      const debtor = tx.DebtorParty || tx.CounterParty || tx.SidePayer || {};
      const payerInn = debtor.inn || debtor.Inn || debtor.taxCode || '';
      const payerName = debtor.name || debtor.Name || debtor.fullName || '';
      const purpose = tx.description || tx.Description || tx.TransactionInformation || '';
      const paymentId = tx.transactionId || tx.TransactionId || tx.paymentId || ('tx_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6));
      const date = tx.documentProcessDate || tx.bookingDateTime || tx.valueDateTime || tx.date || to;

      // Check if already processed
      const alreadyExists = bankPayments.some(bp => bp.tochkaPaymentId === paymentId);
      if (alreadyExists) { skipped++; continue; }

      // Create bank payment record
      const bankPayment = {
        id: 'bp_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
        tochkaPaymentId: paymentId,
        webhookType: 'incomingPayment',
        source: 'sync',
        date: typeof date === 'string' ? date.slice(0, 10) : date,
        amount: amount,
        payerInn: payerInn,
        payerName: payerName,
        purpose: purpose,
        matched: false,
        matchedClientId: null,
        matchedClientName: null,
        receivedAt: new Date().toISOString()
      };

      // Try to match by INN
      if (payerInn) {
        const client = clients.find(c => c.inn && c.inn === payerInn);
        if (client) {
          bankPayment.matched = true;
          bankPayment.matchedClientId = client.id;
          bankPayment.matchedClientName = client.name;

          // Credit client balance
          client.balance = (client.balance || 0) + amount;
          const ledgerEntry = {
            type: 'bank_payment',
            amount: amount,
            date: bankPayment.date,
            timestamp: new Date().toISOString(),
            note: 'Синхронизация из Точки: ' + (purpose || '').slice(0, 100),
            source: 'tochka_sync',
            tochkaPaymentId: paymentId,
            balance_after: client.balance
          };
          // Write to global billingLedger (used by billing_history API)
          const ledgerKey = client.id;
          if (!billingLedger[ledgerKey]) billingLedger[ledgerKey] = [];
          billingLedger[ledgerKey].push(ledgerEntry);
          matched++;
        }
      }

      bankPayments.push(bankPayment);
      imported++;
    }

    // Save
    if (imported > 0) {
      saveBankPayments();
      saveClients();
      if (matched > 0) saveBillingLedger();
    }

    console.log(`[Tochka Sync] Done: ${imported} imported, ${matched} matched, ${skipped} skipped (duplicates)`);
    res.json({ ok: true, total: transactions.length, imported, matched, skipped });

  } catch (err) {
    console.error('[Tochka Sync] Error:', err.message);
    res.status(502).json({ error: 'Ошибка синхронизации', details: err.message });
  }
});

// Get Tochka status / bank payments log
app.get('/api/admin/tochka/payments', authMiddleware, adminMiddleware, (req, res) => {
  res.json({
    configured: !!tochkaConfig.jwt,
    payments: bankPayments.slice().reverse(),
    unmatchedCount: bankPayments.filter(p => !p.matched && !p.dismissed && p.webhookType === 'incomingPayment').length
  });
});

// Dismiss unmatched payments (hide them)
app.post('/api/admin/tochka/dismiss_unmatched', authMiddleware, adminMiddleware, (req, res) => {
  let count = 0;
  bankPayments.forEach(p => {
    if (!p.matched && p.webhookType === 'incomingPayment') {
      p.dismissed = true;
      count++;
    }
  });
  saveBankPayments();
  console.log(`[Tochka] Dismissed ${count} unmatched payments`);
  res.json({ ok: true, dismissed: count });
});

// Dismiss single payment
app.post('/api/admin/tochka/dismiss_payment', authMiddleware, adminMiddleware, (req, res) => {
  const { paymentId } = req.body;
  const bp = bankPayments.find(p => p.id === paymentId);
  if (!bp) return res.status(404).json({ error: 'Payment not found' });
  bp.dismissed = true;
  saveBankPayments();
  res.json({ ok: true });
});

// Manually match unmatched payment to client
app.post('/api/admin/tochka/match_payment', authMiddleware, adminMiddleware, (req, res) => {
  const { paymentId, clientId } = req.body;
  if (!paymentId || !clientId) return res.status(400).json({ error: 'paymentId and clientId required' });

  const bp = bankPayments.find(p => p.id === paymentId);
  if (!bp) return res.status(404).json({ error: 'Payment not found' });
  const idx = clients.findIndex(c => c.id === clientId);
  if (idx === -1) return res.status(404).json({ error: 'Client not found' });

  // Credit balance
  const amount = bp.amount;
  const balanceBefore = clients[idx].balance || 0;
  clients[idx].balance = Math.round((balanceBefore + amount) * 100) / 100;

  if (!clients[idx].payments) clients[idx].payments = [];
  clients[idx].payments.push({
    amount,
    date: bp.date,
    note: `Ручная привязка: ${bp.payerName} — ${bp.purpose}`.slice(0, 200),
    createdAt: new Date().toISOString(),
    source: 'tochka_manual',
    paymentId: bp.paymentId
  });

  const ledgerKey = clients[idx].id;
  if (!billingLedger[ledgerKey]) billingLedger[ledgerKey] = [];
  billingLedger[ledgerKey].push({
    type: 'bank_payment',
    date: bp.date,
    timestamp: new Date().toISOString(),
    amount,
    currency: 'RUB',
    balance_before: balanceBefore,
    balance_after: clients[idx].balance,
    note: `Ручная привязка (ИНН: ${bp.payerInn}): ${bp.purpose}`.slice(0, 300),
    source: 'tochka_manual',
    paymentId: bp.paymentId
  });

  bp.matched = true;
  bp.matchedClientId = clients[idx].id;
  bp.matchedClientName = clients[idx].name;
  bp.autoCredit = false;

  saveClients(clients);
  saveBillingLedger();
  saveBankPayments();
  res.json({ ok: true, balance: clients[idx].balance });
});

// ==================== TOCHKA BANK: CLOSING DOCUMENTS ====================

// Create closing document (Акт выполненных работ)
app.post('/api/admin/tochka/create_act', authMiddleware, adminMiddleware, async (req, res) => {
  const { clientId, period, items } = req.body;
  if (!clientId || !period) return res.status(400).json({ error: 'clientId and period required' });

  const client = clients.find(c => c.id === clientId);
  if (!client) return res.status(404).json({ error: 'Client not found' });

  // Calculate items from billing ledger if not provided
  let actItems = items;
  if (!actItems || actItems.length === 0) {
    const ledgerEntries = billingLedger[clientId] || [];
    const monthCharges = ledgerEntries.filter(e => e.type === 'charge' && e.date && e.date.startsWith(period));
    const totalGb = monthCharges.reduce((sum, e) => sum + (e.gb || 0), 0);
    const totalCost = monthCharges.reduce((sum, e) => sum + (e.cost || 0), 0);
    const modemCharges = monthCharges.filter(e => e.billing_type === 'per_modem');
    const gbCharges = monthCharges.filter(e => e.billing_type !== 'per_modem');

    actItems = [];
    if (gbCharges.length > 0) {
      actItems.push({
        name: 'Услуги мобильных прокси (трафик)',
        quantity: Math.round(totalGb * 100) / 100,
        unit: 'ГБ',
        price: client.price || 23,
        amount: Math.round(gbCharges.reduce((s, e) => s + (e.cost || 0), 0) * 100) / 100
      });
    }
    if (modemCharges.length > 0) {
      const modemCount = new Set(modemCharges.map(e => e.note || '')).size || 1;
      actItems.push({
        name: 'Услуги мобильных прокси (аренда модемов)',
        quantity: modemCount,
        unit: 'шт',
        price: client.price || 0,
        amount: Math.round(modemCharges.reduce((s, e) => s + (e.cost || 0), 0) * 100) / 100
      });
    }
    if (actItems.length === 0) {
      actItems.push({
        name: 'Услуги мобильных прокси',
        quantity: 1,
        unit: 'мес',
        price: 0,
        amount: Math.round(totalCost * 100) / 100
      });
    }
  }

  const totalAmount = actItems.reduce((s, i) => s + (i.amount || 0), 0);

  // Try to create via Tochka API if configured
  let tochkaDocumentId = null;
  const actNumber = `АКТ-${period.replace('-', '')}-${client.id.slice(0, 4)}`;
  if (tochkaConfig.jwt && tochkaConfig.customerCode && tochkaConfig.accountId && client.inn) {
    try {
      const actData = buildTochkaActBody(client, period, actItems, actNumber);
      const result = await tochkaRequest('POST', '/uapi/invoice/v1.0/closing-documents', actData);
      if (result.status === 200 && result.data?.Data?.documentId) {
        tochkaDocumentId = result.data.Data.documentId;
        console.log(`[Tochka] Created act ${tochkaDocumentId} for ${client.name}, period ${period}`);
      } else {
        console.error('[Tochka] Create act response:', JSON.stringify(result.data));
      }
    } catch (err) {
      console.error('[Tochka] Create act error:', err.message);
    }
  }

  // Save locally regardless of Tochka API success
  const docId = crypto.randomBytes(8).toString('hex');
  const closingDoc = {
    id: docId,
    tochkaDocumentId,
    period,
    createdAt: new Date().toISOString(),
    status: 'unsigned', // unsigned | signed
    totalAmount: Math.round(totalAmount * 100) / 100,
    items: actItems,
    actNumber,
    contractInfo: client.contractInfo || ''
  };

  if (!client.closingDocuments) client.closingDocuments = [];
  client.closingDocuments.push(closingDoc);
  saveClients(clients);

  res.json({ ok: true, document: closingDoc });
});

// Get closing documents for client (client-side)
app.get('/api/client/closing_documents', authMiddleware, (req, res) => {
  const client = clients.find(c => c.login === req.user.login);
  if (!client) return res.json({ documents: [] });
  res.json({ documents: (client.closingDocuments || []).map(d => ({
    id: d.id,
    period: d.period,
    totalAmount: d.totalAmount,
    status: d.status,
    createdAt: d.createdAt,
    actNumber: d.actNumber,
    items: d.items
  }))});
});

// Download closing document PDF from Tochka
app.get('/api/client/closing_documents/:docId/pdf', authMiddleware, async (req, res) => {
  const client = clients.find(c => c.login === req.user.login);
  if (!client) return res.status(404).json({ error: 'Client not found' });
  const doc = (client.closingDocuments || []).find(d => d.id === req.params.docId);
  if (!doc) return res.status(404).json({ error: 'Document not found' });

  if (!doc.tochkaDocumentId) {
    return res.status(404).json({ error: 'Документ не связан с Точкой. PDF недоступен.' });
  }

  try {
    const result = await tochkaRequest('GET', `/uapi/invoice/v1.0/closing-documents/${tochkaConfig.customerCode}/${doc.tochkaDocumentId}/file`);
    if (result.buffer) {
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${doc.actNumber || 'act'}.pdf"`);
      res.send(result.buffer);
    } else {
      res.status(502).json({ error: 'Failed to get PDF from Tochka' });
    }
  } catch (err) {
    res.status(502).json({ error: 'Failed to get PDF', details: err.message });
  }
});

// Admin: download closing document PDF
app.get('/api/admin/clients/:id/closing_documents/:docId/pdf', authMiddleware, adminMiddleware, async (req, res) => {
  const client = clients.find(c => c.id === req.params.id);
  if (!client) return res.status(404).json({ error: 'Client not found' });
  const doc = (client.closingDocuments || []).find(d => d.id === req.params.docId);
  if (!doc) return res.status(404).json({ error: 'Document not found' });

  if (!doc.tochkaDocumentId) {
    return res.status(404).json({ error: 'Документ не связан с Точкой. PDF недоступен.' });
  }

  try {
    const result = await tochkaRequest('GET', `/uapi/invoice/v1.0/closing-documents/${tochkaConfig.customerCode}/${doc.tochkaDocumentId}/file`);
    if (result.buffer) {
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${doc.actNumber || 'act'}.pdf"`);
      res.send(result.buffer);
    } else {
      res.status(502).json({ error: 'Failed to get PDF from Tochka' });
    }
  } catch (err) {
    res.status(502).json({ error: 'Failed to get PDF', details: err.message });
  }
});

// Admin: change closing document status (signed/unsigned)
app.post('/api/admin/clients/:id/closing_document_status', authMiddleware, adminMiddleware, (req, res) => {
  const client = clients.find(c => c.id === req.params.id);
  if (!client) return res.status(404).json({ error: 'Client not found' });
  const { docId, status } = req.body;
  if (!docId || !['signed', 'unsigned'].includes(status)) {
    return res.status(400).json({ error: 'docId and status (signed/unsigned) required' });
  }
  const doc = (client.closingDocuments || []).find(d => d.id === docId);
  if (!doc) return res.status(404).json({ error: 'Document not found' });
  doc.status = status;
  if (status === 'signed') doc.signedAt = new Date().toISOString();
  saveClients(clients);
  res.json({ ok: true, document: doc });
});

// Admin: delete closing document
app.delete('/api/admin/clients/:id/closing_document/:docId', authMiddleware, adminMiddleware, async (req, res) => {
  const client = clients.find(c => c.id === req.params.id);
  if (!client) return res.status(404).json({ error: 'Client not found' });
  const docIdx = (client.closingDocuments || []).findIndex(d => d.id === req.params.docId);
  if (docIdx === -1) return res.status(404).json({ error: 'Document not found' });

  const doc = client.closingDocuments[docIdx];
  // Try to delete from Tochka too
  if (doc.tochkaDocumentId && tochkaConfig.jwt) {
    try {
      await tochkaRequest('DELETE', `/uapi/invoice/v1.0/closing-documents/${tochkaConfig.customerCode}/${doc.tochkaDocumentId}`);
    } catch (e) { console.warn('[Tochka] Delete doc error:', e.message); }
  }

  client.closingDocuments.splice(docIdx, 1);
  saveClients(clients);
  res.json({ ok: true });
});

// Admin: get closing documents for a client
app.get('/api/admin/clients/:id/closing_documents', authMiddleware, adminMiddleware, (req, res) => {
  const client = clients.find(c => c.id === req.params.id);
  if (!client) return res.status(404).json({ error: 'Client not found' });
  res.json(client.closingDocuments || []);
});

// Admin: get ALL closing documents across all clients (for bank tab overview)
app.get('/api/admin/tochka/all_acts', authMiddleware, adminMiddleware, (req, res) => {
  const allDocs = [];
  for (const client of clients) {
    (client.closingDocuments || []).forEach(d => {
      allDocs.push({
        ...d,
        clientId: client.id,
        clientName: client.name,
        clientInn: client.inn || ''
      });
    });
  }
  allDocs.sort((a, b) => (b.period || '').localeCompare(a.period || '') || (b.createdAt || '').localeCompare(a.createdAt || ''));
  res.json({ documents: allDocs });
});

// Admin: bulk generate acts for a specific period for all clients with charges
app.post('/api/admin/tochka/generate_acts', authMiddleware, adminMiddleware, async (req, res) => {
  const { period } = req.body; // YYYY-MM
  if (!period || !/^\d{4}-\d{2}$/.test(period)) return res.status(400).json({ error: 'period required (YYYY-MM)' });

  let generated = 0, skipped = 0, errors = 0;
  const results = [];

  for (const client of clients) {
    const ledgerEntries = billingLedger[client.id] || [];
    const monthCharges = ledgerEntries.filter(e => e.type === 'charge' && e.date && e.date.startsWith(period));
    if (monthCharges.length === 0) { skipped++; continue; }

    // Skip if act already exists for this period
    if ((client.closingDocuments || []).some(d => d.period === period)) {
      skipped++;
      results.push({ client: client.name, status: 'exists' });
      continue;
    }

    try {
      const totalGb = monthCharges.reduce((sum, e) => sum + (e.gb || 0), 0);
      const totalCost = Math.round(monthCharges.reduce((sum, e) => sum + (e.cost || 0), 0) * 100) / 100;
      if (totalCost <= 0) { skipped++; continue; }

      const actItems = [{
        name: 'Услуги мобильных прокси',
        quantity: Math.round(totalGb * 100) / 100 || 1,
        unit: totalGb > 0 ? 'ГБ' : 'мес',
        price: client.price || 23,
        amount: totalCost
      }];

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
        } catch (e) { console.error(`[Tochka BulkActs] API error for ${client.name}:`, e.message); }
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
      results.push({ client: client.name, status: 'created', amount: totalCost });
      console.log(`[Tochka BulkActs] Created act for ${client.name}: ${totalCost} RUB (period ${period})`);
    } catch (e) {
      errors++;
      results.push({ client: client.name, status: 'error', error: e.message });
    }
  }

  if (generated > 0) saveClients(clients);
  res.json({ ok: true, generated, skipped, errors, results });
});

// ==================== TOCHKA BANK: BILLS (СЧЕТА НА ОПЛАТУ) ====================

// Create bill for a client
app.post('/api/admin/tochka/create_bill', authMiddleware, adminMiddleware, async (req, res) => {
  const { clientId, amount: manualAmount, period } = req.body;
  if (!clientId) return res.status(400).json({ error: 'clientId required' });

  const client = clients.find(c => c.id === clientId);
  if (!client) return res.status(404).json({ error: 'Client not found' });

  // Calculate amount or use manual
  const now = new Date();
  const billPeriod = period || now.toISOString().slice(0, 7);
  let serverData = [];
  if (!manualAmount) {
    try { serverData = await fetchAllServersData(); } catch (e) { console.error('[Bills] fetchAllServersData error:', e.message); }
  }
  let amount = manualAmount || calculateMonthlyBillAmount(client, serverData);
  if (!amount || amount <= 0) return res.status(400).json({ error: 'Cannot calculate bill amount (no charges found)' });

  const billNumber = `СЧЁТ-${billPeriod.replace('-', '')}-${client.id.slice(0, 4)}`;
  const billDate = now.toISOString().slice(0, 10);

  let tochkaBillId = null;
  if (tochkaConfig.jwt && tochkaConfig.customerCode && tochkaConfig.accountId && client.inn) {
    try {
      const billData = buildTochkaBillBody(client, amount, billNumber, billDate);
      const result = await tochkaRequest('POST', '/uapi/invoice/v1.0/bills', billData);
      if (result.status === 200 && result.data?.Data?.documentId) {
        tochkaBillId = result.data.Data.documentId;
        console.log(`[Tochka] Created bill ${tochkaBillId} for ${client.name}, amount ${amount}`);
      } else {
        console.error('[Tochka] Create bill response:', JSON.stringify(result.data));
      }
    } catch (err) {
      console.error('[Tochka] Create bill error:', err.message);
    }
  }

  const billId = crypto.randomBytes(8).toString('hex');
  const bill = {
    id: billId,
    tochkaBillId,
    period: billPeriod,
    createdAt: new Date().toISOString(),
    amount: Math.round(amount * 100) / 100,
    status: 'unpaid',
    billNumber
  };

  if (!client.bills) client.bills = [];
  client.bills.push(bill);
  saveClients(clients);

  res.json({ ok: true, bill });
});

// Generate bills for all clients
app.post('/api/admin/tochka/generate_bills', authMiddleware, adminMiddleware, async (req, res) => {
  const { period } = req.body;
  const now = new Date();
  const billPeriod = period || now.toISOString().slice(0, 7);
  const billDate = now.toISOString().slice(0, 10);

  let generated = 0, skipped = 0, errors = 0;
  const results = [];
  let serverData = [];
  try { serverData = await fetchAllServersData(); } catch (e) { console.error('[Bills] fetchAllServersData error:', e.message); }

  for (const client of clients) {
    if (!client.inn) { skipped++; continue; }
    if ((client.bills || []).some(b => b.period === billPeriod)) { skipped++; continue; }

    const amount = calculateMonthlyBillAmount(client, serverData);
    if (!amount || amount <= 0) { skipped++; continue; }

    const billNumber = `СЧЁТ-${billPeriod.replace('-', '')}-${client.id.slice(0, 4)}`;
    let tochkaBillId = null;

    if (tochkaConfig.jwt && tochkaConfig.customerCode && tochkaConfig.accountId) {
      try {
        const billData = buildTochkaBillBody(client, amount, billNumber, billDate);
        const result = await tochkaRequest('POST', '/uapi/invoice/v1.0/bills', billData);
        if (result.status === 200 && result.data?.Data?.documentId) {
          tochkaBillId = result.data.Data.documentId;
        } else {
          console.error(`[Tochka] Bill error for ${client.name}:`, JSON.stringify(result.data));
        }
      } catch (err) {
        console.error(`[Tochka] Bill error for ${client.name}:`, err.message);
      }
    }

    const billId = crypto.randomBytes(8).toString('hex');
    if (!client.bills) client.bills = [];
    client.bills.push({
      id: billId,
      tochkaBillId,
      period: billPeriod,
      createdAt: new Date().toISOString(),
      amount: Math.round(amount * 100) / 100,
      status: 'unpaid',
      billNumber
    });

    generated++;
    results.push({ client: client.name, status: 'created', amount: Math.round(amount * 100) / 100 });
  }

  if (generated > 0) saveClients(clients);
  res.json({ ok: true, generated, skipped, errors, results });
});

// Get all bills across all clients
app.get('/api/admin/tochka/all_bills', authMiddleware, adminMiddleware, (req, res) => {
  const allBills = [];
  for (const client of clients) {
    for (const b of (client.bills || [])) {
      allBills.push({
        ...b,
        clientId: client.id,
        clientName: client.name,
        clientInn: client.inn || ''
      });
    }
  }
  allBills.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  res.json({ bills: allBills });
});

// Download bill PDF
app.get('/api/admin/clients/:id/bills/:billId/pdf', authMiddleware, adminMiddleware, async (req, res) => {
  const client = clients.find(c => c.id === req.params.id);
  if (!client) return res.status(404).json({ error: 'Client not found' });
  const bill = (client.bills || []).find(b => b.id === req.params.billId);
  if (!bill || !bill.tochkaBillId) return res.status(404).json({ error: 'Bill not found or no Tochka ID' });

  try {
    const result = await tochkaRequest('GET', `/uapi/invoice/v1.0/bills/${tochkaConfig.customerCode}/${bill.tochkaBillId}/file`);
    if (result.status === 200 && result.buffer) {
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(bill.billNumber + '.pdf')}`);
      res.send(result.buffer);
    } else {
      res.status(500).json({ error: 'Failed to download PDF' });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Change bill status
app.post('/api/admin/clients/:id/bill_status', authMiddleware, adminMiddleware, (req, res) => {
  const client = clients.find(c => c.id === req.params.id);
  if (!client) return res.status(404).json({ error: 'Client not found' });
  const { billId, status } = req.body;
  const bill = (client.bills || []).find(b => b.id === billId);
  if (!bill) return res.status(404).json({ error: 'Bill not found' });
  bill.status = status === 'paid' ? 'paid' : 'unpaid';
  saveClients(clients);
  res.json({ ok: true, bill });
});

// Delete bill
app.delete('/api/admin/clients/:id/bill/:billId', authMiddleware, adminMiddleware, async (req, res) => {
  const client = clients.find(c => c.id === req.params.id);
  if (!client) return res.status(404).json({ error: 'Client not found' });
  const idx = (client.bills || []).findIndex(b => b.id === req.params.billId);
  if (idx === -1) return res.status(404).json({ error: 'Bill not found' });

  const bill = client.bills[idx];
  if (bill.tochkaBillId && tochkaConfig.jwt) {
    try {
      await tochkaRequest('DELETE', `/uapi/invoice/v1.0/bills/${tochkaConfig.customerCode}/${bill.tochkaBillId}`);
    } catch (e) { console.error('[Tochka] Delete bill error:', e.message); }
  }
  client.bills.splice(idx, 1);
  saveClients(clients);
  res.json({ ok: true });
});

// Client-side: get bills
app.get('/api/client/bills', authMiddleware, (req, res) => {
  const client = clients.find(c => c.login === req.user.login);
  if (!client) return res.json({ bills: [] });
  res.json({ bills: (client.bills || []).map(b => ({
    id: b.id,
    period: b.period,
    amount: b.amount,
    status: b.status,
    createdAt: b.createdAt,
    billNumber: b.billNumber,
    hasPdf: !!b.tochkaBillId
  }))});
});

// Client-side: download bill PDF
app.get('/api/client/bills/:billId/pdf', authMiddleware, async (req, res) => {
  const client = clients.find(c => c.login === req.user.login);
  if (!client) return res.status(404).json({ error: 'Client not found' });
  const bill = (client.bills || []).find(b => b.id === req.params.billId);
  if (!bill || !bill.tochkaBillId) return res.status(404).json({ error: 'Bill not found' });

  try {
    const result = await tochkaRequest('GET', `/uapi/invoice/v1.0/bills/${tochkaConfig.customerCode}/${bill.tochkaBillId}/file`);
    if (result.status === 200 && result.buffer) {
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(bill.billNumber + '.pdf')}`);
      res.send(result.buffer);
    } else {
      res.status(500).json({ error: 'Failed to download PDF' });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== TOCHKA: AUTO-GENERATE ACTS (1st of month) ====================
async function autoGenerateMonthlyActs() {
  const now = new Date();
  const moscowDate = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/Moscow' }));
  const day = moscowDate.getDate();
  const hour = moscowDate.getHours();

  // Only run on 1st of month, after 8:00 Moscow time
  if (day !== 1 || hour < 8) return;

  // Previous month
  const prevMonth = new Date(moscowDate);
  prevMonth.setMonth(prevMonth.getMonth() - 1);
  const period = prevMonth.toISOString().slice(0, 7); // YYYY-MM

  // Prevent duplicate generation
  if (lastActGenerationMonth === period) return;

  console.log(`[Tochka AutoActs] Generating acts for period ${period}...`);
  let generated = 0;

  for (const client of clients) {
    // Skip clients without charges
    const ledgerEntries = billingLedger[client.id] || [];
    const monthCharges = ledgerEntries.filter(e => e.type === 'charge' && e.date && e.date.startsWith(period));
    if (monthCharges.length === 0) continue;

    // Skip if act already exists for this period
    if ((client.closingDocuments || []).some(d => d.period === period)) continue;

    try {
      // Calculate totals
      const totalGb = monthCharges.reduce((sum, e) => sum + (e.gb || 0), 0);
      const totalCost = Math.round(monthCharges.reduce((sum, e) => sum + (e.cost || 0), 0) * 100) / 100;

      const actItems = [{
        name: 'Услуги мобильных прокси',
        quantity: Math.round(totalGb * 100) / 100 || 1,
        unit: totalGb > 0 ? 'ГБ' : 'мес',
        price: client.price || 23,
        amount: totalCost
      }];

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
        } catch (e) { console.error(`[Tochka AutoActs] API error for ${client.name}:`, e.message); }
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
      console.log(`[Tochka AutoActs] Created act for ${client.name}: ${totalCost} RUB`);
    } catch (e) {
      console.error(`[Tochka AutoActs] Error for ${client.name}:`, e.message);
    }
  }

  if (generated > 0) {
    saveClients(clients);
    console.log(`[Tochka AutoActs] Generated ${generated} acts for ${period}`);
  }
  lastActGenerationMonth = period;
}

// ==================== TOCHKA: AUTO-GENERATE BILLS (1st of month) ====================
async function autoGenerateMonthlyBills() {
  const now = new Date();
  const moscowDate = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/Moscow' }));
  const day = moscowDate.getDate();
  const hour = moscowDate.getHours();

  // Only run on 1st of month, after 8:00 Moscow time
  if (day !== 1 || hour < 8) return;

  // Current month (bills are for the current month, unlike acts which are for previous)
  const currentPeriod = `${moscowDate.getFullYear()}-${String(moscowDate.getMonth() + 1).padStart(2, '0')}`;

  // Prevent duplicate generation
  if (lastBillGenerationMonth === currentPeriod) return;

  console.log(`[Tochka AutoBills] Generating bills for period ${currentPeriod}...`);
  let generated = 0;
  let serverData = [];
  try { serverData = await fetchAllServersData(); } catch (e) { console.error('[AutoBills] fetchAllServersData error:', e.message); }

  for (const client of clients) {
    // Skip clients without INN
    if (!client.inn) continue;

    // Skip if bill already exists for this period
    if ((client.bills || []).some(b => b.period === currentPeriod)) continue;

    try {
      const amount = calculateMonthlyBillAmount(client, serverData);
      if (amount <= 0) {
        console.log(`[Tochka AutoBills] Skipping ${client.name}: amount is 0`);
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
          console.error(`[Tochka AutoBills] API error for ${client.name}:`, e.message);
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
      console.log(`[Tochka AutoBills] Created bill for ${client.name}: ${amount} RUB`);
    } catch (e) {
      console.error(`[Tochka AutoBills] Error for ${client.name}:`, e.message);
    }
  }

  if (generated > 0) {
    saveClients(clients);
    console.log(`[Tochka AutoBills] Generated ${generated} bills for ${currentPeriod}`);
  }
  lastBillGenerationMonth = currentPeriod;
}

// ==================== JSON fallback for unknown API routes (Bug #5) ====================
app.use('/api', (req, res) => {
  res.status(404).json({
    success: false,
    error: `Cannot ${req.method} ${req.path}`
  });
});

app.listen(PORT, () => {
  console.log(`Proxies.Rent Dashboard running at http://localhost:${PORT}`);

  // Schedule speedtests (configurable times, default 02:00 + 14:00)
  rescheduleSpeedtests();

  // Schedule nightly TopHosts at 03:00
  scheduleNightly(3, 'TopHosts', aggregateTopHosts);

  // Start modem tracking (IP + uptime) every 5 minutes
  console.log('[Tracking] Starting IP & uptime tracking (every 5 min)...');
  trackModems().catch(e => console.error('[Tracking] Initial error:', e.message));
  setInterval(() => {
    trackModems().catch(e => console.error('[Tracking] Error:', e.message));
  }, 5 * 60 * 1000);

  // If no cached top_hosts data, do initial aggregation
  if (!topHostsCache.updatedAt) {
    console.log('[TopHosts] No cached data, running initial aggregation...');
    aggregateTopHosts().catch(e => console.error('[TopHosts] Initial error:', e.message));
  }

  // Auto-create client accounts for all portNames that don't have one
  autoCreateMissingClients().catch(e => console.error('[AutoCreate] Error:', e.message));

  // Schedule daily billing at 23:55 UTC
  scheduleRepeating(23, 55, 'DailyBilling', runDailyBilling);

  // Auto-generate closing documents (acts) on 1st of each month at 08:05 Moscow (05:05 UTC)
  scheduleRepeating(5, 5, 'MonthlyActs', autoGenerateMonthlyActs);

  // Auto-generate bills on 1st of each month at 08:10 Moscow (05:10 UTC)
  scheduleRepeating(5, 10, 'MonthlyBills', autoGenerateMonthlyBills);

  // Billing catch-up: if last snapshot is older than 26 hours, run now
  (async () => {
    try {
      const now = Date.now();
      let needsCatchup = false;
      for (const c of clients) {
        if (c.last_traffic_snapshot && c.last_traffic_snapshot.timestamp) {
          const lastRun = new Date(c.last_traffic_snapshot.timestamp).getTime();
          if (now - lastRun > 26 * 60 * 60 * 1000) {
            needsCatchup = true;
            break;
          }
        }
      }
      if (needsCatchup) {
        console.log('[Billing] Catch-up: missed billing detected, running now...');
        await runDailyBilling();
      }
    } catch (e) {
      console.error('[Billing] Catch-up error:', e.message);
    }
  })();
});

// ==================== TELEGRAM BOT ====================

const TG_PROXIES_FILE = path.join(__dirname, 'telegram_proxies.json');
let tgProxies = [];
try {
  if (fs.existsSync(TG_PROXIES_FILE)) {
    tgProxies = JSON.parse(fs.readFileSync(TG_PROXIES_FILE, 'utf8'));
    console.log(`[TelegramBot] Loaded ${tgProxies.length} proxy record(s)`);
  }
} catch (e) { console.error('[TelegramBot] Failed to load proxies:', e.message); }

function saveTgProxies() {
  try { fs.writeFileSync(TG_PROXIES_FILE, JSON.stringify(tgProxies, null, 2)); }
  catch (e) { console.error('[TelegramBot] Failed to save proxies:', e.message); }
}

// Telegram user database — persistent per-user info
const TG_USERS_FILE = path.join(__dirname, 'telegram_users.json');
let tgUsers = {}; // { chatId: { username, testUsed, plan, speedTests: [{speed,date}], registeredAt } }
try {
  if (fs.existsSync(TG_USERS_FILE)) {
    tgUsers = JSON.parse(fs.readFileSync(TG_USERS_FILE, 'utf8'));
    console.log(`[TelegramBot] Loaded ${Object.keys(tgUsers).length} user record(s)`);
  }
} catch (e) { console.error('[TelegramBot] Failed to load users:', e.message); }

function saveTgUsers() {
  try { fs.writeFileSync(TG_USERS_FILE, JSON.stringify(tgUsers, null, 2)); }
  catch (e) { console.error('[TelegramBot] Failed to save users:', e.message); }
}

function getTgUser(chatId, username) {
  if (!tgUsers[chatId]) {
    tgUsers[chatId] = { username: username || null, testUsed: false, plan: null, speedTests: [], registeredAt: new Date().toISOString() };
    saveTgUsers();
  } else if (username && tgUsers[chatId].username !== username) {
    tgUsers[chatId].username = username;
    saveTgUsers();
  }
  return tgUsers[chatId];
}

// Migrate existing proxy records into tgUsers if not already there
(function migrateTgUsers() {
  let migrated = 0;
  for (const p of tgProxies) {
    if (!tgUsers[p.chatId]) {
      tgUsers[p.chatId] = {
        username: p.username || null,
        testUsed: p.plan === 'test' || false,
        plan: p.plan,
        speedTests: [],
        registeredAt: p.createdAt || new Date().toISOString()
      };
      migrated++;
    }
    // Mark testUsed if they ever had a test plan
    if (p.plan === 'test') tgUsers[p.chatId].testUsed = true;
  }
  if (migrated > 0) {
    saveTgUsers();
    console.log(`[TelegramBot] Migrated ${migrated} user(s) from proxies`);
  }
})();

const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TG_PRICE = parseInt(process.env.TELEGRAM_BOT_PRICE) || 599;
const SERVER_IPS = { S1: '89.149.100.92', S2: '31.5.194.89' };

const PLANS = {
  test:  { label: 'Тест (1 день)',  price: 0,   days: 1 },
  '1m':  { label: '1 месяц',        price: 599, days: 30 },
  '6m':  { label: '6 месяцев',      price: 499, days: 180 },
  '12m': { label: '12 месяцев',     price: 399, days: 360 }
};

// Reply keyboard layouts
const KB_MAIN = { keyboard: [
  ['🎁 Тест (1 день)', '📋 Тарифы'],
  ['📱 Мои прокси', '🚀 Скорость'],
  ['❓ Инструкция', '💬 Обратная связь']
], resize_keyboard: true };

const KB_PLANS = { keyboard: [
  ['📅 1 мес — 599 ₽'],
  ['📅 6 мес — 499 ₽/мес'],
  ['📅 12 мес — 399 ₽/мес'],
  ['🎁 Тест (1 день)', '◀️ Назад']
], resize_keyboard: true };

const KB_SPEED = { keyboard: [
  ['✅ Скачал!'],
  ['◀️ Отмена']
], resize_keyboard: true };

// Speed test state
let speedTestFileId = null;
const speedTestSessions = {};
const SPEED_TEST_SIZE = 10 * 1024 * 1024; // 10 MB

// Feedback storage
const TG_FEEDBACK_FILE = path.join(__dirname, 'telegram_feedback.json');
let tgFeedback = [];
try {
  if (fs.existsSync(TG_FEEDBACK_FILE)) {
    tgFeedback = JSON.parse(fs.readFileSync(TG_FEEDBACK_FILE, 'utf8'));
    console.log(`[TelegramBot] Loaded ${tgFeedback.length} feedback record(s)`);
  }
} catch (e) { console.error('[TelegramBot] Failed to load feedback:', e.message); }

function saveTgFeedback() {
  try { fs.writeFileSync(TG_FEEDBACK_FILE, JSON.stringify(tgFeedback, null, 2)); }
  catch (e) { console.error('[TelegramBot] Failed to save feedback:', e.message); }
}

// User states for feedback flow
const userStates = {}; // { chatId: { state: 'awaiting_feedback'|'awaiting_nps_comment', score, type } }

function telegramApi(method, body, reqTimeout = 15000) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify(body || {});
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${TG_TOKEN}/${method}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) },
      timeout: reqTimeout
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { resolve({ ok: false, raw: data }); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Telegram API timeout')); });
    req.write(postData);
    req.end();
  });
}

function tgSend(chatId, text, options = {}) {
  return telegramApi('sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    ...options
  });
}

async function findLeastLoadedModem() {
  const results = await fetchAllServersData();
  const portCounts = {}; // { 'S1_IMEI': { imei, serverName, server, count } }
  const onlineModems = new Set();

  for (const data of results) {
    if (data._cached) continue;
    // Collect online modems
    if (Array.isArray(data.status)) {
      for (const m of data.status) {
        if (m.net_details?.IS_ONLINE === 'yes' && m.modem_details?.IMEI) {
          onlineModems.add(data.serverName + '_' + m.modem_details.IMEI);
        }
      }
    }
    // Count ports per IMEI
    if (typeof data.ports === 'object') {
      for (const [imei, ports] of Object.entries(data.ports)) {
        const key = data.serverName + '_' + imei;
        portCounts[key] = {
          imei,
          serverName: data.serverName,
          server: findServer(data.serverName),
          count: Array.isArray(ports) ? ports.length : 0
        };
      }
    }
  }

  // Find online modem with fewest ports
  let best = null;
  for (const [key, info] of Object.entries(portCounts)) {
    if (!onlineModems.has(key)) continue;
    if (!info.server) continue;
    if (!best || info.count < best.count) {
      best = info;
    }
  }
  return best;
}

async function createProxyForTelegram(chatId, username, planKey) {
  const plan = PLANS[planKey];
  if (!plan) throw new Error('Unknown plan');

  const modem = await findLeastLoadedModem();
  if (!modem) throw new Error('Нет доступных модемов');

  // Get free TCP ports — separate HTTP (8xxx) and SOCKS (5xxx) ranges
  const freePorts = await fetchApi(modem.server, '/apix/get_free_tcp_ports');
  const freeList = Array.isArray(freePorts) ? freePorts : (freePorts.free_tcp_ports || []);
  const freeHttp = freeList.filter(p => p >= 8001 && p <= 8999);
  const freeSocks = freeList.filter(p => p >= 5001 && p <= 5999);
  if (!freeHttp.length || !freeSocks.length) throw new Error('Нет свободных портов на сервере');

  const portID = 'tg_' + crypto.randomBytes(4).toString('hex');
  const portName = username ? ('tg_' + username) : ('tg_' + chatId);
  const login = crypto.randomBytes(4).toString('hex');
  const password = crypto.randomBytes(4).toString('hex');
  const httpPort = freeHttp[0];
  const socksPort = freeSocks[0];

  // Create port via ProxySmart web form (/conf/add_port)
  const formData = `IMEI=${encodeURIComponent(modem.imei)}&portID=${encodeURIComponent(portID)}&portName=${encodeURIComponent(portName)}&http_port=${httpPort}&socks_port=${socksPort}&proxy_login=${encodeURIComponent(login)}&proxy_password=${encodeURIComponent(password)}`;
  const addResult = await postFormApi(modem.server, `/conf/add_port?imei=${encodeURIComponent(modem.imei)}`, formData);
  console.log(`[TelegramBot] add_port response: status=${addResult.status}`);

  const serverIp = SERVER_IPS[modem.serverName] || new URL(modem.server.url).hostname;

  // Compute expiration
  let expiresAt;
  if (plan.hours) {
    // Test plan: expires in N hours
    expiresAt = new Date(Date.now() + plan.hours * 3600000).toISOString();
  } else {
    // Monthly plans: expires at 00:00 UTC on (today + days + 1)
    const now = new Date();
    expiresAt = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + plan.days + 1, 0, 0, 0)).toISOString();
  }

  const record = {
    chatId,
    username: username || null,
    portID,
    portName,
    serverName: modem.serverName,
    imei: modem.imei,
    serverIp,
    httpPort,
    socksPort,
    login,
    password,
    plan: planKey,
    createdAt: new Date().toISOString(),
    expiresAt,
    notified_7d: false,
    notified_1d: false
  };

  tgProxies.push(record);
  saveTgProxies();

  console.log(`[TelegramBot] Created proxy ${portID} on ${modem.serverName}/${modem.imei} for @${username || chatId} (plan: ${planKey})`);
  return record;
}

async function deleteProxyRecord(record, notify = true) {
  try {
    const server = findServer(record.serverName);
    if (server) {
      await fetchApi(server, `/conf/delete_port/${encodeURIComponent(record.portID)}`);
      console.log(`[TelegramBot] Deleted port ${record.portID} from ${record.serverName}`);
    }
  } catch (e) {
    console.error(`[TelegramBot] Failed to delete ${record.portID}:`, e.message);
  }

  tgProxies = tgProxies.filter(p => p.portID !== record.portID);
  saveTgProxies();

  if (notify) {
    const isTest = record.plan === 'test';
    const text = isTest
      ? '⏰ <b>Тестовый период завершён</b>\n\nВаш прокси отключён. Оформите подписку для постоянного доступа!'
      : '⚠️ <b>Подписка истекла</b>\n\nВаш прокси отключён. Возобновите подписку для продолжения!';

    await tgSend(record.chatId, text, { reply_markup: KB_MAIN });
  }
}

function formatProxyMessage(record, planLabel) {
  const deepLink = `https://t.me/socks?server=${record.serverIp}&port=${record.socksPort}&user=${record.login}&pass=${record.password}`;

  let expiresLine;
  if (record.plan === 'test') {
    expiresLine = '⏳ Прокси перестанет работать через 24 часа';
  } else {
    const expiresDate = new Date(record.expiresAt).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC' });
    expiresLine = `⏳ Действует до: ${expiresDate}`;
  }

  return {
    text: `✅ <b>Ваш прокси готов!</b>\n\n` +
      `📋 Тариф: ${planLabel}\n` +
      `${expiresLine}\n\n` +
      `<b>SOCKS5 подключение:</b>\n` +
      `<code>${record.serverIp}:${record.socksPort}</code>\n` +
      `Логин: <code>${record.login}</code>\n` +
      `Пароль: <code>${record.password}</code>\n\n` +
      `<b>HTTP подключение:</b>\n` +
      `<code>${record.serverIp}:${record.httpPort}</code>\n\n` +
      `👇 Нажмите кнопку ниже, чтобы мгновенно добавить прокси в Telegram:`,
    reply_markup: {
      inline_keyboard: [
        [{ text: '🔗 Добавить прокси в Telegram', url: deepLink }],
        [{ text: '🔄 Сменить IP', callback_data: `change_ip:${record.portID}:${record.serverName}` }]
      ]
    }
  };
}

// ---- Telegram message handlers ----

async function handleStart(chatId) {
  // Clear any active speed test session
  delete speedTestSessions[chatId];

  const text =
    `🛡 <b>Proxies.Rent — Прокси для Telegram</b>\n\n` +
    `Стабильный доступ к Telegram при любых ограничениях.\n\n` +
    `🔒 Мобильные SOCKS5-прокси\n` +
    `⚡ Мгновенное подключение в 1 клик\n` +
    `🔄 Смена IP по кнопке\n` +
    `📶 Работа через 4G-модемы\n\n` +
    `Используйте меню ниже для навигации:`;

  await tgSend(chatId, text, { reply_markup: KB_MAIN });
}

async function handleShowPlans(chatId) {
  const text =
    `📋 <b>Тарифы</b>\n\n` +
    `<b>1 месяц</b> — ${PLANS['1m'].price} ₽/мес\n` +
    `<b>6 месяцев</b> — ${PLANS['6m'].price} ₽/мес (выгода 17%)\n` +
    `<b>12 месяцев</b> — ${PLANS['12m'].price} ₽/мес (выгода 33%)\n\n` +
    `Мобильный SOCKS5-прокси с мгновенным подключением.\nВыберите тариф на клавиатуре ниже:`;

  await tgSend(chatId, text, { reply_markup: KB_PLANS });
}

async function handleBuy(chatId, username, planKey) {
  const plan = PLANS[planKey];
  if (!plan) return;

  const user = getTgUser(chatId, username);

  // Find existing active proxy for this user
  const existing = tgProxies.find(p => p.chatId === chatId);

  // Test plan: only ONE TIME per account ever
  if (planKey === 'test') {
    if (user.testUsed) {
      return tgSend(chatId, '⚠️ Тестовый доступ можно активировать только один раз.\n\nОформите подписку для получения прокси:', { reply_markup: KB_PLANS });
    }
    if (existing) {
      return tgSend(chatId, '⚠️ У вас уже есть активный прокси.', { reply_markup: KB_MAIN });
    }
    // Mark test as used BEFORE creating
    user.testUsed = true;
    user.plan = 'test';
    saveTgUsers();

    await tgSend(chatId, '⏳ Создаю ваш прокси...');
    try {
      const record = await createProxyForTelegram(chatId, username, planKey);
      const msg = formatProxyMessage(record, plan.label);
      await tgSend(chatId, msg.text, { reply_markup: msg.reply_markup });
      await tgSend(chatId, '👆 Нажмите «Добавить прокси в Telegram» для подключения в 1 клик.', { reply_markup: KB_MAIN });
    } catch (e) {
      console.error(`[TelegramBot] Create proxy error for ${username || chatId}:`, e.message);
      await tgSend(chatId, `❌ Ошибка при создании прокси: ${e.message}\n\nПопробуйте позже или обратитесь в поддержку.`, { reply_markup: KB_MAIN });
    }
    return;
  }

  // Paid plan: update user record
  user.plan = planKey;
  saveTgUsers();

  // If user already has an active proxy — extend it
  if (existing) {
    const currentExpiry = new Date(existing.expiresAt).getTime();
    const base = Math.max(currentExpiry, Date.now());
    const baseDate = new Date(base);
    const newExpiry = new Date(Date.UTC(baseDate.getUTCFullYear(), baseDate.getUTCMonth(), baseDate.getUTCDate() + plan.days + 1, 0, 0, 0));

    existing.expiresAt = newExpiry.toISOString();
    existing.plan = planKey;
    existing.notified_7d = false;
    existing.notified_1d = false;
    delete existing.npsLastSent;
    saveTgProxies();

    const expiresDate = newExpiry.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC' });
    console.log(`[TelegramBot] Extended proxy ${existing.portID} for @${username || chatId} (plan: ${planKey}, expires: ${expiresDate})`);

    const deepLink = `https://t.me/socks?server=${existing.serverIp}&port=${existing.socksPort}&user=${existing.login}&pass=${existing.password}`;
    await tgSend(chatId,
      `✅ <b>Подписка продлена!</b>\n\n` +
      `📋 Тариф: ${plan.label}\n` +
      `⏳ Действует до: ${expiresDate}\n\n` +
      `Ваши реквизиты не изменились:\n` +
      `SOCKS5: <code>${existing.serverIp}:${existing.socksPort}</code>\n` +
      `Логин: <code>${existing.login}</code>\n` +
      `Пароль: <code>${existing.password}</code>`,
      { reply_markup: { inline_keyboard: [
        [{ text: '🔗 Добавить прокси в Telegram', url: deepLink }],
        [{ text: '🔄 Сменить IP', callback_data: `change_ip:${existing.portID}:${existing.serverName}` }]
      ] } }
    );
    await tgSend(chatId, '👍 Прокси продлён. Реквизиты прежние — ничего менять не нужно.', { reply_markup: KB_MAIN });
    return;
  }

  // No existing proxy — create new one
  await tgSend(chatId, '⏳ Создаю ваш прокси...');
  try {
    const record = await createProxyForTelegram(chatId, username, planKey);
    const msg = formatProxyMessage(record, plan.label);
    await tgSend(chatId, msg.text, { reply_markup: msg.reply_markup });
    await tgSend(chatId, '👆 Нажмите «Добавить прокси в Telegram» для подключения в 1 клик.', { reply_markup: KB_MAIN });
  } catch (e) {
    console.error(`[TelegramBot] Create proxy error for ${username || chatId}:`, e.message);
    await tgSend(chatId, `❌ Ошибка при создании прокси: ${e.message}\n\nПопробуйте позже или обратитесь в поддержку.`, { reply_markup: KB_MAIN });
  }
}

async function handleMyProxies(chatId) {
  const userProxies = tgProxies.filter(p => p.chatId === chatId);
  if (userProxies.length === 0) {
    return tgSend(chatId, '📱 У вас пока нет активных прокси.\n\nИспользуйте меню ниже, чтобы получить прокси.', { reply_markup: KB_MAIN });
  }

  let text = '📱 <b>Ваши прокси:</b>\n\n';
  const buttons = [];

  for (const p of userProxies) {
    const plan = PLANS[p.plan] || { label: p.plan };
    const deepLink = `https://t.me/socks?server=${p.serverIp}&port=${p.socksPort}&user=${p.login}&pass=${p.password}`;

    text += `<b>${plan.label}</b>\n`;
    text += `SOCKS5: <code>${p.serverIp}:${p.socksPort}</code>\n`;
    text += `Логин: <code>${p.login}</code> | Пароль: <code>${p.password}</code>\n`;
    if (p.plan === 'test') {
      text += `⏳ Тестовый доступ (1 день)\n\n`;
    } else {
      const expires = new Date(p.expiresAt).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC' });
      text += `Действует до: ${expires}\n\n`;
    }

    buttons.push([{ text: `🔗 Добавить в Telegram (${p.portID})`, url: deepLink }]);
    buttons.push([{ text: `🔄 Сменить IP (${p.portID})`, callback_data: `change_ip:${p.portID}:${p.serverName}` }]);
  }

  await tgSend(chatId, text, { reply_markup: { inline_keyboard: buttons } });
}

async function handleHelp(chatId) {
  const text =
    `❓ <b>Как подключить и отключить прокси</b>\n\n` +

    `📱 <b>iPhone / iPad:</b>\n` +
    `<b>Включить:</b>\n` +
    `1. Нажмите кнопку «Добавить прокси в Telegram» — он добавится автоматически\n` +
    `2. Или вручную: Настройки → Данные и память → Прокси → Добавить прокси\n` +
    `3. Тип: <b>SOCKS5</b>, введите сервер, порт, логин и пароль\n` +
    `4. Включите тумблер «Использовать прокси»\n\n` +
    `<b>Отключить:</b>\n` +
    `Настройки → Данные и память → Прокси → выключите тумблер\n\n` +

    `📱 <b>Android:</b>\n` +
    `<b>Включить:</b>\n` +
    `1. Нажмите кнопку «Добавить прокси в Telegram» — он добавится автоматически\n` +
    `2. Или вручную: ≡ Меню → Настройки → Данные и память → Прокси-сервер\n` +
    `3. Нажмите «Добавить прокси», тип: <b>SOCKS5</b>\n` +
    `4. Введите сервер, порт, логин и пароль\n\n` +
    `<b>Отключить:</b>\n` +
    `≡ Настройки → Данные и память → Прокси-сервер → выключите тумблер\n\n` +

    `💻 <b>Telegram Desktop (ПК):</b>\n` +
    `<b>Включить:</b>\n` +
    `1. Нажмите кнопку «Добавить прокси в Telegram»\n` +
    `2. Или: Настройки → Продвинутые настройки → Тип соединения → Прокси\n` +
    `3. Добавить, тип SOCKS5, заполнить данные\n\n` +
    `<b>Отключить:</b>\n` +
    `Настройки → Продвинутые настройки → Тип соединения → отключить прокси\n\n` +

    `💡 <b>Подсказки:</b>\n` +
    `• Если прокси не подключается — нажмите «Сменить IP» и попробуйте снова\n` +
    `• Прокси работает только в Telegram, остальные приложения используют обычный интернет\n` +
    `• При смене IP может потребоваться 10-30 секунд для переподключения`;

  await tgSend(chatId, text, { reply_markup: KB_MAIN });
}

function telegramSendDocument(chatId, fileBuffer, filename, caption) {
  return new Promise((resolve, reject) => {
    const boundary = 'boundary' + crypto.randomBytes(16).toString('hex');

    const parts = [];
    parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n${chatId}`);
    if (caption) {
      parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="caption"\r\n\r\n${caption}`);
      parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="parse_mode"\r\n\r\nHTML`);
    }
    const preamble = Buffer.from(parts.join('\r\n') + `\r\n--${boundary}\r\nContent-Disposition: form-data; name="document"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`);
    const epilogue = Buffer.from(`\r\n--${boundary}--\r\n`);
    const fullBody = Buffer.concat([preamble, fileBuffer, epilogue]);

    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${TG_TOKEN}/sendDocument`,
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': fullBody.length
      },
      timeout: 60000
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { resolve({ ok: false, raw: data }); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Telegram sendDocument timeout')); });
    req.write(fullBody);
    req.end();
  });
}

async function handleSpeedTest(chatId) {
  const userProxy = tgProxies.find(p => p.chatId === chatId);
  if (!userProxy) {
    return tgSend(chatId, '❌ У вас нет активных прокси. Сначала подключите прокси, чтобы замерить скорость.', { reply_markup: KB_MAIN });
  }

  await tgSend(chatId, '🚀 <b>Тест скорости</b>\n\nСейчас отправлю тестовый файл (10 МБ).\nСкачайте его и сразу нажмите «✅ Скачал!»', { reply_markup: KB_SPEED });

  try {
    let sendResult;
    if (speedTestFileId) {
      // Reuse cached file_id
      sendResult = await telegramApi('sendDocument', { chat_id: chatId, document: speedTestFileId });
    } else {
      // First time: generate and upload random file
      const testBuffer = crypto.randomBytes(SPEED_TEST_SIZE);
      sendResult = await telegramSendDocument(chatId, testBuffer, 'speedtest_10mb.bin');
      if (sendResult.ok && sendResult.result?.document?.file_id) {
        speedTestFileId = sendResult.result.document.file_id;
        console.log(`[TelegramBot] Speed test file cached, file_id: ${speedTestFileId}`);
      }
    }

    if (!sendResult.ok) {
      console.error('[TelegramBot] Failed to send speed test file:', sendResult);
      return tgSend(chatId, '❌ Не удалось отправить тестовый файл. Попробуйте позже.', { reply_markup: KB_MAIN });
    }

    // Record session start time
    speedTestSessions[chatId] = { startTime: Date.now(), fileSize: SPEED_TEST_SIZE };
  } catch (e) {
    console.error('[TelegramBot] Speed test error:', e.message);
    await tgSend(chatId, '❌ Ошибка при отправке тестового файла. Попробуйте позже.', { reply_markup: KB_MAIN });
  }
}

async function handleSpeedDone(chatId) {
  const session = speedTestSessions[chatId];
  if (!session) {
    return tgSend(chatId, '❓ Нет активного теста скорости. Нажмите «🚀 Скорость» чтобы начать.', { reply_markup: KB_MAIN });
  }

  const elapsed = (Date.now() - session.startTime) / 1000;
  const speedMbps = (session.fileSize * 8 / elapsed / 1_000_000).toFixed(1);
  const fileSizeMB = (session.fileSize / 1_048_576).toFixed(0);

  delete speedTestSessions[chatId];

  // Save speed test result to user record
  const user = getTgUser(chatId, null);
  user.speedTests.push({ speed: parseFloat(speedMbps), date: new Date().toISOString() });
  saveTgUsers();

  const text =
    `🚀 <b>Результат теста скорости</b>\n\n` +
    `⬇️ Скорость скачивания: <b>${speedMbps} Мбит/с</b>\n` +
    `📦 Размер файла: ${fileSizeMB} МБ\n` +
    `⏱ Время загрузки: ${elapsed.toFixed(1)} сек\n\n` +
    `💡 <i>Результат приблизительный и зависит от скорости вашего интернета + прокси</i>`;

  await tgSend(chatId, text, { reply_markup: KB_MAIN });
}

async function handleChangeIp(chatId, portID, serverName) {
  const record = tgProxies.find(p => p.portID === portID && p.chatId === chatId);
  if (!record) return tgSend(chatId, '❌ Прокси не найден.');

  try {
    const server = findServer(serverName);
    if (!server) throw new Error('Сервер не найден');

    // Find modem IMEI for this port to get its nick
    const results = await fetchAllServersData();
    let nick = null;
    for (const data of results) {
      if (data.serverName !== serverName) continue;
      if (Array.isArray(data.status)) {
        for (const m of data.status) {
          if (m.modem_details?.IMEI === record.imei) {
            nick = m.modem_details.NICK;
            break;
          }
        }
      }
    }

    if (nick) {
      await fetchApi(server, `/apix/reset_modem?arg=${encodeURIComponent(nick)}`, 30000);
    } else {
      await fetchApi(server, `/apix/reset_modem_by_imei?IMEI=${encodeURIComponent(record.imei)}`, 30000);
    }

    await tgSend(chatId, '✅ IP-адрес меняется. Это может занять 10-30 секунд.');
  } catch (e) {
    await tgSend(chatId, `❌ Ошибка смены IP: ${e.message}`);
  }
}

// ---- Feedback & NPS handlers ----

function ratingKeyboard(type) {
  return {
    inline_keyboard: [
      [1,2,3,4,5].map(n => ({ text: String(n), callback_data: `rate:${type}:${n}` })),
      [6,7,8,9,10].map(n => ({ text: String(n), callback_data: `rate:${type}:${n}` }))
    ]
  };
}

async function handleFeedback(chatId) {
  userStates[chatId] = { state: 'awaiting_feedback' };
  await tgSend(chatId,
    '💬 <b>Обратная связь</b>\n\nКак мы можем стать для вас лучше?\nНапишите ваше сообщение:',
    { reply_markup: { keyboard: [['◀️ Отмена']], resize_keyboard: true } }
  );
}

async function handleFeedbackText(chatId, username, text) {
  const state = userStates[chatId];
  if (!state) return false;

  if (state.state === 'awaiting_feedback') {
    delete userStates[chatId];
    tgFeedback.push({
      chatId, username: username || null,
      type: 'feedback',
      message: text,
      createdAt: new Date().toISOString()
    });
    saveTgFeedback();
    await tgSend(chatId, '✅ Спасибо за обратную связь! Мы обязательно учтём ваше мнение.', { reply_markup: KB_MAIN });
    return true;
  }

  if (state.state === 'awaiting_nps_comment') {
    // Save comment to the existing feedback record
    const lastRecord = tgFeedback.filter(f => f.chatId === chatId && f.type === state.type).pop();
    if (lastRecord) lastRecord.comment = text;
    saveTgFeedback();
    delete userStates[chatId];
    await tgSend(chatId, '✅ Спасибо за комментарий!', { reply_markup: KB_MAIN });
    return true;
  }

  return false;
}

async function handleRating(chatId, username, type, score) {
  tgFeedback.push({
    chatId, username: username || null,
    type, // 'nps' | 'satisfaction'
    score,
    createdAt: new Date().toISOString()
  });
  saveTgFeedback();

  if (type === 'satisfaction') {
    await tgSend(chatId,
      `✅ Спасибо за оценку <b>${score}/10</b>!\n\nОформите подписку, чтобы продолжить пользоваться прокси.`,
      { reply_markup: KB_MAIN }
    );
  } else {
    // NPS — ask for optional comment
    userStates[chatId] = { state: 'awaiting_nps_comment', type };
    await tgSend(chatId,
      `✅ Спасибо за оценку <b>${score}/10</b>!\n\nЕсли хотите добавить комментарий — просто напишите его.\nИли нажмите любую кнопку меню для продолжения.`,
      { reply_markup: KB_MAIN }
    );
  }
}

// ---- Expiration checker ----

async function checkTgProxyExpirations() {
  const now = Date.now();

  for (const record of [...tgProxies]) {
    const expiresAt = new Date(record.expiresAt).getTime();
    const remaining = expiresAt - now;

    if (remaining <= 0) {
      // Expired — delete
      console.log(`[TelegramBot] Proxy ${record.portID} expired, removing...`);
      await deleteProxyRecord(record, true);
      continue;
    }

    // Test plan: satisfaction survey 1 hour before expiry
    if (record.plan === 'test' && !record.satisfactionSent && remaining <= 60 * 60 * 1000 && remaining > 0) {
      record.satisfactionSent = true;
      saveTgProxies();
      await tgSend(record.chatId,
        '⏰ <b>Через 1 час тестовый прокси будет отключён</b>\n\nОцените качество прокси от 1 до 10:',
        { reply_markup: ratingKeyboard('satisfaction') }
      );
    }

    // 7-day notification
    if (!record.notified_7d && remaining <= 7 * 86400000 && record.plan !== 'test') {
      record.notified_7d = true;
      saveTgProxies();
      await tgSend(record.chatId,
        '📢 <b>Напоминание</b>\n\nВаша подписка заканчивается через 7 дней. Нажмите «📋 Тарифы», чтобы продлить!',
        { reply_markup: KB_MAIN }
      );
    }

    // 1-day notification
    if (!record.notified_1d && remaining <= 86400000 && record.plan !== 'test') {
      record.notified_1d = true;
      saveTgProxies();
      await tgSend(record.chatId,
        '🔴 <b>Подписка заканчивается завтра!</b>\n\nНажмите «📋 Тарифы», чтобы продлить прокси!',
        { reply_markup: KB_MAIN }
      );
    }

    // Monthly NPS survey (every 30 days for paid plans)
    if (record.plan !== 'test' && remaining > 0) {
      const lastNps = record.npsLastSent ? new Date(record.npsLastSent).getTime() : 0;
      if (now - lastNps > 30 * 86400000) {
        record.npsLastSent = new Date().toISOString();
        saveTgProxies();
        await tgSend(record.chatId,
          '📊 <b>Мы хотим стать лучше!</b>\n\nНасколько вы порекомендуете наш сервис друзьям?\nОт 1 (точно нет) до 10 (обязательно порекомендую):',
          { reply_markup: ratingKeyboard('nps') }
        );
      }
    }
  }
}

// ---- Long polling ----

function startTelegramPolling() {
  let offset = 0;

  async function poll() {
    try {
      const data = await telegramApi('getUpdates', { offset, timeout: 30 }, 35000);
      if (data.ok && Array.isArray(data.result)) {
        for (const update of data.result) {
          offset = update.update_id + 1;
          try {
            await processUpdate(update);
          } catch (e) {
            console.error('[TelegramBot] Error processing update:', e.message);
          }
        }
      }
    } catch (e) {
      console.error('[TelegramBot] Polling error:', e.message);
      await new Promise(r => setTimeout(r, 5000));
    }
    setImmediate(poll);
  }

  async function processUpdate(update) {
    if (update.message) {
      const msg = update.message;
      const chatId = msg.chat.id;
      const text = (msg.text || '').trim();
      const username = msg.from?.username || null;

      // Slash commands
      if (text === '/start') { delete userStates[chatId]; return handleStart(chatId); }
      if (text === '/help') return handleHelp(chatId);
      if (text === '/myproxies') return handleMyProxies(chatId);

      // Reply keyboard buttons
      if (text === '🎁 Тест (1 день)')           { delete userStates[chatId]; return handleBuy(chatId, username, 'test'); }
      if (text === '📋 Тарифы')                 { delete userStates[chatId]; return handleShowPlans(chatId); }
      if (text === '📱 Мои прокси')             { delete userStates[chatId]; return handleMyProxies(chatId); }
      if (text === '🚀 Скорость')               { delete userStates[chatId]; return handleSpeedTest(chatId); }
      if (text === '❓ Инструкция')              { delete userStates[chatId]; return handleHelp(chatId); }
      if (text === '💬 Обратная связь')          return handleFeedback(chatId);
      if (text === '◀️ Назад' || text === '◀️ Отмена') {
        delete speedTestSessions[chatId];
        delete userStates[chatId];
        return handleStart(chatId);
      }
      if (text === '✅ Скачал!')                 return handleSpeedDone(chatId);
      if (text === '📅 1 мес — 599 ₽')          { delete userStates[chatId]; return handleBuy(chatId, username, '1m'); }
      if (text === '📅 6 мес — 499 ₽/мес')      { delete userStates[chatId]; return handleBuy(chatId, username, '6m'); }
      if (text === '📅 12 мес — 399 ₽/мес')     { delete userStates[chatId]; return handleBuy(chatId, username, '12m'); }

      // State-based text handling (feedback/NPS comment)
      if (userStates[chatId] && text) {
        const handled = await handleFeedbackText(chatId, username, text);
        if (handled) return;
      }
    }

    if (update.callback_query) {
      const cb = update.callback_query;
      const chatId = cb.message?.chat?.id || cb.from?.id;
      const username = cb.from?.username || null;
      const data = cb.data || '';

      // Answer callback to remove loading spinner
      telegramApi('answerCallbackQuery', { callback_query_id: cb.id }).catch(() => {});

      // Rating callbacks (NPS / satisfaction)
      if (data.startsWith('rate:')) {
        const parts = data.split(':');
        const type = parts[1]; // 'nps' or 'satisfaction'
        const score = parseInt(parts[2]);
        return handleRating(chatId, username, type, score);
      }

      // Change IP per-proxy
      if (data.startsWith('change_ip:')) {
        const parts = data.split(':');
        return handleChangeIp(chatId, parts[1], parts[2]);
      }
    }
  }

  // Start polling
  console.log('[TelegramBot] Starting long polling...');
  poll();

  // Expiration checker every 10 minutes
  checkTgProxyExpirations();
  setInterval(checkTgProxyExpirations, 10 * 60 * 1000);
}

if (TG_TOKEN) {
  startTelegramPolling();
}
