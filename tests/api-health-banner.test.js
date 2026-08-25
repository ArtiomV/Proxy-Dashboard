// 25.08: cachedServers в mergeServerData несёт authError/lastError из
// serverApiHealth — чтобы баннер админки отличал «бокс лежит» (сеть) от
// «слетела авторизация ProxySmart» (401, чинится сменой кредов).

import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const proxyData = require('../src/services/proxy-data.js');

function mk(health) {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE modem_meta (server_name TEXT, imei TEXT, operator TEXT)');
  return proxyData.create({
    db,
    knownModems: {},
    filterByPortName: (d) => d,
    isAutoRandomPort: () => false,
    modemLogins: {},
    getServerApiHealth: () => health,
  });
}

const cachedPayload = (name) => ({
  serverName: name, bw: {}, status: [], ports: {},
  _cached: true, _cachedAt: Date.now() - 15 * 60000,
});

describe('mergeServerData: apiHealth → cachedServers', () => {
  it('401 → authError=true и текст ошибки проброшен', () => {
    const { mergeServerData } = mk({
      S1: { lastOkAt: null, lastError: 'S1 HTTP 401: Unauthorized', lastErrorAt: Date.now(), authError: true },
    });
    const out = mergeServerData([cachedPayload('S1')], '*');
    expect(out.cachedServers).toHaveLength(1);
    expect(out.cachedServers[0]).toMatchObject({ name: 'S1', authError: true });
    expect(out.cachedServers[0].lastError).toContain('401');
  });

  it('сетевой аут (не 401) → authError=false', () => {
    const { mergeServerData } = mk({
      S2: { lastOkAt: null, lastError: 'Timeout from S2', lastErrorAt: Date.now(), authError: false },
    });
    const out = mergeServerData([cachedPayload('S2')], '*');
    expect(out.cachedServers[0].authError).toBe(false);
  });

  it('без getServerApiHealth (старый wiring) — поля по умолчанию, ничего не падает', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE modem_meta (server_name TEXT, imei TEXT, operator TEXT)');
    const { mergeServerData } = proxyData.create({
      db, knownModems: {}, filterByPortName: (d) => d, isAutoRandomPort: () => false, modemLogins: {},
    });
    const out = mergeServerData([cachedPayload('S3')], '*');
    expect(out.cachedServers[0]).toMatchObject({ name: 'S3', authError: false, lastError: '' });
  });
});
