// Smoke test for the harness itself. If this fails, no other API test
// can possibly run — fix the harness first.

import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { bootApp, asAdmin } from '../_helpers/app.js';

describe('test harness', () => {
  it('boots server.js without listening and exposes app + db', () => {
    const { app, db } = bootApp();
    expect(app).toBeTruthy();
    expect(typeof app.use).toBe('function');
    expect(db).toBeTruthy();
    expect(typeof db.prepare).toBe('function');
  });

  it('responds to GET /health without auth', async () => {
    const { app } = bootApp();
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
  });

  it('mints an admin session usable on protected routes', async () => {
    const { app } = bootApp();
    const token = asAdmin();
    // /api/admin/system_log requires auth + adminMiddleware.
    const res = await request(app).get('/api/admin/system_log').set('X-Auth-Token', token);
    expect(res.status).toBe(200);
  });
});
