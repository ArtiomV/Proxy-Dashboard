// GET /api/admin/known_modems — лёгкий список модемов для чекбокс-пикеров
// админки (настройка speedtest_modems): ростер known_modems + оператор из
// modem_meta, soft-deleted не отдаём.

import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'module';
import { bootApp, asAdmin } from '../_helpers/app.js';

const require = createRequire(import.meta.url);
let db, app, stateMod;

beforeAll(() => {
  const ctx = bootApp();
  db = ctx.db;
  app = ctx.app;
  stateMod = require('../../src/state/index.js');
});

describe('GET /api/admin/known_modems', () => {
  it('отдаёт {server, nick, operator, address} без soft-deleted', async () => {
    const request = (await import('supertest')).default;
    const { state, setKnownModems } = stateMod;
    const backup = JSON.parse(JSON.stringify(state.knownModems));
    try {
      setKnownModems({
        ...backup,
        KM_T: {
          KM_T_p1: { imei: 'KM_IMEI_1', nick: 'KM_01', portName: 'clientX', lastSeen: 1 },
          KM_T_p2: { imei: 'KM_IMEI_2', nick: 'KM_02', portName: '', lastSeen: 1 },
        },
      });
      db.prepare("INSERT INTO modem_meta (server_name, imei, operator) VALUES ('KM_T', 'KM_IMEI_1', 'Moldcell')").run();
      db.prepare("INSERT INTO modem_meta (server_name, imei, operator, deleted) VALUES ('KM_T', 'KM_IMEI_2', 'Orange', 1)").run();

      const res = await request(app).get('/api/admin/known_modems').set('X-Auth-Token', asAdmin());
      expect(res.status).toBe(200);
      const mine = (res.body.items || []).filter(m => m.server === 'KM_T');
      expect(mine.length).toBe(1);                       // soft-deleted KM_02 скрыт
      expect(mine[0]).toMatchObject({ server: 'KM_T', nick: 'KM_01', operator: 'Moldcell' });
      expect(typeof mine[0].address).toBe('string');
    } finally {
      setKnownModems(backup);
      db.prepare("DELETE FROM modem_meta WHERE server_name = 'KM_T'").run();
    }
  });
});
