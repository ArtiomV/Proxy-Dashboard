'use strict';
//
// src/routes/client-portal.js — client-facing endpoints (Stage 3).
//
// 16 routes used by the client SPA (public/index.html):
//   /api/dashboard_data, /api/billing_history,
//   /api/client/{reset_ip, reset_ip_by_token, rotation_log, set_rotation,
//                 ip_history, credentials_export, referral, documents,
//                 documents/:docId/download, closing_documents,
//                 closing_documents/:docId/pdf, bills, bills/:billId/pdf}
//
// Most require authMiddleware (session token). reset_ip_by_token uses
// the resetTokenLimiter (separate rate limit + token-based auth instead
// of session) and is also exposed as GET for convenience.

const express = require('express');

module.exports = function createClientPortalRouter(deps) {
  const {
    db, logger, authMiddleware, dashboardLimiter, resetTokenLimiter,
    fetchAllServersDataCached, mergeServerData, fetchApi, postApi, findServer,
    extractServerName,
    getMoscowToday, getMoscowNow, trafficBytesToGb, parseBwToBytes, parseTrafficValue,
    ledgerExpense,
    SERVER_COUNTRIES,
    syncRotationLog, _rlSelect,
    apiServers,
    clients, clientById, clientByLogin, clientByApiKey, clientByResetToken,
    dailyTraffic, billingLedger, ipTracking, uptimeTracking, ipHistory,
    getSpeedtestLatest,
    auditLog, logActivity, getClientIp,
    saveClients,
  } = deps;
  const r = express.Router();

r.get('/api/dashboard_data', dashboardLimiter, authMiddleware, async (req, res) => {
  try {
    const results = await fetchAllServersDataCached();
    const merged = mergeServerData(results, req.user.portNameFilter);
    const clientInfo = clientByLogin.get(req.user.login);
    if (clientInfo) {
      const totalPayments = (clientInfo.payments || []).reduce((sum, p) => sum + (parseFloat(p.amount) || 0), 0);
      // Current month expense from billing ledger
      const ledgerEntries = billingLedger[clientInfo.id] || [];
      const currentMonthPrefix = getMoscowToday().slice(0, 7);
      const monthExpense = ledgerEntries
        .filter(e => (e.type === 'charge' || e.type === 'correction') && e.date && e.date.startsWith(currentMonthPrefix))
        .reduce((sum, e) => sum + ledgerExpense(e), 0);

      // Live month traffic from ProxySmart
      let liveMonthBytes = 0;
      for (const [bwKey, bwData] of Object.entries(merged.bandwidth || {})) {
        liveMonthBytes += parseBwToBytes(bwData.bandwidth_bytes_month_in);
        liveMonthBytes += parseBwToBytes(bwData.bandwidth_bytes_month_out);
      }
      const liveMonthGb = trafficBytesToGb(liveMonthBytes);

      // Billed month GB from ledger (for comparison)
      const billedMonthGb = ledgerEntries
        .filter(e => (e.type === 'charge' || e.type === 'correction') && e.date && e.date.startsWith(currentMonthPrefix))
        .reduce((sum, e) => sum + (e.delta_gb || 0), 0);

      // Last hour traffic from traffic_hourly for this client's portName —
      // single bulk query with scalar subquery to compute max hour once.
      let lastHourGb = 0;
      if (clientInfo.portName) {
        const lhRow = db.prepare(`
          SELECT SUM(bytes_in + bytes_out) as total
          FROM traffic_hourly
          WHERE client_name = ?
            AND hour_start = (SELECT MAX(hour_start) FROM traffic_hourly WHERE client_name = ?)
        `).get(clientInfo.portName, clientInfo.portName);
        if (lhRow && lhRow.total) lastHourGb = trafficBytesToGb(lhRow.total);
      }

      merged.billing = {
        billingType: clientInfo.billingType || 'per_gb',
        price: clientInfo.price || 0,
        currency: clientInfo.currency || 'RUB',
        totalPayments,
        balance: clientInfo.balance !== undefined ? clientInfo.balance : totalPayments,
        monthExpense: Math.round(monthExpense * 100) / 100,
        liveMonthGb,
        billedMonthGb: Math.round(billedMonthGb * 1000) / 1000,
        lastHourGb,
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

      const cutoff30 = new Date(Date.now() - 30 * 86400000).toLocaleDateString('en-CA');

      for (const imei of clientImeis) {
        if (ipTracking[imei]) filteredIpTracking[imei] = ipTracking[imei];
        if (uptimeTracking[imei]) {
          const ut = uptimeTracking[imei];
          // Compute 30-day uptime from daily buckets
          let online30 = 0, total30 = 0;
          for (const [date, bucket] of Object.entries(ut.daily || {})) {
            if (date >= cutoff30) { online30 += bucket.online; total30 += bucket.total; }
          }
          filteredUptimeTracking[imei] = {
            total_checks: ut.total_checks,
            online_checks: ut.online_checks,
            first_check: ut.first_check,
            uptime30d: total30 > 0 ? Math.round(online30 / total30 * 1000) / 10 : null
          };
        }
        if (speedLatest[imei]) filteredSpeedtest[imei] = speedLatest[imei];
        if (ipHistory[imei]) filteredIpHistory[imei] = ipHistory[imei];
      }

      merged.ipTracking = filteredIpTracking;
      merged.uptimeTracking = filteredUptimeTracking;
      merged.speedtestLatest = filteredSpeedtest;
      merged.ipHistory = filteredIpHistory;
    }

    // Include server info for client portal (needed for IP addresses)
    merged.servers = apiServers.map(s => ({
      name: s.name, publicIp: s.publicIp,
      country: (SERVER_COUNTRIES[s.name] || {}).country || '',
      countryName: (SERVER_COUNTRIES[s.name] || {}).name || s.name
    }));

    res.json(merged);
  } catch (err) {
    res.status(502).json({ error: 'API request failed', details: err.message });
  }
});

r.get('/api/billing_history', authMiddleware, (req, res) => {
  const clientInfo = clientByLogin.get(req.user.login);
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
  const totalCharges = allEntries.filter(e => e.type === 'charge' || e.type === 'correction').reduce((sum, e) => sum + ledgerExpense(e), 0);
  const totalPayments = allEntries.filter(e => e.type === 'payment').reduce((sum, e) => sum + (e.amount || 0), 0);

  // Current month summary
  const currentMonthPrefix = new Date().toISOString().slice(0, 7);
  const monthCharges = allEntries
    .filter(e => (e.type === 'charge' || e.type === 'correction') && e.date && e.date.startsWith(currentMonthPrefix))
    .reduce((sum, e) => sum + ledgerExpense(e), 0);

  // Average daily charge over last 7 days: sum charges for days [today-7 .. today-1] / 7
  const today = getMoscowToday(); // "YYYY-MM-DD"
  const d7 = getMoscowNow();
  d7.setDate(d7.getDate() - 7);
  const sevenDaysAgoStr = d7.toLocaleDateString('en-CA'); // exclusive lower bound
  const last7dTotal = allEntries
    .filter(e => (e.type === 'charge' || e.type === 'correction') && e.date && e.date > sevenDaysAgoStr && e.date < today)
    .reduce((sum, e) => sum + ledgerExpense(e), 0);
  const avgDailyCharge7d = Math.round((last7dTotal / 7) * 100) / 100;

  res.json({
    balance: clientInfo.balance,
    currency: clientInfo.currency || 'RUB',
    summary: {
      totalCharges: Math.round(totalCharges * 100) / 100,
      totalPayments: Math.round(totalPayments * 100) / 100,
      monthCharges: Math.round(monthCharges * 100) / 100,
      avgDailyCharge7d,
      daysUntilZero: avgDailyCharge7d > 0 ? Math.floor(clientInfo.balance / avgDailyCharge7d) : null
    },
    
    entries: filtered.map(({ db_id, ...e }) => e)
  });
});

r.post('/api/client/reset_ip', authMiddleware, async (req, res) => {
  try {
    const { imei, serverName } = req.body;
    if (!imei || !serverName) return res.status(400).json({ error: 'imei and serverName required' });
    // Verify client owns this modem
    const pnf = req.user.portNameFilter;
    if (pnf !== '*') {
      const results = await fetchAllServersDataCached();
      const merged = mergeServerData(results, pnf);
      if (!merged.ports[imei]) return res.status(403).json({ error: 'Modem not assigned to this client' });
    }
    const server = findServer(serverName);
    if (!server) return res.status(400).json({ error: 'Server not found' });
    const result = await fetchApi(server, `/apix/reset_modem_by_imei?IMEI=${encodeURIComponent(imei)}`);
    const success = result && result.result === 'success';
    auditLog(req.user.login, 'client_reset_ip', { imei, serverName, ip: getClientIp(req), success });
    if (success) {
      res.json({ ok: true, result });
    } else {
      res.json({ ok: false, error: result?.message || 'Reset failed', result });
    }
  } catch (err) { res.status(502).json({ ok: false, error: 'Reset failed', details: err.message }); }
});

const _resetIpHandler = async (req, res) => {
  const nick = (req.body && req.body.nick) || req.query.nick;
  const token = (req.body && req.body.token) || req.query.token;
  req.query.nick = nick; req.query.token = token; // for downstream code
  return _resetIpImpl(req, res);
};

r.post('/api/client/reset_ip_by_token', resetTokenLimiter, _resetIpHandler);
r.get('/api/client/reset_ip_by_token', resetTokenLimiter, _resetIpHandler);

async function _resetIpImpl(req, res) {
  const { nick, token } = req.query;
  if (!nick || !token) return res.status(400).json({ error: 'nick and token required' });
  const client = clientByResetToken.get(token);
  if (!client) return res.status(401).json({ error: 'Invalid token' });
  // Verify nick belongs to this client's portName
  const allowed = db.prepare("SELECT 1 FROM traffic_hourly WHERE nick = ? AND client_name = ? LIMIT 1").get(nick, client.portName);
  if (!allowed) return res.status(403).json({ error: 'Modem not assigned to this client' });
  // Try all servers
  for (const server of apiServers) {
    try {
      const result = await fetchApi(server, `/apix/reset_modem?arg=${encodeURIComponent(nick)}`);
      if (result) return res.json({ ok: true, result });
    } catch (e) { /* try next server */ }
  }
  res.status(404).json({ error: 'Modem not found' });
}

r.get('/api/client/rotation_log', authMiddleware, async (req, res) => {
  try {
    const { nick, serverName } = req.query;
    if (!nick || !serverName) return res.status(400).json({ error: 'nick and serverName required' });
    // Verify client owns this modem
    const pnf = req.user.portNameFilter;
    if (pnf !== '*') {
      const allowed = db.prepare("SELECT 1 FROM traffic_hourly WHERE nick = ? AND client_name = ? LIMIT 1").get(nick, pnf);
      if (!allowed) return res.status(403).json({ error: 'Modem not assigned to this client' });
    }
    const server = findServer(serverName);
    if (!server) return res.status(400).json({ error: 'Server not found' });
    // Fetch from ProxySmart and sync to DB (same as admin)
    try {
      const result = await fetchApi(server, `/apix/get_rotation_log?arg=${encodeURIComponent(nick)}`);
      const entries = Array.isArray(result) ? result : (result?.log || result?.logs || result?.data || []);
      syncRotationLog(serverName, nick, entries);
    } catch (fetchErr) { /* serve from DB if ProxySmart fails */ }
    const rows = _rlSelect.all(serverName, nick);
    res.json(rows);
  } catch (err) { res.status(502).json({ error: 'Failed', details: err.message }); }
});

r.post('/api/client/set_rotation', authMiddleware, async (req, res) => {
  try {
    const { nick, serverName, minutes } = req.body;
    if (!nick || !serverName) return res.status(400).json({ error: 'nick and serverName required' });
    const mins = parseInt(minutes);
    if (isNaN(mins) || mins < 0 || mins > 1440) return res.status(400).json({ error: 'minutes must be 0-1440' });

    // Verify modem belongs to this client
    const portNameFilter = req.user.portNameFilter;
    if (portNameFilter === '*') { /* admin — allow */ }
    else {
      const results = await fetchAllServersDataCached();
      const merged = mergeServerData(results, '*');
      if (!merged) return res.status(503).json({ error: 'Data not loaded yet' });
      const allPorts = merged.ports || {};
      let owned = false;
      for (const srv in allPorts) {
        const ports = allPorts[srv] || [];
        for (const p of ports) {
          if (p.portName === portNameFilter) {
            const pNick = (p.portID || '').replace(/^S[12]_/, '');
            if (pNick === nick) { owned = true; break; }
          }
        }
        if (owned) break;
      }
      if (!owned) return res.status(403).json({ error: 'Modem not assigned to your account' });
    }

    const server = findServer(serverName);
    if (!server) return res.status(400).json({ error: 'Server not found' });

    // Get current modem IMEI from status
    const statusData = await fetchApi(server, '/apix/show_status_json');
    const modems = Array.isArray(statusData) ? statusData : [];
    const modem = modems.find(m => m.modem_details && m.modem_details.NICK === nick);
    if (!modem) return res.status(404).json({ error: 'Modem not found' });

    const imei = modem.modem_details.IMEI;
    // Store rotation setting
    await postApi(server, '/crud/store_modem', { IMEI: imei, AUTO_IP_ROTATION: String(mins) });
    // Apply settings
    await postApi(server, '/modem/settings', { imei });

    logger.info(`[Rotation] Client ${req.user.login} set ${nick} rotation to ${mins} min`);
    auditLog(req.user.login, 'client_set_rotation', { nick, serverName, minutes: mins, ip: getClientIp(req) });
    res.json({ ok: true, minutes: mins });
  } catch (err) { res.status(502).json({ error: 'Failed to set rotation', details: err.message }); }
});

r.get('/api/client/ip_history', authMiddleware, async (req, res) => {
  const { key } = req.query;
  if (!key) return res.status(400).json({ error: 'key required' });
  // Verify client owns this modem (key is IMEI)
  const pnf = req.user.portNameFilter;
  if (pnf !== '*') {
    const results = await fetchAllServersDataCached();
    const merged = mergeServerData(results, pnf);
    if (!merged.ports[key]) return res.status(403).json({ error: 'Modem not assigned to this client' });
  }
  res.json(ipHistory[key] || []);
});

r.get('/api/client/credentials_export', authMiddleware, async (req, res) => {
  try {
    const results = await fetchAllServersDataCached();
    const merged = mergeServerData(results, req.user.portNameFilter);

    const COUNTRIES = SERVER_COUNTRIES;
    // Build server URL map for direct reset URLs
    const credentials = [];

    for (const [imei, portList] of Object.entries(merged.ports)) {
      const serverName = extractServerName(imei);
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

    // SEC: serverInfo with user/pass removed — clients use /api/client/reset_ip instead
    const clientInfo = clientByLogin.get(req.user.login);
    auditLog(req.user.login, 'client_export_creds', { count: credentials.length, ip: getClientIp(req) });
    res.json({
      credentials,
      clientName: req.user.login,
      exportDate: new Date().toISOString(),
      resetToken: clientInfo ? clientInfo.resetToken : ''
    });
  } catch (err) { res.status(502).json({ error: 'Export failed', details: err.message }); }
});

r.get('/api/client/referral', authMiddleware, (req, res) => {
  const client = clientByLogin.get(req.user.login);
  if (!client) return res.status(404).json({ error: 'Client not found' });
  const referrals = clients.filter(c => c.referred_by === client.id);
  res.json({
    referrals_count: referrals.length,
    referral_balance: client.referral_balance || 0,
    referrals: referrals.map(r => ({ name: r.name, createdAt: r.createdAt }))
  });
});

r.get('/api/client/documents', authMiddleware, (req, res) => {
  const client = clientByLogin.get(req.user.login);
  if (!client) return res.json([]);
  res.json((client.documents || []).map(d => ({ id: d.id, name: d.name, date: d.date })));
});

r.get('/api/client/documents/:docId/download', authMiddleware, (req, res) => {
  const client = clientByLogin.get(req.user.login);
  if (!client) return res.status(404).json({ error: 'Not found' });
  const doc = (client.documents || []).find(d => d.id === req.params.docId);
  if (!doc) return res.status(404).json({ error: 'Document not found' });
  const filePath = path.join(DOCUMENTS_DIR, doc.fileName);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });
  const ext = path.extname(doc.name || doc.fileName);
  const mimeTypes = { '.pdf': 'application/pdf', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.doc': 'application/msword', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.png': 'image/png', '.jpg': 'image/jpeg' };
  res.setHeader('Content-Type', mimeTypes[ext] || 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(doc.name)}`);
  fs.createReadStream(filePath).pipe(res);
});

r.get('/api/client/closing_documents', authMiddleware, (req, res) => {
  const client = clientByLogin.get(req.user.login);
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

r.get('/api/client/closing_documents/:docId/pdf', authMiddleware, async (req, res) => {
  const client = clientByLogin.get(req.user.login);
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

r.get('/api/client/bills', authMiddleware, (req, res) => {
  const client = clientByLogin.get(req.user.login);
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

r.get('/api/client/bills/:billId/pdf', authMiddleware, async (req, res) => {
  const client = clientByLogin.get(req.user.login);
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

  return r;
};
