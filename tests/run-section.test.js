// WP6.2: one failing /api/admin/data section must degrade, not 502 the panel.

import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { _runSection } = require('../src/routes/ops-ext.js');

const silentLogger = { warn() {}, info() {}, error() {}, debug() {} };

describe('_runSection degradation wrapper', () => {
  it('returns the section value on success', () => {
    expect(_runSection(silentLogger, 'ok', () => ({ a: 1 }), { a: 0 })).toEqual({ a: 1 });
  });
  it('returns the fallback on throw and does NOT rethrow', () => {
    const fallback = { fleet: { total: 0 } };
    const out = _runSection(silentLogger, 'boom', () => { throw new Error('db exploded'); }, fallback);
    expect(out).toBe(fallback);
  });
  it('logs a warning with the section name on failure', () => {
    const warnings = [];
    const logger = { warn: (m) => warnings.push(m) };
    _runSection(logger, 'fleet', () => { throw new Error('x'); }, {});
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain('fleet');
  });
});
