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

module.exports = { normCompanyName, findClientByPayer };
