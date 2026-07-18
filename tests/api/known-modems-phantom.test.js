// Phantom-port guard in updateKnownModems: ports with NO identity (no IMEI,
// no NICK, nothing in the previous roster entry) must not enter or stay in
// the roster — they inflated per-client counts (the БА 31/30 case).

import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'module';
import { bootApp } from '../_helpers/app.js';

const require = createRequire(import.meta.url);
let server, stateMod;

beforeAll(() => {
  bootApp();
  server = require('../../server.js');
  stateMod = require('../../src/state/index.js');
});

describe('updateKnownModems — phantom-port guard', () => {
  it('does not roster identity-less ports and sweeps existing junk', () => {
    const { state, setKnownModems } = stateMod;
    const backup = JSON.parse(JSON.stringify(state.knownModems));
    try {
      setKnownModems({
        TSTS: {
          portJunk: { portName: 'clientX', imei: '', nick: '', model: '', lastSeen: 1, lastClientSeen: 1 },
          portReal: { portName: 'clientX', imei: 'I1', nick: 'MD_1', model: '', lastSeen: 1, lastClientSeen: 1 },
        },
      });
      // A poll where the junk port still reports traffic with a real portName,
      // but the port map has no IMEI for it and live status lacks it entirely.
      server.updateKnownModems({
        serverName: 'TSTS',
        bw: { portJunk: { portName: 'clientX' } },
        ports: {},
        status: [],
      });
      const km = state.knownModems.TSTS;
      expect(km.portJunk).toBeUndefined();     // swept
      expect(km.portReal).toBeTruthy();        // real entry preserved
      expect(km.portReal.imei).toBe('I1');
    } finally {
      setKnownModems(backup);
      server.saveKnownModems();
    }
  });

  it('keeps an entry whose nick comes from the previous roster (temporary identity gap)', () => {
    const { state, setKnownModems } = stateMod;
    const backup = JSON.parse(JSON.stringify(state.knownModems));
    try {
      setKnownModems({
        TSTS: {
          portGap: { portName: 'clientX', imei: '', nick: 'MD_KNOWN', model: '', lastSeen: 1, lastClientSeen: 1 },
        },
      });
      // Port map lost the IMEI this poll and live status misses the modem —
      // but the previous roster entry has a nick → NOT a phantom, keep it.
      server.updateKnownModems({
        serverName: 'TSTS',
        bw: { portGap: { portName: 'clientX' } },
        ports: {},
        status: [],
      });
      expect(state.knownModems.TSTS.portGap).toBeTruthy();
      expect(state.knownModems.TSTS.portGap.nick).toBe('MD_KNOWN');
    } finally {
      setKnownModems(backup);
      server.saveKnownModems();
    }
  });
});
