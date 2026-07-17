'use strict';
//
// src/jobs/tochka-sync.js — bank statement sync (auto-credit by INN).
// Extracted VERBATIM from server.js (2026-07): runTochkaSync — statement
// init/poll, natural-key idempotency, reconcile of uncredited webhook rows,
// auto-credit + bill settlement + payment alerts. Deps via factory.
//
function create(deps) {
  const {
    tochkaConfig, logger, tochkaRequest, buildNaturalKey, dbStmts,
    findClientByPayer, clientByInn, clients, atomicCredit, settleBillsOnPayment,
    documentsDb, logActivity, saveClients, alerts, insertBankPaymentToDb,
    _resetTochkaFailStreak,
  } = deps;

async function runTochkaSync({ dateFrom, dateTo, source = 'manual' } = {}) {
  if (!tochkaConfig.jwt || !tochkaConfig.accountId) {
    return { ok: false, error: 'tochka_not_configured' };
  }
  // Default to "last 12 months" instead of hardcoded 2024 (time-bomb when
  // anyone copies this code post-2027 — they'd silently scan 3 years).
  const from = dateFrom || new Date(Date.now() - 365 * 86400000).toISOString().slice(0, 10);
  const to   = dateTo   || new Date().toISOString().slice(0, 10);
  logger.info(`[Tochka Sync:${source}] Requesting statement ${from} — ${to}`);

  // 1) Init statement
  let initResult;
  try {
    initResult = await tochkaRequest('POST', '/uapi/open-banking/v1.0/statements', {
      Data: { Statement: {
        accountId: tochkaConfig.accountId,
        startDateTime: from + 'T00:00:00+00:00',
        endDateTime:   to   + 'T00:00:00+00:00'
      } }
    });
  } catch (e) {
    return { ok: false, error: 'init_failed', details: e.message };
  }
  const statementId =
       initResult.data?.Data?.Statement?.statementId
    || initResult.data?.Data?.statementId
    || initResult.data?.statementId;
  if (!statementId) {
    return { ok: false, error: 'no_statement_id', details: initResult.data };
  }
  logger.info(`[Tochka Sync:${source}] statement=${statementId}`);

  // 2) Poll until Ready — exponential backoff (1.5x), capped at 10s per wait,
  // ~10 attempts → total ~60s. Previously: 15 fixed 2s polls = self-DOS on Tochka.
  let statement = null;
  let delay = 1000;
  for (let attempt = 0; attempt < 10; attempt++) {
    await new Promise(r => setTimeout(r, delay));
    let getResult;
    try {
      getResult = await tochkaRequest('GET',
        `/uapi/open-banking/v1.0/accounts/${tochkaConfig.accountId}/statements/${statementId}`);
    } catch (e) {
      logger.warn(`[Tochka Sync:${source}] poll #${attempt+1} error: ${e.message}`);
      delay = Math.min(delay * 1.5, 10000);
      continue;
    }
    const stData = getResult.data?.Data?.Statement?.[0]
                || getResult.data?.Data?.Statement
                || getResult.data;
    const status = stData?.status || stData?.Status || '';
    if (status === 'Ready' || status === 'ready') { statement = stData; break; }
    delay = Math.min(delay * 1.5, 10000);
  }
  if (!statement) return { ok: false, error: 'statement_not_ready' };

  // 3) Process credits — auto-credit by INN, save all to bank_payments
  const transactions = statement.Transaction || statement.transactions || [];
  let imported = 0, matched = 0, skipped = 0;
  for (const tx of transactions) {
    const indicator = tx.creditDebitIndicator || tx.CreditDebitIndicator || '';
    if (indicator !== 'Credit' && indicator !== 'credit') continue;

    const amount = Math.round(parseFloat(tx.Amount?.amount || tx.amount || 0) * 100) / 100;
    if (!(amount > 0)) continue;
    const debtor = tx.DebtorParty || tx.CounterParty || tx.SidePayer || {};
    const payerInn  = debtor.inn || debtor.Inn || debtor.taxCode || '';
    const payerName = debtor.name || debtor.Name || debtor.fullName || '';
    const purpose   = tx.description || tx.Description || tx.TransactionInformation || '';
    const rawPaymentId = tx.transactionId || tx.TransactionId || tx.paymentId || '';
    // Stage 18.6: do NOT fall back to a random `tx_<rand>` for empty
    // transactionId. That was the original bug: every sync minted a new
    // unique pseudo-id, found nothing in bank_payments by that id, and
    // proceeded to credit again. Now: empty stays empty, and we rely on
    // natural-key idempotency below instead.
    const paymentId = rawPaymentId;
    const date = tx.documentProcessDate || tx.bookingDateTime || tx.valueDateTime || tx.date || to;
    const dateStr = typeof date === 'string' ? date.slice(0, 10) : date;

    // ─── Stage 18.6 — NATURAL-KEY IDEMPOTENCY ──────────────────────────────
    // Tochka Bank returns DIFFERENT identifiers for the same real transaction
    // depending on the channel:
    //   - webhook (incoming notify) → e.g. `tb-d1ce-e5df...`
    //   - statement sync          → e.g. `cbs-tb;2169199565;1` (or empty!)
    // Neither id alone is enough to de-dup. The natural key is the data
    // the real-world transaction uniquely owns:
    //     payer_inn | amount | date | purpose-prefix
    // Stored in `bank_payments.natural_key` (migration 031). On every sync
    // we hit it first — if a row already exists with this key, the credit
    // already happened (either via webhook or an earlier sync) and we skip.
    //
    // This single gate replaces the brittle pid/tpid lookups above. They're
    // kept as a fast-path optimisation: if we recognise the exact id, skip
    // immediately without computing the natural key.
    const naturalKey = buildNaturalKey(payerInn, amount, dateStr, purpose);
    const existingRow = dbStmts.findBankPaymentRowByNaturalKey.get(naturalKey);
    if (existingRow) {
      // The transaction is already recorded. Normally we skip (a webhook or an
      // earlier sync already handled it). BUT a row can sit UNCREDITED — the
      // real-time webhook can't verify Tochka's JWT signature (reason=
      // key_not_found) so it persists the payment "for manual review" without
      // crediting. The statement sync IS trusted (we pulled it via our own
      // authenticated API call), so here it acts as the reconciler: if the row
      // is uncredited + not dismissed and the payer INN maps to a client, we
      // auto-credit it now. Guard: never credit if the ledger already has this
      // bank_payment (legacy rows without a natural_key + crash recovery between
      // atomicCredit and the match-mark) → idempotent even across a crash.
      let reconciled = false;
      if (!existingRow.matched && !existingRow.dismissed) {
        const _m = findClientByPayer(payerInn, payerName, clientByInn, clients);
        const client = _m && _m.client;
        if (client) {
          const _byLabel = _m.by === 'name' ? ('названию «' + (payerName || '').slice(0, 40) + '»') : ('ИНН ' + payerInn);
          const alreadyInLedger = dbStmts.ledgerHasBankPaymentOn.get(client.id, amount, dateStr);
          if (!alreadyInLedger) {
            try {
              atomicCredit(client.id, amount, {
                type: 'bank_payment', amount, date: dateStr,
                timestamp: new Date().toISOString(),
                note: ('Авто-зачисление (синк, ' + _byLabel + '): ' + (purpose || '')).slice(0, 300),
                source: 'tochka_sync', tochkaPaymentId: paymentId
              });
              dbStmts.updateBankPaymentMatch.run(1, client.id, client.name, 1, existingRow.id);
              try { settleBillsOnPayment(client, amount, purpose, { documentsDb, logActivity, logger }); } catch (e) { logger.error('[BillSettle]', e.message); }
              matched++; reconciled = true;
              saveClients(clients);
              logger.info(`[Tochka Sync:${source}] reconciled uncredited payment → +${amount} to ${client.name} (${_byLabel})`);
              try { alerts.trigger('payment_received', { client: client.name, client_id: client.id, amount, inn: payerInn, source: 'Точка (sync, по ' + (_m.by === 'name' ? 'названию' : 'ИНН') + ')', natural_key: naturalKey, date: dateStr, balanceAfter: client.balance }); } catch (_) {}
            } catch (e) { logger.error(`[Tochka Sync:${source}] reconcile credit failed for ${client.name}: ${e.message}`); }
          } else {
            // Already credited via another row — just clear the "unmatched"
            // flag, do NOT credit again.
            dbStmts.updateBankPaymentMatch.run(1, client.id, client.name, 0, existingRow.id);
          }
        }
      }
      if (!reconciled) skipped++;
      continue;
    }

    // Fast-path id lookups — still useful when Tochka returns a non-empty
    // id, saves the natural-key SELECT.
    if (paymentId && dbStmts.findBankPaymentByTochkaId.get(paymentId)) { skipped++; continue; }
    if (paymentId && dbStmts.findBankPaymentByPaymentIdAny.get(paymentId)) { skipped++; continue; }

    const bankPayment = {
      id: 'bp_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
      tochkaPaymentId: paymentId,
      webhookType: 'incomingPayment',
      source: 'sync',
      date: dateStr,
      amount, payerInn, payerName, purpose,
      naturalKey,                 // Stage 18.6 — persisted for future de-dup
      matched: false, matchedClientId: null, matchedClientName: null,
      receivedAt: new Date().toISOString()
    };

    {
      // Match by INN (primary) or unambiguous company name (fallback).
      const _m = findClientByPayer(payerInn, payerName, clientByInn, clients);
      const client = _m && _m.client;
      if (client) {
        const _byLabel = _m.by === 'name' ? ('названию «' + (payerName || '').slice(0, 40) + '»') : ('ИНН ' + payerInn);
        bankPayment.matched = true;
        bankPayment.matchedClientId = client.id;
        bankPayment.matchedClientName = client.name;
        bankPayment.autoCredit = true;   // flag so the UI shows it auto-credited
        try {
          atomicCredit(client.id, amount, {
            type: 'bank_payment',
            amount, date: bankPayment.date,
            timestamp: new Date().toISOString(),
            note: ('Синхронизация из Точки (' + _byLabel + '): ' + (purpose || '')).slice(0, 200),
            source: 'tochka_sync',
            tochkaPaymentId: paymentId
          });
          try { settleBillsOnPayment(client, amount, purpose, { documentsDb, logActivity, logger }); } catch (e) { logger.error('[BillSettle]', e.message); }
          matched++;
          // Stage 18.13: «новый платёж» — любой платёж от sync.
          try {
            alerts.trigger('payment_received', {
              client: client.name, client_id: client.id,
              amount, inn: payerInn, source: 'Точка (sync, по ' + (_m.by === 'name' ? 'названию' : 'ИНН') + ')',
              natural_key: naturalKey, date: bankPayment.date,
              balanceAfter: client.balance,
            });
          } catch (_) {}
        } catch (e) {
          logger.error(`[Tochka Sync:${source}] credit failed for ${client.name}:`, e.message);
          bankPayment.matched = false;
          bankPayment.matchedClientId = null;
          bankPayment.matchedClientName = null;
        }
      }
    }
    insertBankPaymentToDb(bankPayment);
    imported++;
  }
  if (imported > 0) saveClients(clients);

  logger.info(`[Tochka Sync:${source}] done: total=${transactions.length} imported=${imported} matched=${matched} skipped=${skipped}`);
  _resetTochkaFailStreak();  // Stage 18.13 — successful sync resets the failure streak counter
  if (imported > 0 || matched > 0) {
    logActivity('billing', 'info', 'tochka_sync', null,
      `Tochka sync (${source}): ${imported} new, ${matched} auto-credited`,
      { from, to, total: transactions.length, imported, matched, skipped });
  }
  return { ok: true, total: transactions.length, imported, matched, skipped };
}

  return { runTochkaSync };
}

module.exports = { create };
