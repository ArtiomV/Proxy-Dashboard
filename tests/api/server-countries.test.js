// WP4.3: SERVER_COUNTRIES must reflect apiServers mutations WITHOUT a restart.

import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'module';
import { bootApp } from '../_helpers/app.js';

const require = createRequire(import.meta.url);
let server;

beforeAll(() => {
  bootApp();
  server = require('../../server.js');
});

describe('WP4.3: SERVER_COUNTRIES stays fresh', () => {
  it('add server → country visible immediately; remove → gone', () => {
    const { apiServers, SERVER_COUNTRIES, rebuildServerCountries } = server;
    const fake = { name: 'TST9', url: 'http://127.0.0.1:9', publicIp: '127.0.0.1', country: 'MD', countryName: 'Moldova', tz: 'Europe/Chisinau' };
    apiServers.push(fake);
    try {
      rebuildServerCountries();
      expect(SERVER_COUNTRIES.TST9).toMatchObject({ country: 'MD', name: 'Moldova', tz: 'Europe/Chisinau' });

      // Edit country at runtime → rebuild reflects it (the old stale-map bug).
      fake.country = 'RO'; fake.countryName = 'Romania';
      rebuildServerCountries();
      expect(SERVER_COUNTRIES.TST9.country).toBe('RO');

      apiServers.splice(apiServers.indexOf(fake), 1);
      rebuildServerCountries();
      expect(SERVER_COUNTRIES.TST9).toBeUndefined();
    } finally {
      const i = apiServers.indexOf(fake);
      if (i >= 0) apiServers.splice(i, 1);
      rebuildServerCountries();
    }
  });
});
