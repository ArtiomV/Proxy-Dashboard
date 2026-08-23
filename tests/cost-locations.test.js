import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { normalizeLocationAddress, buildCostLocations } = require('../src/billing/cost-locations.js');

describe('monthly cost locations', () => {
  it('groups any number of servers at the same normalized physical address', () => {
    const locations = buildCostLocations([
      { name: 'S1', displayName: 'Кишинёв 1', address: 'Кишинёв, Штефана, д.64', country: 'MD' },
      { name: 'S2', displayName: 'Кишинёв 2', address: '  Кишинёв,   Штефана, д.64  ', country: 'MD' },
      { name: 'S3', displayName: 'Бухарест', address: 'București, Calea 10', country: 'RO' },
    ]);

    expect(locations).toHaveLength(2);
    const chisinau = locations.find(location => location.country === 'MD');
    expect(chisinau).toMatchObject({
      key: 'location:кишинёв, штефана, д.64',
      label: 'Кишинёв, Штефана, д.64',
      address_missing: false,
    });
    expect(chisinau.servers.map(server => server.name)).toEqual(['S1', 'S2']);
  });

  it('does not merge servers whose addresses are missing', () => {
    const locations = buildCostLocations([
      { name: 'S1', displayName: 'Первый' },
      { name: 'S2', displayName: 'Второй' },
    ]);

    expect(locations.map(location => location.key).sort()).toEqual(['server:S1', 'server:S2']);
    expect(locations.every(location => location.address_missing)).toBe(true);
  });

  it('normalizes spaces and letter case in location keys', () => {
    expect(normalizeLocationAddress('  CHISINAU   Center ')).toBe('chisinau center');
  });
});
