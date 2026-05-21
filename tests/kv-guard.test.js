// Regression tests for src/utils/kv-guard.js
//
// These cover the silent-data-loss bug from 2026-05-20: env-defined servers
// lost UI-set metadata fields on every pm2 restart because the env↔DB merge
// dropped them. Any future change to the merge logic that re-introduces this
// behaviour will trip these tests.

import { describe, it, expect } from 'vitest';
import {
  KV_CRITICAL_SHAPES,
  shapeRegressions,
  mergeDbMetadataIntoEnvServers,
  DB_META_FIELDS,
} from '../src/utils/kv-guard.js';

describe('mergeDbMetadataIntoEnvServers', () => {
  it('preserves DB-set metadata when env redefines the same server', () => {
    const env = [{ name: 'S1', url: 'http://1.2.3.4', user: 'u', pass: 'p', publicIp: '1.2.3.4' }];
    const db  = [{
      name: 'S1', url: 'http://1.2.3.4', user: 'u', pass: 'p', publicIp: '1.2.3.4',
      address: 'Kishinev, Armyanskaya 30',
      hardware: 'i3-10100 / 8GB',
      country: 'MD', countryName: 'Moldova', tz: 'Europe/Chisinau',
      osLogin: 'md1', osPassword: 'Admin123',
    }];
    mergeDbMetadataIntoEnvServers(env, db);
    expect(env).toHaveLength(1);
    expect(env[0]).toMatchObject({
      name: 'S1',
      address: 'Kishinev, Armyanskaya 30',
      hardware: 'i3-10100 / 8GB',
      country: 'MD',
      osLogin: 'md1',
      osPassword: 'Admin123',
    });
  });

  it('adds DB-only servers (not in env) to the list', () => {
    const env = [{ name: 'S1', url: 'http://x', user: 'u', pass: 'p', publicIp: 'x' }];
    const db  = [{ name: 'S3', url: 'http://y', address: 'somewhere' }];
    mergeDbMetadataIntoEnvServers(env, db);
    expect(env.map(s => s.name).sort()).toEqual(['S1', 'S3']);
  });

  it('env-owned fields (url/user/pass/publicIp) survive even if DB disagrees', () => {
    const env = [{ name: 'S1', url: 'http://env-url', user: 'env-u', pass: 'env-p', publicIp: 'env-ip' }];
    const db  = [{ name: 'S1', url: 'http://db-url', user: 'db-u', pass: 'db-p', publicIp: 'db-ip', address: 'somewhere' }];
    mergeDbMetadataIntoEnvServers(env, db);
    expect(env[0].url).toBe('http://env-url');
    expect(env[0].user).toBe('env-u');
    expect(env[0].pass).toBe('env-p');
    expect(env[0].publicIp).toBe('env-ip');
    // But metadata still merges:
    expect(env[0].address).toBe('somewhere');
  });

  it('empty-string DB values do NOT overwrite present env values', () => {
    const env = [{ name: 'S1', address: 'env-address', hardware: 'env-hw' }];
    const db  = [{ name: 'S1', address: '', hardware: '' }];
    mergeDbMetadataIntoEnvServers(env, db);
    expect(env[0].address).toBe('env-address');
    expect(env[0].hardware).toBe('env-hw');
  });

  it('exposes all expected DB metadata fields', () => {
    expect(DB_META_FIELDS).toEqual(
      expect.arrayContaining(['osLogin', 'osPassword', 'hardware', 'address', 'country', 'countryName', 'tz'])
    );
  });
});

describe('KV_CRITICAL_SHAPES.api_servers', () => {
  it('counts populated metadata fields per server', () => {
    const value = JSON.stringify([
      { name: 'S1', user: 'u', pass: 'p', address: 'a', osLogin: 'l', country: 'MD' },
      { name: 'S2', user: 'u', pass: 'p', address: 'b' },
      { name: 'S3' },
    ]);
    const shape = KV_CRITICAL_SHAPES.api_servers(value);
    expect(shape.count).toBe(3);
    expect(shape.address).toBe(2);
    expect(shape.osLogin).toBe(1);
    expect(shape.country).toBe(1);
    expect(shape.panelUser).toBe(2);
    expect(shape.panelPassword).toBe(2);
  });

  it('marks malformed JSON as invalid', () => {
    expect(KV_CRITICAL_SHAPES.api_servers('not json').invalid).toBe(true);
  });

  it('marks non-array JSON as invalid', () => {
    expect(KV_CRITICAL_SHAPES.api_servers('{"foo":"bar"}').invalid).toBe(true);
  });
});

describe('shapeRegressions', () => {
  it('returns empty array when nothing regressed', () => {
    const before = { count: 4, address: 2 };
    const after  = { count: 4, address: 2 };
    expect(shapeRegressions(before, after)).toEqual([]);
  });

  it('returns empty when fields grow', () => {
    const before = { count: 4, address: 2 };
    const after  = { count: 5, address: 3 };
    expect(shapeRegressions(before, after)).toEqual([]);
  });

  it('flags every field that strictly decreased', () => {
    // This is the exact pattern from the 2026-05-20 incident
    const before = { count: 4, address: 3, hardware: 3, osLogin: 4 };
    const after  = { count: 4, address: 1, hardware: 1, osLogin: 2 };
    const regs = shapeRegressions(before, after);
    expect(regs).toHaveLength(3);
    expect(regs.find(r => r.field === 'address')).toMatchObject({ before: 3, after: 1 });
    expect(regs.find(r => r.field === 'hardware')).toMatchObject({ before: 3, after: 1 });
    expect(regs.find(r => r.field === 'osLogin')).toMatchObject({ before: 4, after: 2 });
  });

  it('ignores invalid shapes (defensively returns empty)', () => {
    expect(shapeRegressions({ invalid: true }, { count: 1 })).toEqual([]);
    expect(shapeRegressions({ count: 1 }, { invalid: true })).toEqual([]);
    expect(shapeRegressions(null, { count: 1 })).toEqual([]);
  });

  it('integration: detects the 2026-05-20 incident as a regression', () => {
    // Before the bug fired: 4 servers, all with metadata
    const goodValue = JSON.stringify([
      { name: 'S1', user: 'u', pass: 'p', address: 'a', osLogin: 'l', hardware: 'h' },
      { name: 'S2', user: 'u', pass: 'p', osLogin: 'l' },
      { name: 'S3', user: 'u', pass: 'p', address: 'a', osLogin: 'l', hardware: 'h' },
      { name: 'S4', user: 'u', pass: 'p', address: 'a', osLogin: 'l', hardware: 'h' },
    ]);
    // After bad merge wiped S1: only connection fields remain
    const badValue = JSON.stringify([
      { name: 'S1', user: 'u', pass: 'p' },                                      // wiped
      { name: 'S2', user: 'u', pass: 'p' },                                      // wiped
      { name: 'S3', user: 'u', pass: 'p', address: 'a', osLogin: 'l', hardware: 'h' },
      { name: 'S4', user: 'u', pass: 'p', address: 'a', osLogin: 'l', hardware: 'h' },
    ]);
    const before = KV_CRITICAL_SHAPES.api_servers(goodValue);
    const after  = KV_CRITICAL_SHAPES.api_servers(badValue);
    const regs = shapeRegressions(before, after);
    expect(regs.length).toBeGreaterThan(0);
    // Address went 3→2, osLogin 4→2, hardware 3→2
    expect(regs.find(r => r.field === 'address')).toBeTruthy();
    expect(regs.find(r => r.field === 'osLogin')).toBeTruthy();
    expect(regs.find(r => r.field === 'hardware')).toBeTruthy();
  });
});
