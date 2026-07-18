// Modem fleet accounting: total / online / offline must always be coherent.

import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { computeFleet } = require('../src/modems/fleet.js');

const NOW = 1_800_000_000_000;
const ago = (ms) => new Date(NOW - ms).toISOString();
const H = 3600 * 1000;

// modem_meta rows
const meta = [
  { srv: 'S1', imei: 'A', nick: 'MD_A' },
  { srv: 'S1', imei: 'B', nick: 'MD_B' },
  { srv: 'S2', imei: 'C', nick: 'RO_C' },
  { srv: 'S2', imei: 'D', nick: 'RO_D' },      // a re-add phantom: never recently online
  { srv: 'S2', imei: 'E', nick: 'random99' },  // random → ignored everywhere
];
// uptime: last_online_check per srv_imei
const uptime = {
  'S1_A': { last_online_check: ago(2 * 60 * 1000) },   // online 2 min ago
  'S1_B': { last_online_check: ago(20 * H) },           // online 20h ago (offline now, still fleet)
  'S2_C': { last_online_check: ago(5 * 60 * 1000) },    // online 5 min ago
  'S2_D': { last_online_check: ago(10 * 24 * H) },      // 10 days ago → phantom, NOT fleet
  'S2_E': { last_online_check: ago(1 * 60 * 1000) },    // random — ignored
};
// live snapshot (prefixed IMEIs, IS_ONLINE)
const live = [
  { _server: 'S1', modem_details: { IMEI: 'S1_A', NICK: 'MD_A' }, net_details: { IS_ONLINE: 'yes' } },
  { _server: 'S1', modem_details: { IMEI: 'S1_B', NICK: 'MD_B' }, net_details: { IS_ONLINE: 'no' } },  // offline now
  { _server: 'S2', modem_details: { IMEI: 'S2_C', NICK: 'RO_C' }, net_details: { IS_ONLINE: 'yes' } },
  { _server: 'S2', modem_details: { IMEI: 'S2_E', NICK: 'random99' }, net_details: { IS_ONLINE: 'yes' } }, // random
];

