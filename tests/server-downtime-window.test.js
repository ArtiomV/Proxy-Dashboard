import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { resolvePeriod, unionDurationSec, buildDowntimeWindow } = require('../src/server-downtime-window.js');

const NOW = Date.parse('2026-08-23T12:00:00.000Z');

describe('server downtime window', () => {
  it('clips completed episodes to the selected window and includes an ongoing outage', () => {
    const result = buildDowntimeWindow({
      nowMs: NOW,
      period: '24h',
      servers: [
        { name: 'S1', displayName: 'Кишинёв' },
        { name: 'S2', displayName: 'Бухарест' },
      ],
      rows: [
        { server_name: 'S1', down_from: '2026-08-22T10:00:00.000Z', down_to: '2026-08-22T13:00:00.000Z' },
        { server_name: 'S1', down_from: '2026-08-23T10:00:00.000Z', down_to: '2026-08-23T10:30:00.000Z' },
      ],
      ongoing: { S2: Date.parse('2026-08-23T11:45:00.000Z') },
    });

    expect(result.from).toBe('2026-08-22T12:00:00.000Z');
    expect(result.to).toBe('2026-08-23T12:00:00.000Z');
    expect(result.servers[0]).toMatchObject({
      name: 'S1', display_name: 'Кишинёв', episodes: 2, duration_sec: 5400, uptime_pct: 93.75,
    });
    expect(result.servers[0].events[0].from).toBe(result.from);
    expect(result.servers[1]).toMatchObject({
      name: 'S2', episodes: 1, duration_sec: 900, uptime_pct: 98.958,
    });
    expect(result.servers[1].events[0].ongoing).toBe(true);
  });

  it('does not double-count overlapping outage intervals', () => {
    const events = [
      { from: '2026-08-23T10:00:00.000Z', to: '2026-08-23T10:30:00.000Z' },
      { from: '2026-08-23T10:20:00.000Z', to: '2026-08-23T10:40:00.000Z' },
    ];
    expect(unionDurationSec(events)).toBe(2400);

    const result = buildDowntimeWindow({
      nowMs: NOW,
      period: '24h',
      servers: [{ name: 'S1' }],
      rows: events.map(event => ({ server_name: 'S1', down_from: event.from, down_to: event.to })),
    });
    expect(result.servers[0].episodes).toBe(2);
    expect(result.servers[0].duration_sec).toBe(2400);
  });

  it('does not duplicate an open database episode also present in live state', () => {
    const since = '2026-08-23T11:30:00.000Z';
    const result = buildDowntimeWindow({
      nowMs: NOW,
      period: '24h',
      servers: [{ name: 'S1' }],
      rows: [{ server_name: 'S1', down_from: since, down_to: null }],
      ongoing: { S1: Date.parse(since) },
    });
    expect(result.servers[0]).toMatchObject({ episodes: 1, duration_sec: 1800 });
  });

  it('returns configured servers with 100% availability when there were no outages', () => {
    const result = buildDowntimeWindow({
      nowMs: NOW,
      period: '7d',
      servers: [{ name: 'S1', displayName: 'Основной', country: 'Молдова' }],
    });
    expect(result.period).toBe('7d');
    expect(result.servers[0]).toMatchObject({
      name: 'S1', display_name: 'Основной', country: 'Молдова', episodes: 0,
      duration_sec: 0, uptime_pct: 100,
    });
  });

  it('accepts only supported periods', () => {
    expect(resolvePeriod()).toBe('24h');
    expect(resolvePeriod('30d')).toBe('30d');
    expect(resolvePeriod('1y')).toBeNull();
  });
});
