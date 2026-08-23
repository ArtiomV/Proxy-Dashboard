import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const traffic = require('../src/utils/traffic.js');

afterEach(() => traffic.setOperatorAliases({}));

describe('operator aliases', () => {
  it('canonicalizes a ProxySmart spelling before built-in heuristics', () => {
    traffic.setOperatorAliases({ 'orange moldova': 'Orange MD' });
    expect(traffic.normalizeOperator('  Orange   Moldova ', false)).toBe('Orange MD');
  });

  it('resolves alias chains and stops cycles safely', () => {
    traffic.setOperatorAliases({ one: 'Two', two: 'Three' });
    expect(traffic.resolveOperatorAlias('ONE')).toBe('Three');
    traffic.setOperatorAliases({ one: 'Two', two: 'One' });
    expect(['One', 'Two']).toContain(traffic.resolveOperatorAlias('one'));
  });
});
