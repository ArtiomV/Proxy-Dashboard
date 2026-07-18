// Identity-less roster entries (no IMEI, no NICK): kept ONLY when the port
// has a real client binding right now (it bills traffic → counts as the
// client's modem). Identity-less placeholders without a real binding are
// dropped as glitches.

import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'module';
import { bootApp } from '../_helpers/app.js';

const require = createRequire(import.meta.url);
let server, stateMod, fleetMod;

beforeAll(() => {
  bootApp();
  server = require('../../server.js');
  stateMod = require('../../src/state/index.js');
  fleetMod = require('../../src/modems/fleet.js');
});

describe('updateKnownModems — identity-less entries', () => {
  it('keeps a bound-but-unreadable port (billing traffic), drops unbound phantoms', () => {
    const { state, setKnownModems } = stateMod;
    const backup = JSON.parse(JSON.stringify(state.knownModems));
    try {
      setKnownModems({ TSTS: {} });
      server.updateKnownModems({
        serverName: 'TSTS',
        bw: {
          portBound: { portName: 'clientX' },        // bound, billing → KEEP (no imei/nick available)
          portGhost: { portName: 'randomport12' },   // identity-less placeholder → SKIP
        },
        ports: {},
        status: [],
      });
      const km = state.knownModems.TSTS;
      expect(km.portBound).toBeTruthy();
      expect(km.portBound.portName).toBe('clientX');
      expect(km.portGhost).toBeUndefined();
    } finally {
      setKnownModems(backup);
      server.saveKnownModems();
    }
  });
});

describe('computeClientWorking — identity-less bound entries', () => {
  it('counts a bound-but-unreadable port as working (it bills)', () => {
    const { computeClientWorking } = fleetMod;
    const known = {
      S1: {
        portBound: { portName: 'clientX', imei: '', nick: '', lastClientSeen: Date.now() },
        portReal:  { portName: 'clientX', imei: 'I1', nick: 'MD_1', lastClientSeen: Date.now() },
      },
    };
    // fleet with no active keys at all: the real one is NOT working, the
    // identity-less bound one IS (bills traffic).
    const fleet = { activeKeys: [], disconnectedList: [] };
    const w = computeClientWorking(known, fleet);
    expect(w.clientX).toBe(1);
  });
});
