'use strict';

function normalizeLocationAddress(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

// Costs belong to a physical location, not to an individual server. Servers
// with the same normalized address therefore share one monthly cost row. An
// address-less server stays separate: merging all blank addresses would make
// unrelated sites look like one location.
function buildCostLocations(servers, serverCountries = {}) {
  const byKey = new Map();
  for (const raw of servers || []) {
    const name = String((raw && raw.name) || '').trim();
    if (!name) continue;
    const address = String(raw.address || '').replace(/\s+/g, ' ').trim();
    const normalized = normalizeLocationAddress(address);
    const key = normalized ? `location:${normalized}` : `server:${name}`;
    let location = byKey.get(key);
    if (!location) {
      location = {
        key,
        address,
        label: address || raw.displayName || name,
        country: (serverCountries[name] || {}).country || raw.country || '',
        address_missing: !normalized,
        servers: [],
      };
      byKey.set(key, location);
    }
    location.servers.push({ name, displayName: raw.displayName || name });
    if (!location.country) {
      location.country = (serverCountries[name] || {}).country || raw.country || '';
    }
  }
  return Array.from(byKey.values())
    .map(location => ({
      ...location,
      servers: location.servers.sort((a, b) => a.displayName.localeCompare(b.displayName, 'ru')),
    }))
    .sort((a, b) => a.label.localeCompare(b.label, 'ru'));
}

module.exports = { normalizeLocationAddress, buildCostLocations };
