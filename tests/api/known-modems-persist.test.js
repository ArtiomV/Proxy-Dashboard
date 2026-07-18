// WP4: the known_modems roster persists to SQLite (backup-complete) —
// write path persists every entry, gone entries are wiped (old file semantics).

import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'module';
import { bootApp } from '../_helpers/app.js';

const require = createRequire(import.meta.url);
let db, server, stateMod;

beforeAll(() => {
  const ctx = bootApp();
  db = ctx.db;
  server = require('../../server.js');
  stateMod = require('../../src/state/index.js');
});

describe('WP4: known_modems roster in SQLite', () => {
  it('table exists after migrations (046)', () => {
    const t = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='known_modems'").get();
    expect(t).toBeTruthy();
  });

  it('saveKnownModems persists the full roster; entries gone from memory are wiped', () => {
    const { state, setKnownModems } = stateMod;
    const backup = JSON.parse(JSON.stringify(state.knownModems));
    try {
      setKnownModems({
        WT1: {
          WT1_p1: { imei: 'IMEI_W1', nick: 'MD_W1', portName: 'clientA', lastClientSeen: 123 },
          WT1_p2: { imei: 'IMEI_W2', nick: 'MD_W2', portName: 'clientB', lastSeen: 456 },
        },
        WT2: { WT2_p1: { imei: 'IMEI_W3', nick: 'MD_W3', portName: 'clientC', lastSeen: 789 } },
      });
      server.saveKnownModems();

      const rows = db.prepare('SELECT server_name, port_key, data FROM known_modems WHERE server_name LIKE \'WT%\' ORDER BY port_key').all();
      expect(rows.length).toBe(3);
      const p1 = rows.find(r => r.port_key === 'WT1_p1');
      expect(JSON.parse(p1.data)).toMatchObject({ imei: 'IMEI_W1', nick: 'MD_W1', portName: 'clientA', lastClientSeen: 123 });

      // Wipe one server from memory → its rows must disappear on next save.
      const { [ 'WT2' ]: _dropped, ...rest } = stateMod.state.knownModems;
      setKnownModems(rest);
      server.saveKnownModems();
      const left = db.prepare("SELECT COUNT(*) n FROM known_modems WHERE server_name = 'WT2'").get().n;
      expect(left).toBe(0);
    } finally {
      setKnownModems(backup);
      server.saveKnownModems();
    }
  });
});
