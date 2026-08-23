'use strict';

const VALID_CURRENCIES = new Set(['RUB', 'MDL', 'RON']);

function parseOperatorPackages(raw) {
  if (Array.isArray(raw)) return raw;
  try {
    const parsed = JSON.parse(String(raw || '[]'));
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

function operatorKey(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function readActiveSimCounts(db) {
  let rows = [];
  try {
    rows = db.prepare(`
      SELECT operator,
             COUNT(DISTINCT CASE
               WHEN TRIM(COALESCE(iccid, '')) <> '' THEN 'iccid:' || TRIM(iccid)
               ELSE 'modem:' || server_name || '|' || COALESCE(NULLIF(TRIM(imei), ''), nick)
             END) AS sim_count
      FROM modem_meta
      WHERE TRIM(COALESCE(operator, '')) <> ''
        AND COALESCE(deleted, 0) = 0
      GROUP BY LOWER(TRIM(operator))
      ORDER BY sim_count DESC, operator
    `).all();
  } catch (_) {
    // Compatibility with old/test schemas that predate iccid/deleted.
    try {
      rows = db.prepare(`
        SELECT operator, COUNT(DISTINCT server_name || '|' || COALESCE(NULLIF(TRIM(imei), ''), nick)) AS sim_count
        FROM modem_meta
        WHERE TRIM(COALESCE(operator, '')) <> ''
        GROUP BY LOWER(TRIM(operator))
        ORDER BY sim_count DESC, operator
      `).all();
    } catch (_) { rows = []; }
  }
  const counts = {};
  const labels = {};
  for (const row of rows) {
    const key = operatorKey(row.operator);
    if (!key) continue;
    counts[key] = Number(row.sim_count) || 0;
    labels[key] = String(row.operator || '').trim();
  }
  return { counts, labels };
}

function calculateOperatorPackageCosts(packages, simRoster, defaultCurrencyByOperator = {}) {
  const roster = simRoster && simRoster.counts ? simRoster : { counts: simRoster || {}, labels: {} };
  const rows = [];
  const configured = new Set();
  for (const raw of packages || []) {
    const operator = String((raw && raw.operator) || '').replace(/\s+/g, ' ').trim();
    const key = operatorKey(operator);
    if (!key || configured.has(key)) continue;
    configured.add(key);
    const type = raw.type === 'shared' || raw.type === 'unlimited' ? raw.type : 'per_sim';
    const simCount = Number(roster.counts[key]) || 0;
    const maxSims = type === 'per_sim' ? 1 : Math.max(0, Math.floor(Number(raw.max_sims) || 0));
    const bundleCount = simCount === 0 ? 0 : (maxSims > 0 ? Math.ceil(simCount / maxSims) : null);
    const price = Math.max(0, Number(raw.price) || 0);
    const currencyCandidate = String(raw.currency || defaultCurrencyByOperator[operator] || defaultCurrencyByOperator[key] || 'RUB').toUpperCase();
    const currency = VALID_CURRENCIES.has(currencyCandidate) ? currencyCandidate : 'RUB';
    const volumeGb = type === 'unlimited' ? 0 : Math.max(0, Number(raw.volume_gb) || 0);
    const amount = bundleCount == null ? 0 : Math.round(bundleCount * price * 100) / 100;
    const totalVolumeGb = type === 'unlimited' || bundleCount == null ? null : Math.round(bundleCount * volumeGb * 10) / 10;
    const missing = [];
    if (!(price > 0)) missing.push('цена');
    if (type !== 'per_sim' && !(maxSims > 0)) missing.push('SIM в бандле');
    if (type !== 'unlimited' && !(volumeGb > 0)) missing.push('объём трафика');
    rows.push({
      operator, type, sim_count: simCount, max_sims: maxSims,
      bundle_count: bundleCount, price, currency, amount,
      volume_gb: volumeGb, total_volume_gb: totalVolumeGb,
      configured: missing.length === 0, missing,
    });
  }
  const unconfigured = [];
  for (const [key, count] of Object.entries(roster.counts || {})) {
    if (configured.has(key) || !(Number(count) > 0)) continue;
    unconfigured.push({ operator: (roster.labels && roster.labels[key]) || key, sim_count: Number(count) || 0, missing: ['пакет оператора'] });
  }
  return { rows, unconfigured };
}

module.exports = {
  VALID_CURRENCIES,
  parseOperatorPackages,
  operatorKey,
  readActiveSimCounts,
  calculateOperatorPackageCosts,
};
