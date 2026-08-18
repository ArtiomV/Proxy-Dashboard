'use strict';

// Match an incoming bank payment to a client by INN (primary) or, as a
// fallback, by normalized company name.
//
// Name matching strips the legal form (ООО / АО / ИП / "Общество с
// ограниченной ответственностью" / …), quotes, case, ё→е and spacing, then
// requires an EXACT, UNAMBIGUOUS match (exactly one client with that core
// name). A fuzzy/substring match could credit the wrong client, so 0-or-many
// matches → null (left for manual review). The Tochka payer name comes in a
// different legal form than our stored client name, e.g.
//   payer:  «Общество с ограниченной ответственностью "ПалитрумЛаб"»
//   client: «ООО "ПАЛИТРУМЛАБ"»
// both normalize to «палитрумлаб».

const LEGAL_FORMS = [
  'общество с ограниченной ответственностью',
  'публичное акционерное общество',
  'непубличное акционерное общество',
  'закрытое акционерное общество',
  'открытое акционерное общество',
  'акционерное общество',
  'индивидуальный предприниматель',
  'ооо', 'оао', 'зао', 'пао', 'нао', 'ао', 'ип',
];

function normCompanyName(name) {
  let s = String(name || '').toLowerCase().replace(/ё/g, 'е');
  s = s.replace(/[^a-zа-я0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();   // drop quotes/punct → spaces
  // Strip a leading or trailing legal form (longest first — array is ordered).
  for (const lf of LEGAL_FORMS) {
    if (s === lf) return '';
    if (s.startsWith(lf + ' ')) { s = s.slice(lf.length).trim(); break; }
    if (s.endsWith(' ' + lf)) { s = s.slice(0, s.length - lf.length).trim(); break; }
  }
  return s;
}

// Returns { client, by } where by = 'inn' | 'name', or null if no safe match.
// clientByInn: a Map (or plain object) keyed by INN. clients: the array.
function findClientByPayer(payerInn, payerName, clientByInn, clients) {
  if (payerInn) {
    const c = (clientByInn && typeof clientByInn.get === 'function') ? clientByInn.get(payerInn) : (clientByInn || {})[payerInn];
    if (c) return { client: c, by: 'inn' };
  }
  const norm = normCompanyName(payerName);
  if (!norm || norm.length < 3) return null;   // too short / empty → unsafe
  const matches = [];
  for (const c of (clients || [])) {
    if (normCompanyName(c.name) === norm || (c.legalName && normCompanyName(c.legalName) === norm)) {
      matches.push(c);
    }
  }
  // Distinct clients only (a client could match on both name + legalName).
  const uniq = [...new Map(matches.map(c => [c.id, c])).values()];
  if (uniq.length === 1) return { client: uniq[0], by: 'name' };
  return null;   // 0 or ambiguous → manual review
}

// Canonical natural key for a bank transaction — the data the real-world payment
// uniquely owns: payer INN | amount | date(YYYY-MM-DD) | purpose-prefix. It MUST
// be byte-identical whether built from a webhook payload or from a statement
// sync, otherwise the same payment is recorded twice and the sync can't
// reconcile (and credit) the webhook's uncredited row — exactly the «265000.0»
// vs «265000» drift seen in production. `String(Number(amount))` collapses a
// stray 265000.0 → "265000" while keeping 4250.44 → "4250.44"; the date is
// always sliced to YYYY-MM-DD so a webhook timestamp and a sync date agree.
function buildNaturalKey(payerInn, amount, date, purpose) {
  const n = Number(amount);
  const amt = Number.isFinite(n) ? String(n) : String(amount == null ? '' : amount);
  return (payerInn || '') + '|' + amt + '|' + String(date || '').slice(0, 10) + '|' + String(purpose || '').slice(0, 100);
}

// A3 — anti-collision on the natural key. The base key deliberately stays
// date-only (no time component): the webhook and the statement sync must
// produce a byte-identical key for the SAME payment, and the sync often has
// only a date where the webhook has a timestamp (or vice versa) — a time
// component would split the key and re-open the double-credit hole.
// Instead, collisions are resolved by sequence suffix:
//   existingRows — bank_payments rows whose natural_key is the base key or
//     base + '#N' (queried by prefix, see findBankPaymentsByNaturalKeyBase);
//   same paymentId (payment_id or tochka_payment_id) → re-delivery of the
//     SAME transaction: { isDuplicate: true, existing } — caller skips or
//     reconciles, never credits again;
//   different non-empty paymentId → a genuinely NEW payment that happens to
//     share payer/amount/date/purpose: { key: base + '#N' } — recorded and
//     credited normally instead of being silently swallowed as a "dup";
//   empty paymentId with existing rows → can't distinguish re-delivery from
//     a real second payment, so we conservatively treat it as a duplicate
//     (statement re-pulls with empty transactionId must never re-credit).
// Cross-channel linking (2026-08-18, СРТ double-credit): Tochka reports
// DIFFERENT ids for the SAME transaction on webhook (`tb-…`) vs statement
// sync (`cbs-tb;…`), so a bare "different id → new payment" rule credited
// the same money twice (webhook row + sync '#2' row). Fix: when the caller
// declares its channel ('webhook' | 'sync'), an existing row from the
// OPPOSITE channel that is not yet cross-linked (webhook row without
// tochka_payment_id, or sync row without payment_id) is the same
// transaction re-delivered → duplicate + link: the caller writes the new
// channel's id onto that row. Linking is one-to-one: a linked row is no
// longer eligible, so two genuinely identical payments (A3, two webhook
// rows + two sync rows) still pair up 1:1 and BOTH get credited.
function resolveNaturalKey(existingRows, baseKey, paymentId, channel) {
  if (!existingRows || existingRows.length === 0) {
    return { key: baseKey, isDuplicate: false, existing: null };
  }
  if (paymentId) {
    const same = existingRows.find(r =>
      (r.payment_id && r.payment_id === paymentId) ||
      (r.tochka_payment_id && r.tochka_payment_id === paymentId));
    if (same) return { key: same.natural_key, isDuplicate: true, existing: same };
    if (channel) {
      const cross = existingRows.find(r => channel === 'sync'
        ? (r.payment_id && !r.tochka_payment_id)   // webhook row, not yet linked
        : (r.tochka_payment_id && !r.payment_id)); // sync row, not yet linked
      if (cross) return { key: cross.natural_key, isDuplicate: true, existing: cross, link: true };
    }
    let maxSeq = 1;
    for (const r of existingRows) {
      const m = /#(\d+)$/.exec(r.natural_key || '');
      if (m) maxSeq = Math.max(maxSeq, parseInt(m[1], 10));
    }
    return { key: baseKey + '#' + (maxSeq + 1), isDuplicate: false, existing: null };
  }
  return { key: baseKey, isDuplicate: true, existing: existingRows[0] };
}

module.exports = { normCompanyName, findClientByPayer, buildNaturalKey, resolveNaturalKey };
