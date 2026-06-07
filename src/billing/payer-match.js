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

module.exports = { normCompanyName, findClientByPayer, buildNaturalKey };
