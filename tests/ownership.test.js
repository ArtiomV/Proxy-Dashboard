// Unit tests for the ownership priority chain (src/modems/ownership.js).
// The live step can't run in API tests (no ProxySmart servers in test env),
// so the chain is exercised here with stubbed deps.

import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { isModemOwned } = require('../src/modems/ownership.js');

// DEEP-37 (2026-09-24): резолвер читает СЫРОЙ per-server фид (serverName
// сохраняется — это и есть фикс duplicate-nick), mergeServerData не нужен.
function depsWithLive(portsByImei, nick = 'MD_A', imei = 'IMEI_A', serverName = 'S1') {
  return {
    fetchAllServersDataCached: async () => [{
      serverName,
      status: [{ modem_details: { NICK: nick, IMEI: imei }, net_details: { IS_ONLINE: 'yes' } }],
      ports: { [imei]: portsByImei },
      bw: {},
    }],
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

  it('roster binding box-unbound >10min (_missingSince) → no access via roster', async () => {
    const deps = { ...noLive };
    deps.knownModems = { S1: { p1: { nick: 'MD_A', portName: 'CLIENT', lastClientSeen: Date.now(), _missingSince: Date.now() - 30 * 60 * 1000 } } };
    deps.db = { prepare: () => ({ get: () => undefined }) };   // no history
    expect(await isModemOwned({ nick: 'MD_A', portNameFilter: 'CLIENT', deps })).toBe(false);
  });

  it('roster binding box-unbound <10min (flap) → still grants access', async () => {
    const deps = { ...noLive };
    deps.knownModems = { S1: { p1: { nick: 'MD_A', portName: 'CLIENT', lastClientSeen: Date.now(), _missingSince: Date.now() - 60 * 1000 } } };
    expect(await isModemOwned({ nick: 'MD_A', portNameFilter: 'CLIENT', deps })).toBe(true);
  });

  it('nothing anywhere → false', async () => {
    expect(await isModemOwned({ nick: 'MD_A', portNameFilter: 'CLIENT', deps: noLive })).toBe(false);
  });
});

// 2026-09-24 · DEEP-37/38: резолв конкретной сущности и право на мутации.
const { resolveOwnedModem } = require('../src/modems/ownership.js');

describe('resolveOwnedModem — DEEP-37/38', () => {
  const twoServers = {
    fetchAllServersDataCached: async () => [
      { serverName: 'S1', status: [{ modem_details: { NICK: 'dup', IMEI: 'IMEI_OWN' } }],
        ports: { IMEI_OWN: [{ portName: 'CLIENT' }] }, bw: {} },
      { serverName: 'S4', status: [{ modem_details: { NICK: 'dup', IMEI: 'IMEI_FOREIGN' } }],
        ports: { IMEI_FOREIGN: [{ portName: 'OTHER' }] }, bw: {} },
    ],
    knownModems: {},
    db: { prepare: () => ({ get: () => undefined }) },
  };

  it('duplicate-nick: резолв возвращает СВОЙ server/imei (S1), а не первый в фиде', async () => {
    const ent = await resolveOwnedModem({ nick: 'dup', portNameFilter: 'CLIENT', purpose: 'mutation', deps: twoServers });
    expect(ent).toMatchObject({ server: 'S1', imei: 'IMEI_OWN' });
  });

  it('serverName из запроса сужает резолв: чужой сервер → отказ', async () => {
    const ent = await resolveOwnedModem({ nick: 'dup', serverName: 'S4', portNameFilter: 'CLIENT', purpose: 'mutation', deps: twoServers });
    expect(ent).toBeNull();
    const ok = await resolveOwnedModem({ nick: 'dup', serverName: 'S1', portNameFilter: 'CLIENT', purpose: 'mutation', deps: twoServers });
    expect(ok).toMatchObject({ server: 'S1' });
  });

  it('live-порт ОТВЯЗАН → мутация запрещена немедленно (история не воскрешает)', async () => {
    const deps = depsWithLive([{ portName: '' }]);
    deps.knownModems = { S1: { p1: { nick: 'MD_A', portName: 'CLIENT', lastClientSeen: Date.now() } } };
    deps.db = { prepare: () => ({ get: () => ({ 1: 1 }) }) };   // история есть
    expect(await resolveOwnedModem({ nick: 'MD_A', portNameFilter: 'CLIENT', purpose: 'mutation', deps })).toBeNull();
    // …а read-only доступ к отчётам сохраняется через историю.
    expect(await resolveOwnedModem({ nick: 'MD_A', portNameFilter: 'CLIENT', purpose: 'read', deps })).toBeTruthy();
  });

  it('история БЕЗ назначения — не право на мутацию', async () => {
    const deps = { ...noLive };
    deps.db = { prepare: () => ({ get: () => ({ 1: 1 }) }) };
    expect(await resolveOwnedModem({ nick: 'MD_A', portNameFilter: 'CLIENT', purpose: 'mutation', deps })).toBeNull();
    expect(await isModemOwned({ nick: 'MD_A', portNameFilter: 'CLIENT', deps })).toBe(true);   // read по-прежнему да
  });
});
