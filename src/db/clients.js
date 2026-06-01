'use strict';
// src/db/clients.js — repository for the `clients` table itself.
//
// Owns the upsert / delete / balance / referral helpers. The full
// saveClients() transaction still lives in server.js because it spans
// multiple repos (payments, documents) inside one db.transaction — but
// those repos are also wired through their own modules, so server.js
// has no inline `db.prepare()` for clients anymore.

let S = {};

function init(db) {
  // NB: balance is deliberately NOT updated on conflict — it's owned by
  // atomicCredit/atomicDebit/updateBalance only. Including it caused a real
  // bug once (ВАЙЛДБОКС: -8766.45 silently → 0 when saveClients raced billing).
  // Keep this in lockstep with the original SQL or that race comes back.
  S.upsert = db.prepare(`INSERT INTO clients (id, login, password, password_hash, port_name, name, contact, notes,
    billing_type, price, currency, balance, api_key, referral_code, referred_by, referral_balance,
    reset_token, inn, kpp, legal_name, contract_info, address, auto_acts, auto_bills,
    last_traffic_snapshot, created_at, client_type, billing_paused, allow_debt, max_debt,
    sla_uptime_pct, sla_max_latency_ms, sla_max_error_pct, sla_auto_credit, contract_date)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      login=excluded.login, password=excluded.password, password_hash=excluded.password_hash,
      port_name=excluded.port_name, name=excluded.name, contact=excluded.contact,
      notes=excluded.notes, billing_type=excluded.billing_type, price=excluded.price,
      currency=excluded.currency,
      api_key=excluded.api_key,
      referral_code=excluded.referral_code, referred_by=excluded.referred_by,
      referral_balance=excluded.referral_balance, reset_token=excluded.reset_token,
      inn=excluded.inn, kpp=excluded.kpp, legal_name=excluded.legal_name,
      contract_info=excluded.contract_info, address=excluded.address,
      auto_acts=excluded.auto_acts, auto_bills=excluded.auto_bills,
      last_traffic_snapshot=excluded.last_traffic_snapshot, client_type=excluded.client_type,
      billing_paused=excluded.billing_paused, allow_debt=excluded.allow_debt,
      max_debt=excluded.max_debt,
      sla_uptime_pct=excluded.sla_uptime_pct,
      sla_max_latency_ms=excluded.sla_max_latency_ms,
      sla_max_error_pct=excluded.sla_max_error_pct,
      sla_auto_credit=excluded.sla_auto_credit,
      contract_date=excluded.contract_date,
      updated_at=datetime('now')`);

  S.deleteById = db.prepare('DELETE FROM clients WHERE id = ?');
  S.allIds = db.prepare('SELECT id FROM clients');
  // Stage 8: full-rows load used at boot to rebuild the in-memory clients
  // array. Previously inlined in server.js's loadClients().
  S.allRows = db.prepare('SELECT * FROM clients');
  S.getBalance = db.prepare('SELECT balance FROM clients WHERE id = ?');
  S.updateBalance = db.prepare(
    "UPDATE clients SET balance = ?, updated_at = datetime('now') WHERE id = ?"
  );
  S.updateReferralBalance = db.prepare(
    "UPDATE clients SET referral_balance = ?, updated_at = datetime('now') WHERE id = ?"
  );
}

function upsertRow(c) {
  return S.upsert.run(
    c.id, c.login, null, c.passwordHash || '', c.portName || '', c.name || '',
    c.contact || '', c.notes || '', c.billingType || 'per_gb', c.price || 0,
    c.currency || 'RUB', c.balance || 0, c.apiKey || '', c.referral_code || '',
    c.referred_by || null, c.referral_balance || 0, c.resetToken || '',
    c.inn || '', c.kpp || '', c.legalName || '', c.contractInfo || '',
    c.address || '', c.autoActs !== false ? 1 : 0, c.autoBills !== false ? 1 : 0,
    JSON.stringify(c.last_traffic_snapshot || {}), c.createdAt || new Date().toISOString(),
    c.clientType || 'legal', c.billingPaused ? 1 : 0,
    c.allowDebt ? 1 : 0,
    typeof c.maxDebt === 'number' ? c.maxDebt : null,
    typeof c.slaUptimePct    === 'number' ? c.slaUptimePct    : 99,
    typeof c.slaMaxLatencyMs === 'number' ? c.slaMaxLatencyMs : 1000,
    typeof c.slaMaxErrorPct  === 'number' ? c.slaMaxErrorPct  : 5,
    c.slaAutoCredit ? 1 : 0,
    c.contractDate || ''   // #4 settlement date (mig 036)
  );
}

function deleteById(id) { return S.deleteById.run(id); }
function allIds() { return S.allIds.all(); }
function allRows() { return S.allRows.all(); }

// These three are passed to billing.init() so atomicCredit/atomicDebit
// can read/write balance atomically. Exposed as the raw prepared
// statements (not function wrappers) because billing/atomic.js was
// designed against the prepared-statement interface — wrapping would
// add a function call per credit/debit on the hot billing path.
function getBalanceStmt() { return S.getBalance; }
function updateBalanceStmt() { return S.updateBalance; }
function updateReferralBalanceStmt() { return S.updateReferralBalance; }

module.exports = {
  init, upsertRow, deleteById, allIds, allRows,
  getBalanceStmt, updateBalanceStmt, updateReferralBalanceStmt,
};