describe('computeFleet', () => {
  it('total = online-within-48h ∪ online-now; online from live; offline = total-online', () => {
    const f = computeFleet(meta, uptime, live, { now: NOW });
    // Fleet: A (online 2m), B (online 20h ago → still fleet), C (online 5m). D is a
    // Fleet roster: A, B, C AND the 10-day phantom D (total is STABLE — dead
    // hardware stays «у нас» until soft-delete). Active (48h): A, B, C only.
    expect(f.total).toBe(4);
    expect(f.active).toBe(3);
    expect(f.online).toBe(2);     // A + C are IS_ONLINE=yes
    expect(f.offline).toBe(1);    // B (in the active set via uptime, offline now)
    expect(f.online + f.offline).toBe(f.active);
    // MD_B is offline 20h → disconnected (>10 min); working = active − disconnected.
    expect(f.disconnected).toBe(1);
    expect(f.working).toBe(2);
    expect(f.byServer.S1).toEqual({ total: 2, active: 2, online: 1, offline: 1, disconnected: 1, working: 1 });
    expect(f.byServer.S2).toEqual({ total: 2, active: 1, online: 1, offline: 0, disconnected: 0, working: 1 });
    // offlineList lists exactly the offline fleet modems (for the «Модем отключен» card).
    expect(f.offlineList.map(o => o.nick)).toEqual(['MD_B']);
    expect(f.offlineList[0].server).toBe('S1');
  });

  it('online is ALWAYS ≤ total even if a server is unreachable (online union)', () => {
    // A modem online in the live snapshot but with NO uptime row yet (brand-new).
    const live2 = live.concat([{ _server: 'S3', modem_details: { IMEI: 'S3_NEW', NICK: 'NEW1' }, net_details: { IS_ONLINE: 'yes' } }]);
    const f = computeFleet(meta, uptime, live2, { now: NOW });
    expect(f.byServer.S3).toEqual({ total: 1, active: 1, online: 1, offline: 0, disconnected: 0, working: 1 });   // unioned into fleet
    expect(f.online).toBeLessThanOrEqual(f.total);
  });

  it('stays stable when the live snapshot collapses (server flake) — fleet from uptime', () => {
    // S2 returns nothing (unreachable); C should stay in the fleet (online 5m ago) but count offline.
    const liveFlake = live.filter(m => m._server !== 'S2');
    const f = computeFleet(meta, uptime, liveFlake, { now: NOW });
    expect(f.total).toBe(4);                 // A, B, C + phantom D (stable roster)
    // C went offline only 5 min ago (server flake) → still «working», NOT disconnected.
    expect(f.byServer.S2).toEqual({ total: 2, active: 1, online: 0, offline: 1, disconnected: 0, working: 1 });
    expect(f.online).toBeLessThanOrEqual(f.total);
  });

  it('cached live rows do not count as online', () => {
    const liveCached = live.map(m => ({ ...m, _cached: true }));
    const f = computeFleet(meta, uptime, liveCached, { now: NOW });
    expect(f.online).toBe(0);                // nothing live-online
    expect(f.total).toBe(4);                 // roster held regardless (stable)
    expect(f.offline).toBe(3);               // A, B, C — active but not online
  });

  it('disconnectedList = offline ≥10 min; a brief <10 min blip stays out', () => {
    // Two offline modems: one dark 3 min (blip), one dark 30 min (real outage).
    const meta2 = [
      { srv: 'S1', imei: 'X', nick: 'MD_X' },
      { srv: 'S1', imei: 'Y', nick: 'MD_Y' },
    ];
    const uptime2 = {
      'S1_X': { last_online_check: ago(3 * 60 * 1000) },    // dark 3 min → blip
      'S1_Y': { last_online_check: ago(30 * 60 * 1000) },   // dark 30 min → отключён
    };
    const live2 = [
      { _server: 'S1', modem_details: { IMEI: 'S1_X', NICK: 'MD_X' }, net_details: { IS_ONLINE: 'no' } },
      { _server: 'S1', modem_details: { IMEI: 'S1_Y', NICK: 'MD_Y' }, net_details: { IS_ONLINE: 'no' } },
    ];
    const f = computeFleet(meta2, uptime2, live2, { now: NOW });
    expect(f.offline).toBe(2);                                      // both offline now
    expect(f.offlineList.map(o => o.nick).sort()).toEqual(['MD_X', 'MD_Y']);
    expect(f.disconnected).toBe(1);                                 // only the 30-min one crossed 10 min
    expect(f.disconnectedList.map(o => o.nick)).toEqual(['MD_Y']);
    // working = active − disconnected: MD_X (3-min blip) still counts as working.
    expect(f.working).toBe(1);
    expect(f.byServer.S1).toEqual({ total: 2, active: 2, online: 0, offline: 2, disconnected: 1, working: 1 });
  });

  it('disconnectedMs is configurable', () => {
    const meta2 = [{ srv: 'S1', imei: 'Y', nick: 'MD_Y' }];
    const uptime2 = { 'S1_Y': { last_online_check: ago(3 * 60 * 1000) } };
    const loose = computeFleet(meta2, uptime2, [], { now: NOW, disconnectedMs: 2 * 60 * 1000 });
    expect(loose.disconnected).toBe(1);      // 3 min ≥ 2 min threshold → in
    const strict = computeFleet(meta2, uptime2, [], { now: NOW, disconnectedMs: 10 * 60 * 1000 });
    expect(strict.disconnected).toBe(0);     // 3 min < 10 min → out
  });
});

