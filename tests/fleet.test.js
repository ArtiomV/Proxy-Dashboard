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
    // 10-day phantom → excluded. random E → excluded.
    expect(f.total).toBe(3);
    expect(f.online).toBe(2);     // A + C are IS_ONLINE=yes
    expect(f.offline).toBe(1);    // B (in fleet via uptime, offline now)
    expect(f.online + f.offline).toBe(f.total);
    // MD_B is offline 20h → disconnected (>10 min); working = total − disconnected.
    expect(f.disconnected).toBe(1);
    expect(f.working).toBe(2);
    expect(f.byServer.S1).toEqual({ total: 2, online: 1, offline: 1, disconnected: 1, working: 1 });
    expect(f.byServer.S2).toEqual({ total: 1, online: 1, offline: 0, disconnected: 0, working: 1 });
    // offlineList lists exactly the offline fleet modems (for the «Модем отключен» card).
    expect(f.offlineList.map(o => o.nick)).toEqual(['MD_B']);
    expect(f.offlineList[0].server).toBe('S1');
  });

  it('online is ALWAYS ≤ total even if a server is unreachable (online union)', () => {
    // A modem online in the live snapshot but with NO uptime row yet (brand-new).
    const live2 = live.concat([{ _server: 'S3', modem_details: { IMEI: 'S3_NEW', NICK: 'NEW1' }, net_details: { IS_ONLINE: 'yes' } }]);
    const f = computeFleet(meta, uptime, live2, { now: NOW });
    expect(f.byServer.S3).toEqual({ total: 1, online: 1, offline: 0, disconnected: 0, working: 1 });   // unioned into fleet
    expect(f.online).toBeLessThanOrEqual(f.total);
  });

  it('stays stable when the live snapshot collapses (server flake) — fleet from uptime', () => {
    // S2 returns nothing (unreachable); C should stay in the fleet (online 5m ago) but count offline.
    const liveFlake = live.filter(m => m._server !== 'S2');
    const f = computeFleet(meta, uptime, liveFlake, { now: NOW });
    expect(f.total).toBe(3);                 // A, B, C still counted (uptime history)
    // C went offline only 5 min ago (server flake) → still «working», NOT disconnected.
    expect(f.byServer.S2).toEqual({ total: 1, online: 0, offline: 1, disconnected: 0, working: 1 });
    expect(f.online).toBeLessThanOrEqual(f.total);
  });

  it('cached live rows do not count as online', () => {
    const liveCached = live.map(m => ({ ...m, _cached: true }));
    const f = computeFleet(meta, uptime, liveCached, { now: NOW });
    expect(f.online).toBe(0);                // nothing live-online
    expect(f.total).toBe(3);                 // but fleet held by uptime history
    expect(f.offline).toBe(3);
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
    // working = total − disconnected: MD_X (3-min blip) still counts as working.
    expect(f.working).toBe(1);
    expect(f.byServer.S1).toEqual({ total: 2, online: 0, offline: 2, disconnected: 1, working: 1 });
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
