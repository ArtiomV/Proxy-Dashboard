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
  const mult = { B: 1, KB: 1024, MB: 1048576, GB: 1073741824, TB: 1099511627776 };
  return num * (mult[unit] || 1);
}

const parseBwToBytes = parseTrafficValue;

function trafficBytesToGb(bytes) {
  return Math.round(bytes / (1024 * 1024 * 1024) * 1000) / 1000;
}

/**
 * Normalize operator name from raw ProxySmart CELLOP value
 * @param {string} rawOp - lowercase operator name
 * @param {boolean} isRO - true if server is S2 (Romania)
 */
function normalizeOperator(rawOp, isRO) {
  const clean = (rawOp || '').replace(/\s+/g, ' ').trim().toLowerCase();
  const map = {
    'unite': 'Moldtelecom',
    'moldtelecom': 'Moldtelecom',
    'moldtelecom moldtelecom': 'Moldtelecom',
    'orange': isRO ? 'Orange RO' : 'Orange MD',
    'orange ro': 'Orange RO',
    'orange md': 'Orange MD',
    'vodafone ro': 'Vodafone RO',
    'vodafone': 'Vodafone RO'
  };
  return map[clean] || (clean ? clean.charAt(0).toUpperCase() + clean.slice(1) : '');
}

module.exports = { parseTrafficValue, parseBwToBytes, trafficBytesToGb, normalizeOperator };
