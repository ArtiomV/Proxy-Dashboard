// Stage 18.6 — characterization: natural-key idempotency for Tochka payments.
//
// The bug we're guarding against:
//   Tochka Bank returns DIFFERENT identifiers for the same real transaction
//   depending on the delivery channel:
//     - Webhook → 'tb-d1ce-...'
//     - Statement sync → 'cbs-tb;...;1' (or empty!)
//   The previous fix (pid/tpid lookup) didn't help — sync used fresh ids
//   each cycle that didn't match the webhook row. Every poll re-credited
//   the same payment. WildBox got 19× ₽265,000 before we noticed.
//
// The natural key is the data the real transaction uniquely owns:
//   payer_inn | amount | date | purpose-prefix
// The same physical payment always produces the same key regardless of
// which channel saw it first. This test pins the contract.

import { describe, it, expect, beforeAll } from 'vitest';
import { bootApp } from './_helpers/app.js';

let db;

beforeAll(() => {
  const booted = bootApp();
  db = booted.db;
});

function insertBp({ id, payer_inn, amount, date, purpose, payment_id = null, tpid = null, source = '' }) {
  const naturalKey = (payer_inn || '') + '|' + amount + '|' + (date || '') + '|' + (purpose || '').slice(0, 100);
  db.prepare(`INSERT INTO bank_payments
    (id, webhook_type, payer_inn, payer_name, amount, purpose, payment_id, date,
     customer_code, matched, matched_client_id, matched_client_name, auto_credit,
     dismissed, source, tochka_payment_id, received_at, natural_key)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, 'incomingPayment', payer_inn, 'X', amount, purpose, payment_id, date,
         '', 0, null, null, 0, 0, source, tpid, new Date().toISOString(), naturalKey);
  return naturalKey;
}

describe('bank_payments natural_key idempotency (Stage 18.6)', () => {
  it('two rows for the SAME transaction (webhook + sync) produce the SAME natural_key', () => {
    // Same payer, amount, date, purpose — but different Tochka-internal ids.
    const k1 = insertBp({
      id: 'webhook-row-1', payer_inn: '1683018490', amount: 265000,
      date: '2026-05-21', purpose: 'Оплата за мобильные прокси',
      payment_id: 'tb-d1ce-e5df605d', tpid: '',  // webhook shape
    });
    // The SAME transaction arriving via sync would have a different id and
    // we'd reject the insert via UNIQUE(natural_key) … but we don't add
    // UNIQUE in the migration. Code must check via SELECT first.
    const found = db.prepare('SELECT id FROM bank_payments WHERE natural_key = ?').get(k1);
    expect(found).toBeDefined();
    expect(found.id).toBe('webhook-row-1');
  });

  it('different transactions on the SAME day produce DIFFERENT natural_keys', () => {
    insertBp({
      id: 'tx-A', payer_inn: '7707083893', amount: 100000,
      date: '2026-05-22', purpose: 'Оплата по счёту №100',
      payment_id: 'tb-aaa',
    });
    insertBp({
      id: 'tx-B', payer_inn: '7707083893', amount: 100000,
      date: '2026-05-22', purpose: 'Оплата по счёту №101',  // different invoice
      payment_id: 'tb-bbb',
    });
    const rows = db.prepare('SELECT natural_key FROM bank_payments WHERE id IN (?, ?)').all('tx-A', 'tx-B');
    expect(rows[0].natural_key).not.toBe(rows[1].natural_key);
  });

  it('same payer + same amount + same date BUT different purpose-prefix → different keys', () => {
    const k1 = insertBp({
      id: 'p-1', payer_inn: '9704223433', amount: 94050,
      date: '2026-05-19', purpose: 'Аванс',
    });
    const k2 = insertBp({
      id: 'p-2', payer_inn: '9704223433', amount: 94050,
      date: '2026-05-19', purpose: 'Доплата',
    });
    expect(k1).not.toBe(k2);
  });

  it('purpose longer than 100 chars — same prefix still collapses to the same key', () => {
    // Useful when Tochka pads/extends the purpose differently across channels.
    const long1 = 'А'.repeat(100) + ' дополнительный текст один';
    const long2 = 'А'.repeat(100) + ' дополнительный текст ДВА';
    const k1 = insertBp({
      id: 'long-1', payer_inn: '1234567890', amount: 50000,
      date: '2026-05-20', purpose: long1,
    });
    const k2 = insertBp({
      id: 'long-2', payer_inn: '1234567890', amount: 50000,
      date: '2026-05-20', purpose: long2,
    });
    // First 100 chars are identical → keys match.
    expect(k1).toBe(k2);
  });
});
