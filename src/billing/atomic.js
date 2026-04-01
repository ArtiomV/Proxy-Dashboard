'use strict';
let db, _clientGetBalance, _clientUpdateBalance, _ledgerInsert, _ledgerEntryParams, billingLedger, clientById;

function init(deps) {
  db = deps.db;
  _clientGetBalance = deps._clientGetBalance;
  _clientUpdateBalance = deps._clientUpdateBalance;
  _ledgerInsert = deps._ledgerInsert;
  _ledgerEntryParams = deps._ledgerEntryParams;
  billingLedger = deps.billingLedger;
  clientById = deps.clientById;
}

/**
 * atomicCredit — atomically add amount to client balance AND insert ledger entry
 * BUG-02 fix: balance + ledger in single transaction (no partial state)
 * BUG-03 fix: uses clientById.get() for O(1) in-memory sync
 * @param {string} clientId
 * @param {number} amount
 * @param {object} [ledgerEntry] — if provided, inserted in same transaction
 * Returns { balanceBefore, balanceAfter }
 */
function atomicCredit(clientId, amount, ledgerEntry) {
  amount = Math.round(parseFloat(amount) * 100) / 100;
  if (isNaN(amount)) throw new Error('atomicCredit: invalid amount');
  if (amount === 0) { const row = _clientGetBalance.get(clientId); const b = row ? row.balance : 0; return { balanceBefore: b, balanceAfter: b }; }
  let balanceBefore, balanceAfter, ledgerDbId;
  db.transaction(() => {
    const row = _clientGetBalance.get(clientId);
    if (!row) throw new Error(`atomicCredit: client ${clientId} not found`);
    balanceBefore = row.balance || 0;
    balanceAfter = Math.round((balanceBefore + amount) * 100) / 100;
    _clientUpdateBalance.run(balanceAfter, clientId);
    if (ledgerEntry) {
      const entry = { ...ledgerEntry, balance_before: balanceBefore, balance_after: balanceAfter };
      const result = _ledgerInsert.run(..._ledgerEntryParams(clientId, entry));
      entry.db_id = result.lastInsertRowid;
      ledgerDbId = entry.db_id;
      if (!billingLedger[clientId]) billingLedger[clientId] = [];
      billingLedger[clientId].push(entry);
    }
  })();
  const client = clientById.get(clientId);
  if (client) client.balance = balanceAfter;
  return { balanceBefore, balanceAfter, ledgerDbId };
}

/**
 * atomicDebit — atomically subtract amount from client balance AND insert ledger entry
 * Same BUG-02/03/05 fixes as atomicCredit
 */
function atomicDebit(clientId, amount, ledgerEntry) {
  amount = Math.round(parseFloat(amount) * 100) / 100;
  if (isNaN(amount)) throw new Error('atomicDebit: invalid amount');
  if (amount === 0) { const row = _clientGetBalance.get(clientId); const b = row ? row.balance : 0; return { balanceBefore: b, balanceAfter: b }; }
  let balanceBefore, balanceAfter, ledgerDbId;
  db.transaction(() => {
    const row = _clientGetBalance.get(clientId);
    if (!row) throw new Error(`atomicDebit: client ${clientId} not found`);
    balanceBefore = row.balance || 0;
    balanceAfter = Math.round((balanceBefore - amount) * 100) / 100;
    _clientUpdateBalance.run(balanceAfter, clientId);
    if (ledgerEntry) {
      const entry = { ...ledgerEntry, balance_before: balanceBefore, balance_after: balanceAfter };
      const result = _ledgerInsert.run(..._ledgerEntryParams(clientId, entry));
      entry.db_id = result.lastInsertRowid;
      ledgerDbId = entry.db_id;
      if (!billingLedger[clientId]) billingLedger[clientId] = [];
      billingLedger[clientId].push(entry);
    }
  })();
  const client = clientById.get(clientId);
  if (client) client.balance = balanceAfter;
  return { balanceBefore, balanceAfter, ledgerDbId };
}

module.exports = { init, atomicCredit, atomicDebit };
