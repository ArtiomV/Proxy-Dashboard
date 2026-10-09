'use strict';
const assert = require('node:assert/strict');
const { computeFleet, computeClientWorking } = require('../../src/modems/fleet');
const now = Date.parse('2026-10-09T12:00:00Z');
const roster = [{ srv: 'S1', imei: 'i1', nick: 'M1' }];
const results = [];
for (const value of [undefined, 'invalid-date']) {
  const uptime = value === undefined ? {} : { S1_i1: { last_online_check: value } };
  const first = computeFleet(roster, uptime, [], { now });
  const later = computeFleet(roster, uptime, [], { now: now + 7 * 86400000 });
  assert.equal(first.online, 0);
  assert.equal(first.offline, 1);
  assert.equal(first.working, 1);
  assert.equal(later.working, 1);
  assert.equal(later.disconnectedList.length, 0);
  const clients = computeClientWorking({ S1: { p1: { imei: 'i1', nick: 'M1', portName: 'test-client', lastClientSeen: now } } }, first, { now });
  assert.equal(clients['test-client'], 1);
  results.push({ lastOnline: value || 'missing', offline: first.offline, working: first.working,
    workingAfterSevenDays: later.working, disconnectedAfterSevenDays: later.disconnected, clientWorking: clients['test-client'] });
}
const control = computeFleet(roster, { S1_i1: { last_online_check: new Date(now - 3600000).toISOString() } }, [], { now });
assert.equal(control.working, 0);
assert.equal(control.disconnected, 1);
console.log(JSON.stringify({ finding: 'DEEP-82', isolation: 'actual pure fleet functions; no database/network',
  cases: results, controlWithKnownOldTimestamp: { working: control.working, disconnected: control.disconnected },
  limitation: 'absence/invalid timestamp supplied directly; production prevalence and full tracking lifecycle not measured' }, null, 2));
