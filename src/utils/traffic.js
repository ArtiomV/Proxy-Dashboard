'use strict';

/**
 * Parse traffic value like "10.5 GB" to bytes
 * Also used as parseBwToBytes (same function)
 */
function parseTrafficValue(val) {
  if (!val || val === '0 B') return 0;
  if (typeof val === 'number') return val;
  const str = String(val).trim();
  const match = str.match(/^(\d+(?:\.\d+)?)\s*(B|KB|MB|GB|TB)?$/i);
  if (!match) return 0;
  const num = parseFloat(match[1]);
  const unit = (match[2] || 'B').toUpperCase();
  // Decimal SI units: 1 KB = 1000 B, 1 MB = 1e6 B, 1 GB = 1e9 B (matches billing).
  // ProxySmart almost always returns raw byte counts (numeric strings), so the unit map
  // only kicks in for legacy formatted strings.
  const mult = { B: 1, KB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12 };
  return Math.round(num * (mult[unit] || 1));
}

const parseBwToBytes = parseTrafficValue;

let operatorAliases = Object.create(null);

function setOperatorAliases(aliases) {
  const next = Object.create(null);
  if (aliases && typeof aliases === 'object') {
    for (const [alias, canonical] of Object.entries(aliases)) {
      const key = String(alias || '').replace(/\s+/g, ' ').trim().toLowerCase();
      const value = String(canonical || '').replace(/\s+/g, ' ').trim();
      if (key && value && key !== value.toLowerCase()) next[key] = value;
    }
  }
  operatorAliases = next;
}

function resolveOperatorAlias(rawOp) {
  let clean = String(rawOp || '').replace(/\s+/g, ' ').trim();
  const seen = new Set();
  for (let i = 0; i < 10; i++) {
    const key = clean.toLowerCase();
    if (!key || seen.has(key) || !operatorAliases[key]) break;
    seen.add(key);
    clean = operatorAliases[key];
  }
  return clean;
}

function trafficBytesToGb(bytes) {
  return Math.round(bytes / 1e9 * 1000) / 1000;
}

/**
 * Normalize operator name from raw ProxySmart CELLOP value
 * @param {string} rawOp - lowercase operator name
 * @param {boolean} isRO - true if server is S2 (Romania)
 */
function normalizeOperator(rawOp, isRO) {
  const clean = (rawOp || '').replace(/\s+/g, ' ').trim().toLowerCase();
  // ProxySmart reports the literal placeholder "unknown" when a SIM hasn't
  // resolved its carrier name yet (common right after a rotation/reconnect).
  // It is NOT a real operator — collapse it to '' so it's never displayed as
  // one and so write-paths can fall back to a persisted source (modem_meta /
  // proxy_checks). Empty/placeholder rows are hidden from operator breakdowns.
  if (!clean || clean === 'unknown') return '';
  // Manual aliases have priority over built-in heuristics. This lets an admin
  // collapse a new/vendor-specific carrier spelling without a deploy.
  if (operatorAliases[clean]) return resolveOperatorAlias(clean);
  const map = {
    'unite': 'Moldtelecom',
    'moldtelecom': 'Moldtelecom',
    'moldtelecom moldtelecom': 'Moldtelecom',
    'moldcell': 'Moldcell',
    'orange': isRO ? 'Orange RO' : 'Orange MD',
    'orange ro': 'Orange RO',
    'orange md': 'Orange MD',
    'vf-ro': 'Vodafone RO',
    'vfro': 'Vodafone RO',
    'vodafone ro': 'Vodafone RO',
    'vodafone': 'Vodafone RO'
  };
  if (map[clean]) return map[clean];
  // 2026-08-13: алиасы без разделителей — «VF_RO»/«vf ro»/«MOLDCELL » и т.п.
  // не должны плодить отдельные операторы в легендах/группировках.
  const squashMap = {
    'moldcell': 'Moldcell',
    'vfro': 'Vodafone RO',
    'vodafone': 'Vodafone RO',
    'vodafonero': 'Vodafone RO'
  };
  const squashed = clean.replace(/[\s._-]+/g, '');
  if (squashMap[squashed]) return squashMap[squashed];
  return clean.charAt(0).toUpperCase() + clean.slice(1);
}

module.exports = { parseTrafficValue, parseBwToBytes, trafficBytesToGb, normalizeOperator, setOperatorAliases, resolveOperatorAlias };
