import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { _srvMetUptime, _srvMetCpuModelLabel } = require('../public/js/admin/server-metrics.js');

describe('server card uptime formatter', () => {
  it('rounds sub-day uptime to one hours-only value', () => {
    expect(_srvMetUptime(20 * 3600 + 26 * 60)).toBe('20ч');
    expect(_srvMetUptime(20 * 3600 + 31 * 60)).toBe('21ч');
    expect(_srvMetUptime(10 * 60)).toBe('1ч');
  });

  it('rounds uptime from 24 hours to one days-only value', () => {
    expect(_srvMetUptime(24 * 3600)).toBe('1д');
    expect(_srvMetUptime(36 * 3600)).toBe('2д');
    expect(_srvMetUptime(10 * 86400 + 3 * 3600)).toBe('10д');
  });

  it('keeps missing uptime empty', () => {
    expect(_srvMetUptime(0)).toBeNull();
    expect(_srvMetUptime(null)).toBeNull();
  });
});

describe('server card CPU model formatter', () => {
  it('removes the CPU generation prefix from the displayed model', () => {
    expect(_srvMetCpuModelLabel('12th Gen Intel(R) Core(TM) i5-12400 CPU @ 2.50GHz', 12))
      .toBe('i5-12400 · 12 пот.');
  });

  it('keeps models without a generation prefix compact', () => {
    expect(_srvMetCpuModelLabel('Intel(R) Core(TM) i3-10100 CPU @ 3.60GHz', 8))
      .toBe('i3-10100 · 8 пот.');
  });
});
