// 2026-09-24 · DEEP-60: async-rejection Express 4 доходит до error
// middleware и завершает HTTP-ответом, а не висит до таймаута.
// Layer-патч из server.js применён к прототипу при загрузке bootApp —
// проверяем на свежем express-приложении в этом же процессе.

import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createRequire } from 'module';
import { bootApp } from './_helpers/app.js';

const require = createRequire(import.meta.url);

function appWithErrorMw() {
  bootApp();   // применяет Layer-патч к express (один раз, глобально)
  const app = express();
  app.get('/boom-async', async () => {
    await new Promise(r => setImmediate(r));
    throw new Error('async boom');
  });
  app.get('/boom-sync-in-async', async (req, res) => {
    JSON.parse('{broken');   // sync throw внутри async — тоже через next
    res.json({ ok: true });
  });
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    res.status(500).json({ error: 'handled', details: err.message });
  });
  return app;
}

describe('DEEP-60: async errors доходят до error middleware', () => {
  it('rejection после await → 500 handled (не зависание, не unhandledRejection)', async () => {
    let unhandled = null;
    const onRej = (e) => { unhandled = e; };
    process.on('unhandledRejection', onRej);
    try {
      const res = await request(appWithErrorMw()).get('/boom-async');
      expect(res.status).toBe(500);
      expect(res.body.error).toBe('handled');
      expect(res.body.details).toContain('async boom');
      await new Promise(r => setImmediate(r));
      expect(unhandled).toBeNull();
    } finally {
      process.removeListener('unhandledRejection', onRej);
    }
  });

  it('sync throw внутри async handler → 500 handled', async () => {
    const res = await request(appWithErrorMw()).get('/boom-sync-in-async');
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('handled');
  });
});
