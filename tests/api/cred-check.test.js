// cred-check: live-проверка кредов при сохранении настроек (15.08).
// Фатальный вердикт (невалидный JWT Точки) → PUT /api/admin/settings = 400,
// настройки НЕ пишутся. В test-env сетевые чекеры (SMTP/TG/Anthropic)
// скипаются — проверяем офлайн-ветку Точки + агрегацию.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { bootApp, asAdmin } from '../_helpers/app.js';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const credCheck = require('../../src/services/cred-check.js');

function makeJwt(payload) {
  const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return b64u({ alg: 'RS256', typ: 'JWT' }) + '.' + b64u(payload) + '.fakesig';
}

let app, db, adminToken;

beforeAll(() => {
  const ctx = bootApp();
  app = ctx.app;
  db = ctx.db;
  adminToken = asAdmin();
});

afterAll(() => {
  try {
    const row = db.prepare("SELECT value FROM kv_store WHERE key = 'app_settings'").get();
    if (row) {
      const s = JSON.parse(row.value);
      delete s.tochka_acq_jwt;
      db.prepare("UPDATE kv_store SET value = ? WHERE key = 'app_settings'").run(JSON.stringify(s));
    }
  } catch (_) { /* best-effort */ }
});

describe('cred-check: unit (офлайн-чекер JWT Точки)', () => {
  it('не JWT → fatal', () => {
    const r = credCheck.checkTochkaJwt('not-a-jwt');
    expect(r.ok).toBe(false);
    expect(r.fatal).toBe(true);
  });

  it('истёкший JWT → fatal с датой', () => {
    const r = credCheck.checkTochkaJwt(makeJwt({ exp: Math.floor(Date.now() / 1000) - 3600 }));
    expect(r.ok).toBe(false);
    expect(r.fatal).toBe(true);
    expect(r.error).toContain('истёк');
  });

  it('живой JWT → ok', () => {
    const r = credCheck.checkTochkaJwt(makeJwt({ exp: Math.floor(Date.now() / 1000) + 86400 }));
    expect(r.ok).toBe(true);
  });

  it('очистка обоих SMTP-полей — легальна, проверки нет', async () => {
    const v = await credCheck.validateSettingsPatch(
      { sendpulse_smtp_user: '', sendpulse_smtp_pass: '' },
      { getSetting: () => '' }
    );
    expect(v.errors).toEqual([]);
    expect(v.warnings).toEqual([]);
  });

  it('fatal из patch агрегируется в errors', async () => {
    const v = await credCheck.validateSettingsPatch(
      { tochka_acq_jwt: 'garbage' },
      { getSetting: () => '' }
    );
    expect(v.errors.length).toBe(1);
  });
});

describe('cred-check: PUT /api/admin/settings', () => {
  it('невалидный JWT Точки → 400, настройка не сохраняется', async () => {
    const put = await request(app).put('/api/admin/settings')
      .set('X-Auth-Token', adminToken).send({ tochka_acq_jwt: 'broken-jwt' });
    expect(put.status).toBe(400);
    expect(put.body.error).toContain('Проверка доступов');

    const get = await request(app).get('/api/admin/settings').set('X-Auth-Token', adminToken);
    expect(get.body.tochka_acq_jwt || '').toBe('');
  });

  it('валидный JWT → 200 + cred_checks в ответе', async () => {
    const jwt = makeJwt({ exp: Math.floor(Date.now() / 1000) + 86400 });
    const put = await request(app).put('/api/admin/settings')
      .set('X-Auth-Token', adminToken).send({ tochka_acq_jwt: jwt });
    expect(put.status).toBe(200);
    expect(put.body.ok).toBe(true);
    expect(put.body.cred_checks.join(' ')).toContain('Точка');

    // GET маскирует — как и раньше.
    const get = await request(app).get('/api/admin/settings').set('X-Auth-Token', adminToken);
    expect(get.body.tochka_acq_jwt).toBe('••••••••');
  });
});