describe('computeFleet — glitched-to-random credit', () => {
  // When ProxySmart can't read a modem's IMEI it re-enumerates it as a
  // "random####" port (IMEI = USB path, IS_ONLINE=yes — physically UP), while the
  // real identity lingers offline with an EMPTY USB slot. That twin must NOT drag
  // the count down («82/83, хотя модемы стали рэндомпортами») — but a GENUINE
  // outage must still be counted. These guard both halves.
  const mins = (m) => m * 60 * 1000;
  const okMeta = { srv: 'S4', imei: 'OK', nick: 'MD_OK' };
  const okUp = { 'S4_OK': { last_online_check: ago(mins(1)) } };
  const okLive = { _server: 'S4', modem_details: { IMEI: 'S4_OK', NICK: 'MD_OK', USB_ID: '1-1.1' }, net_details: { IS_ONLINE: 'yes' } };
  const offl = (imei, nick, usb) => ({ _server: 'S4', modem_details: { IMEI: 'S4_' + imei, NICK: nick, USB_ID: usb }, net_details: { IS_ONLINE: 'no' } });
  const rnd = (path) => ({ _server: 'S4', modem_details: { IMEI: 'S4_' + path, NICK: 'random' + path.replace(/\D/g, ''), USB_ID: path }, net_details: { IS_ONLINE: 'yes' } });

  it('credits a glitched-to-random modem (usb-less disconnected twin + up-random)', () => {
    const meta2 = [okMeta, { srv: 'S4', imei: 'G', nick: 'MD_G' }];
    const uptime2 = { ...okUp, 'S4_G': { last_online_check: ago(mins(450)) } };   // dark 7.5h
    const f = computeFleet(meta2, uptime2, [okLive, offl('G', 'MD_G', ''), rnd('1-4.3.1.1')], { now: NOW });
    expect(f.total).toBe(2);
    expect(f.disconnected).toBe(0);    // glitched twin credited
    expect(f.working).toBe(2);         // count does NOT drop
    expect(f.online + f.offline).toBe(f.active);
  });

  it('does NOT hide a genuinely-dead modem that vanished from the feed (USB undefined)', () => {
    const meta2 = [okMeta, { srv: 'S4', imei: 'DEAD', nick: 'MD_DEAD' }];
    const uptime2 = { ...okUp, 'S4_DEAD': { last_online_check: ago(mins(40)) } };
    // MD_DEAD dropped out of the live feed entirely (dongle died); a random is up.
    const f = computeFleet(meta2, uptime2, [okLive, rnd('1-4.3.1.1')], { now: NOW });
    expect(f.disconnected).toBe(1);    // dead modem stays counted as down
    expect(f.disconnectedList.map(o => o.nick)).toEqual(['MD_DEAD']);
    expect(f.working).toBe(1);
  });

  it('does NOT spill credit onto a dead modem when randoms are explained by <10min blips', () => {
    const meta2 = [okMeta,
      { srv: 'S4', imei: 'B1', nick: 'MD_B1' }, { srv: 'S4', imei: 'B2', nick: 'MD_B2' },
      { srv: 'S4', imei: 'DEAD', nick: 'MD_DEAD' }];
    const uptime2 = { ...okUp,
      'S4_B1': { last_online_check: ago(mins(3)) }, 'S4_B2': { last_online_check: ago(mins(5)) },  // blips
      'S4_DEAD': { last_online_check: ago(mins(120)) } };                                          // genuinely dead
    const live2 = [okLive, offl('B1', 'MD_B1', ''), offl('B2', 'MD_B2', ''), offl('DEAD', 'MD_DEAD', ''),
      rnd('1-4.3.1.1'), rnd('1-4.3.3.2')];   // upRandom=2, but both explained by the 2 blips
    const f = computeFleet(meta2, uptime2, live2, { now: NOW });
    expect(f.disconnected).toBe(1);                        // effective = 2 − 2 = 0 → DEAD not credited
    expect(f.disconnectedList.map(o => o.nick)).toEqual(['MD_DEAD']);
    expect(f.working).toBe(3);                             // 4 total − 1 dead
  });

  it('does NOT credit an offline modem that keeps its own USB slot', () => {
    const meta2 = [okMeta, { srv: 'S4', imei: 'P', nick: 'MD_P' }];
    const uptime2 = { ...okUp, 'S4_P': { last_online_check: ago(mins(30)) } };
    const f = computeFleet(meta2, uptime2, [okLive, offl('P', 'MD_P', '1-4.3.2.3'), rnd('1-4.3.1.1')], { now: NOW });
    expect(f.disconnected).toBe(1);    // holds its USB slot → genuine outage, not a glitch
    expect(f.disconnectedList.map(o => o.nick)).toEqual(['MD_P']);
  });

  it('per-server gate: a server with no up-randoms is never credited', () => {
    const meta2 = [okMeta, { srv: 'S4', imei: 'G', nick: 'MD_G' }];
    const uptime2 = { ...okUp, 'S4_G': { last_online_check: ago(mins(450)) } };
    const f = computeFleet(meta2, uptime2, [okLive, offl('G', 'MD_G', '')], { now: NOW });   // no random on S4
    expect(f.disconnected).toBe(1);    // usb-less but no random ⇒ no credit ⇒ stays down
    expect(f.working).toBe(1);
  });

  it('total (roster) is STABLE: >48h-dead modems stay in total but out of active/working/offline', () => {
    // The «вторая цифра» the operator asked about: fleet size must not decay as
    // offline time passes — only soft-delete shrinks it.
    const meta2 = [okMeta, { srv: 'S4', imei: 'OLD', nick: 'MD_OLD' }];
    const uptime2 = { ...okUp, 'S4_OLD': { last_online_check: ago(10 * 24 * H) } };
    const f = computeFleet(meta2, uptime2, [okLive], { now: NOW });
    expect(f.total).toBe(2);      // OLD still «у нас есть»
    expect(f.active).toBe(1);     // but not in the operational set
    expect(f.working).toBe(1);
    expect(f.offline).toBe(0);    // offline covers the active set only
    expect(f.disconnected).toBe(0);
    expect(f.byServer.S4.total).toBe(2);
    expect(f.byServer.S4.working).toBe(1);
  });
});

