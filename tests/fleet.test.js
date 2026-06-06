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
    expect(f.byServer.S1).toEqual({ total: 2, online: 1, offline: 1 });
    expect(f.byServer.S2).toEqual({ total: 1, online: 1, offline: 0 });
  });

  it('online is ALWAYS ≤ total even if a server is unreachable (online union)', () => {
    // A modem online in the live snapshot but with NO uptime row yet (brand-new).
    const live2 = live.concat([{ _server: 'S3', modem_details: { IMEI: 'S3_NEW', NICK: 'NEW1' }, net_details: { IS_ONLINE: 'yes' } }]);
    const f = computeFleet(meta, uptime, live2, { now: NOW });
    expect(f.byServer.S3).toEqual({ total: 1, online: 1, offline: 0 });   // unioned into fleet
    expect(f.online).toBeLessThanOrEqual(f.total);
  });

  it('stays stable when the live snapshot collapses (server flake) — fleet from uptime', () => {
    // S2 returns nothing (unreachable); C should stay in the fleet (online 5m ago) but count offline.
    const liveFlake = live.filter(m => m._server !== 'S2');
    const f = computeFleet(meta, uptime, liveFlake, { now: NOW });
    expect(f.total).toBe(3);                 // A, B, C still counted (uptime history)
    expect(f.byServer.S2).toEqual({ total: 1, online: 0, offline: 1 });   // C now offline, not dropped
    expect(f.online).toBeLessThanOrEqual(f.total);
  });

  it('cached live rows do not count as online', () => {
    const liveCached = live.map(m => ({ ...m, _cached: true }));
    const f = computeFleet(meta, uptime, liveCached, { now: NOW });
    expect(f.online).toBe(0);                // nothing live-online
    expect(f.total).toBe(3);                 // but fleet held by uptime history
    expect(f.offline).toBe(3);
  });
});
