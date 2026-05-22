// Locks the response security headers — once CSP is on, the policy must
// stay configured. If anyone reverts helmet to {contentSecurityPolicy:
// false} this test fails immediately.

import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { bootApp } from '../_helpers/app.js';

describe('security headers', () => {
  it('sends a Content-Security-Policy on every response', async () => {
    const { app } = bootApp();
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    const csp = res.headers['content-security-policy'];
    expect(csp).toBeTruthy();
    // Stage 5 contract: extracted JS lives in 'self', no 'unsafe-inline'
    // on script-src itself. (script-src-attr does allow unsafe-inline for
    // generated onclick attrs — that's documented in FOLLOWUP.)
    expect(csp).toMatch(/script-src [^;]*'self'/);
    expect(csp).not.toMatch(/script-src [^;]*'unsafe-inline'/);
    // Sanity: blocks iframe embedding (anti-clickjacking)
    expect(csp).toMatch(/frame-ancestors 'none'/);
  });

  it('keeps standard helmet protections on', async () => {
    const { app } = bootApp();
    const res = await request(app).get('/health');
    // X-Content-Type-Options is part of helmet defaults
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });
});
