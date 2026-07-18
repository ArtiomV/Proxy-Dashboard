// Unit tests for the ownership priority chain (src/modems/ownership.js).
// The live step can't run in API tests (no ProxySmart servers in test env),
// so the chain is exercised here with stubbed deps.

import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { isModemOwned } = require('../src/modems/ownership.js');

function depsWithLive(portsByImei, nick = 'MD_A', imei = 'IMEI_A') {
  return {
    fetchAllServersDataCached: async () => [],
    mergeServerData: () => ({
      status: [{ modem_details: { NICK: nick, IMEI: imei } }],
      ports: { [imei]: portsByImei },
    }),
    knownModems: {},
    db: { prepare: () => ({ get: () => undefined }) },
  };
}
const noLive = {
  fetchAllServersDataCached: async () => [],
  mergeServerData: () => ({ status: [], ports: {} }),
  knownModems: {},
  db: { prepare: () => ({ get: () => undefined }) },
};

describe('isModemOwned — priority chain', () => {
  it('admin (*) always passes', async () => {
    expect(await isModemOwned({ nick: 'X', portNameFilter: '*', deps: noLive })).toBe(true);
  });

  it('live binding match → true', async () => {
    const deps = depsWithLive([{ portName: 'CLIENT' }]);
    expect(await isModemOwned({ nick: 'MD_A', portNameFilter: 'CLIENT', deps })).toBe(true);
  });

  it('live bound to a DIFFERENT client → hard deny (even with roster+history hits)', async () => {
    const deps = depsWithLive([{ portName: 'OTHER' }]);
    deps.knownModems = { S1: { p1: { nick: 'MD_A', portName: 'CLIENT', lastClientSeen: Date.now() } } };
    deps.db = { prepare: () => ({ get: () => ({ 1: 1 }) }) }; // history hit
    expect(await isModemOwned({ nick: 'MD_A', portNameFilter: 'CLIENT', deps })).toBe(false);
  });

  it('live but unbound → falls through to roster (24h)', async () => {
    const deps = depsWithLive([]);
    deps.knownModems = { S1: { p1: { nick: 'MD_A', portName: 'CLIENT', lastClientSeen: Date.now() } } };
    expect(await isModemOwned({ nick: 'MD_A', portNameFilter: 'CLIENT', deps })).toBe(true);
  });

  it('roster binding older than 24h → falls through to history', async () => {
    const deps = { ...noLive };
    deps.knownModems = { S1: { p1: { nick: 'MD_A', portName: 'CLIENT', lastClientSeen: Date.now() - 25 * 3600 * 1000 } } };
    deps.db = { prepare: () => ({ get: () => ({ 1: 1 }) }) };
    expect(await isModemOwned({ nick: 'MD_A', portNameFilter: 'CLIENT', deps })).toBe(true);
  });

  it('nothing anywhere → false', async () => {
    expect(await isModemOwned({ nick: 'MD_A', portNameFilter: 'CLIENT', deps: noLive })).toBe(false);
  });
});
