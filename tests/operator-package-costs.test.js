import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const {
  parseOperatorPackages,
  readActiveSimCounts,
  calculateOperatorPackageCosts,
} = require('../src/billing/operator-package-costs.js');

describe('operator package automatic costs', () => {
  it('calculates per-SIM, finite bundles and unlimited bundles from the live SIM roster', () => {
    const packages = [
      { operator: 'Orange MD', type: 'per_sim', volume_gb: 400, max_sims: 99, price: 100, currency: 'MDL' },
      { operator: 'Moldcell', type: 'shared', volume_gb: 1000, max_sims: 10, price: 500, currency: 'MDL' },
      { operator: 'Digi', type: 'unlimited', max_sims: 20, price: 1000, currency: 'RON' },
    ];
    const roster = {
      counts: { 'orange md': 7, moldcell: 27, digi: 12, unknown: 3 },
      labels: { unknown: 'Unknown Mobile' },
    };

    const result = calculateOperatorPackageCosts(packages, roster);
    expect(result.rows.find(r => r.operator === 'Orange MD')).toMatchObject({
      sim_count: 7, max_sims: 1, bundle_count: 7, amount: 700, total_volume_gb: 2800, configured: true,
    });
    expect(result.rows.find(r => r.operator === 'Moldcell')).toMatchObject({
      sim_count: 27, max_sims: 10, bundle_count: 3, amount: 1500, total_volume_gb: 3000, configured: true,
    });
    expect(result.rows.find(r => r.operator === 'Digi')).toMatchObject({
      sim_count: 12, max_sims: 20, bundle_count: 1, amount: 1000, total_volume_gb: null, configured: true,
    });
    expect(result.unconfigured).toEqual([
      { operator: 'Unknown Mobile', sim_count: 3, missing: ['пакет оператора'] },
    ]);
  });

  it('surfaces missing inputs and does not charge an operator with zero active SIMs', () => {
    const result = calculateOperatorPackageCosts([
      { operator: 'Empty', type: 'shared', volume_gb: 0, max_sims: 0, price: 0 },
      { operator: 'Ready', type: 'shared', volume_gb: 500, max_sims: 10, price: 250 },
    ], { empty: 5, ready: 0 });
    expect(result.rows[0]).toMatchObject({
      configured: false, bundle_count: null, amount: 0,
      missing: ['цена', 'SIM в бандле', 'объём трафика'],
    });
    expect(result.rows[1]).toMatchObject({ configured: true, sim_count: 0, bundle_count: 0, amount: 0 });
  });

  it('reads distinct active SIM identities and ignores soft-deleted modems', () => {
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE modem_meta (
      server_name TEXT, imei TEXT, nick TEXT, iccid TEXT,
      operator TEXT, deleted INTEGER DEFAULT 0
    )`);
    const insert = db.prepare('INSERT INTO modem_meta VALUES (?, ?, ?, ?, ?, ?)');
    insert.run('S1', 'i1', 'm1', 'sim-a', 'Orange MD', 0);
    insert.run('S2', 'i2', 'm2', 'sim-a', 'Orange MD', 0); // same physical SIM
    insert.run('S1', 'i3', 'm3', 'sim-b', 'Orange MD', 0);
    insert.run('S1', 'i4', 'm4', 'sim-c', 'Orange MD', 1); // deleted
    insert.run('S1', 'i5', 'm5', '', 'Moldcell', 0);       // modem fallback

    expect(readActiveSimCounts(db)).toEqual({
      counts: { 'orange md': 2, moldcell: 1 },
      labels: { 'orange md': 'Orange MD', moldcell: 'Moldcell' },
    });
    db.close();
  });

  it('parses only JSON arrays', () => {
    expect(parseOperatorPackages('[{"operator":"A"}]')).toHaveLength(1);
    expect(parseOperatorPackages('{"operator":"A"}')).toEqual([]);
    expect(parseOperatorPackages('broken')).toEqual([]);
  });
});