describe('annotateTestPool', () => {
  const { annotateTestPool } = require('../src/modems/fleet.js');
  it('flags live entries whose (server, nick) is in the pool set', () => {
    const status = [
      { _server: 'S1', modem_details: { NICK: 'MD_A' }, net_details: {} },
      { _server: 'S1', modem_details: { NICK: 'MD_TEST' }, net_details: {} },
      { _server: 'S2', modem_details: { NICK: 'MD_TEST' }, net_details: {} }, // same nick, other server
    ];
    annotateTestPool(status, new Set(['S1|MD_TEST']));
    expect(status[0].isTestPool).toBeUndefined();
    expect(status[1].isTestPool).toBe(true);
    expect(status[2].isTestPool).toBeUndefined();
  });
  it('tolerates empty pool / null input without touching entries', () => {
    const status = [{ _server: 'S1', modem_details: { NICK: 'MD_A' } }];
    annotateTestPool(status, new Set());
    expect(status[0].isTestPool).toBeUndefined();
    expect(annotateTestPool(null, new Set(['S1|MD_A']))).toBe(null);
  });
});

describe('computeClientWorking', () => {
  const { computeClientWorking, computeFleet } = require('../src/modems/fleet.js');
  it('per-client working = roster-bound ∩ active ∩ not-dark-≥10min', () => {
    const meta = [
      { srv: 'S1', imei: 'A', nick: 'MD_A' },
      { srv: 'S1', imei: 'B', nick: 'MD_B' },
      { srv: 'S1', imei: 'C', nick: 'MD_C' },
    ];
    const uptime = {
      'S1_A': { last_online_check: ago(1 * 60 * 1000) },      // online
      'S1_B': { last_online_check: ago(30 * 60 * 1000) },     // dark 30 min → disconnected
      'S1_C': { last_online_check: ago(10 * 24 * H) },        // dead 10d → not active
    };
    const live = [{ _server: 'S1', modem_details: { IMEI: 'S1_A', NICK: 'MD_A' }, net_details: { IS_ONLINE: 'yes' } }];
    const fleet = computeFleet(meta, uptime, live, { now: NOW });
    const known = { S1: {
      p1: { imei: 'A', nick: 'MD_A', portName: 'CLIENT', lastClientSeen: NOW },
      p2: { imei: 'B', nick: 'MD_B', portName: 'CLIENT', lastClientSeen: NOW },
      p3: { imei: 'C', nick: 'MD_C', portName: 'CLIENT', lastClientSeen: NOW },
      p4: { imei: 'X', nick: 'MD_X', portName: 'CLIENT', lastClientSeen: NOW - 25 * 3600 * 1000 }, // aged out of roster
      p5: { imei: 'T', nick: 'MD_T', portName: 'random77', lastClientSeen: NOW },                 // placeholder → skip
    }};
    const w = computeClientWorking(known, fleet, { now: NOW });
    expect(w.CLIENT).toBe(1);   // only A: B dark ≥10min, C inactive >48h, X aged out, random skipped
    expect(w.random77).toBeUndefined();
  });
});
