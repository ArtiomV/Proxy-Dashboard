import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { create } from '../src/jobs/conns-history';

function mkResults(total, opts = {}) {
  return [{
    serverName: 'S1',
    _cached: opts.cached || false,
    ports: {
      '860000000000001': [
        { conns_stats: { http: total - 1, socks5: 1, total } },
      ],
    },
  }];
}

describe('conns-history ring buffer', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('копит точки с шагом минуты и отдаёт [агоСек, total]', async () => {
    let total = 10;
    const job = create({
      getFetchAllServersDataCached: () => async () => mkResults(total),
      logger: { warn: vi.fn() },
    });
    await job.sample();
    vi.advanceTimersByTime(60_000); total = 25;
    await job.sample();
    const h = job.get();
    const arr = h['S1_860000000000001'];
    expect(arr.length).toBe(2);
    expect(arr[0][1]).toBe(10);
    expect(arr[1][1]).toBe(25);
    expect(arr[1][0]).toBe(0);          // свежая точка — 0 секунд назад
    expect(arr[0][0]).toBe(60);
  });

  it('дедуплицирует сэмплы чаще полушага и режет хвост старше часа', async () => {
    const job = create({
      getFetchAllServersDataCached: () => async () => mkResults(5),
      logger: { warn: vi.fn() },
    });
    await job.sample();
    vi.advanceTimersByTime(10_000);
    await job.sample();                  // < 30с от прошлой — не пишется
    expect(job.get()['S1_860000000000001'].length).toBe(1);
    // 70 минут сэмплов — хвост старше 65 минут отваливается
    for (let i = 0; i < 70; i++) { vi.advanceTimersByTime(60_000); await job.sample(); }
    const arr = job.get()['S1_860000000000001'];
    expect(arr.length).toBeLessThanOrEqual(66);
    expect(arr[0][0]).toBeLessThanOrEqual(65 * 60);
  });

  it('кэш недоступного сервера (_cached) не сэмплируется', async () => {
    const job = create({
      getFetchAllServersDataCached: () => async () => mkResults(5, { cached: true }),
      logger: { warn: vi.fn() },
    });
    await job.sample();
    expect(Object.keys(job.get()).length).toBe(0);
  });
});
