// ClientActivitySync: снимок «активен/неактивен» (нет портов) для CRM-агента.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const mod = require('../src/jobs/client-activity-sync.js');

function mk({ feed, clients, prev }) {
  const store = new Map(prev ? [[mod.KEY, { value: JSON.stringify(prev) }]] : []);
  const job = mod.create({
    logger: { info() {}, warn() {}, error() {} },
    clients,
    fetchAllServersDataCached: async () => feed,
    kvGet: (k) => store.get(k),
    kvSet: (k, v) => store.set(k, { value: v }),
    portValidity: {
      clientPortsIndex: (r) => {
        const m = new Map();
        for (const d of r) for (const l of Object.values(d.ports || {})) for (const p of l) {
          if (!m.has(p.portName)) m.set(p.portName, []);
          m.get(p.portName).push(p);
        }
        return m;
      },
      clientPortsFromIndex: (c, i) => i.get(c.portName) || [],
    },
  });
  return { job, read: () => JSON.parse(store.get(mod.KEY).value) };
}

const feed = [{ serverName: 'S1', ports: { a: [{ portName: 'alive', portID: 'p1' }] } }];
const clients = [{ id: 'c1', portName: 'alive' }, { id: 'c2', portName: 'gone' }];

describe('client-activity-sync', () => {
  it('помечает клиента без портов неактивным, с портами — активным', async () => {
    const { job, read } = mk({ feed, clients });
    const r = await job.runOnce();
    expect(r).toMatchObject({ status: 'completed', total: 2, inactive: 1 });
    const s = read().clients;
    expect(s.c1).toEqual({ active: true, ports: 1, inactiveSince: null });
    expect(s.c2.active).toBe(false);
    expect(s.c2.inactiveSince).toBeTruthy();
  });

  it('inactiveSince не сдвигается между прогонами и сбрасывается при возврате портов', async () => {
    const since = '2026-10-01T00:00:00.000Z';
    const prev = { clients: { c2: { active: false, ports: 0, inactiveSince: since } } };
    const a = mk({ feed, clients, prev });
    await a.job.runOnce();
    expect(a.read().clients.c2.inactiveSince).toBe(since);
    const back = [{ serverName: 'S1', ports: { a: [{ portName: 'alive', portID: 'p1' }, { portName: 'gone', portID: 'p2' }] } }];
    const b = mk({ feed: back, clients, prev });
    await b.job.runOnce();
    expect(b.read().clients.c2).toEqual({ active: true, ports: 1, inactiveSince: null });
  });

  it('пустой фид не перетирает снимок', async () => {
    const { job } = mk({ feed: [], clients });
    expect(await job.runOnce()).toEqual({ status: 'skipped', reason: 'empty_feed' });
  });
});
