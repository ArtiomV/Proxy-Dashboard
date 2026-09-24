// 2026-09-24 · DEEP-70: фильтр уведомлений — в SQL ДО LIMIT (старое
// критическое не отсекается свежими info), курсорная пагинация стабильна.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const createNotifRouter = require('../src/routes/notifications.js');

let db, app;

beforeAll(() => {
  db = new Database(':memory:');
  db.exec(fs.readFileSync(path.join(__dirname, '..', 'migrations', '032_notifications.sql'), 'utf8'));
  // 1 старое CRITICAL + 200 более новых info (раньше LIMIT 200 отсекал его).
  const ins = db.prepare(`INSERT INTO notifications (dedup_key, rule_id, title, priority, entity_kind, entity_id, message, payload_json, created_at)
    VALUES (?, ?, ?, ?, 'system', '', '', '{}', ?)`);
  ins.run('k_crit', 'server_unreachable', 'старый крит', 'critical', '2026-09-01 00:00:00');
  for (let i = 0; i < 200; i++) {
    ins.run('k_i' + i, 'heap_warn', 'info ' + i, 'info', '2026-09-23 12:00:0' + (i % 10));
  }
  // Две строки с ОДИНАКОВОЙ секундой — стабильность курсора.
  ins.run('k_same_a', 'heap_warn', 'same-second-a', 'info', '2026-09-23 12:00:09');
  ins.run('k_same_b', 'heap_warn', 'same-second-b', 'info', '2026-09-23 12:00:09');

  app = express();
  app.use(express.json());
  app.use(createNotifRouter({
    logger: { info() {}, warn() {}, error() {} },
    db,
    authMiddleware: (req, res, next) => { req.user = { login: 'admin' }; next(); },
    adminMiddleware: (req, res, next) => next(),
  }));
});
afterAll(() => db.close());

describe('DEEP-70: фильтр до LIMIT + курсор', () => {
  it('200 свежих info не прячут старое critical во вкладке critical', async () => {
    const res = await request(app).get('/api/admin/notifications?filter=critical&limit=200');
    expect(res.status).toBe(200);
    expect(res.body.notifications.length).toBe(1);
    expect(res.body.notifications[0].title).toBe('старый крит');
  });

  it('вкладка unread: старое событие — на второй странице курсора (первая страница честно ограничена)', async () => {
    const p1 = await request(app).get('/api/admin/notifications?filter=unread&limit=200');
    expect(p1.body.notifications.some(n => n.title === 'старый крит')).toBe(false);
    expect(p1.body.next_cursor).toBeTruthy();
    const c = p1.body.next_cursor;
    const p2 = await request(app).get(`/api/admin/notifications?filter=unread&limit=200&cursor_created=${encodeURIComponent(c.cursor_created)}&cursor_id=${c.cursor_id}`);
    expect(p2.body.notifications.some(n => n.title === 'старый крит')).toBe(true);
  });

  it('курсор не теряет и не дублирует строки (включая одинаковые секунды)', async () => {
    const seen = new Set();
    let cursor = null, pages = 0;
    for (;;) {
      let url = '/api/admin/notifications?filter=all&limit=50';
      if (cursor) url += `&cursor_created=${encodeURIComponent(cursor.cursor_created)}&cursor_id=${cursor.cursor_id}`;
      const res = await request(app).get(url);
      expect(res.status).toBe(200);
      for (const n of res.body.notifications) {
        expect(seen.has(n.id)).toBe(false);   // без дублей
        seen.add(n.id);
      }
      cursor = res.body.next_cursor;
      pages++;
      if (!cursor || pages > 20) break;
    }
    const total = db.prepare('SELECT COUNT(*) c FROM notifications').get().c;
    expect(seen.size).toBe(total);   // все строки — ровно один раз
  });

  it('неизвестный filter → 400', async () => {
    const res = await request(app).get('/api/admin/notifications?filter=bogus');
    expect(res.status).toBe(400);
  });
});
