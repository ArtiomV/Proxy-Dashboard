// twenty-leads: строка подключения к БД Twenty берётся только из настройки/env,
// пароля по умолчанию в коде больше нет (ротация 2026-10-12).
import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const leads = require('../src/crm/twenty-leads.js');

describe('twenty-leads без crm_db_url', () => {
  const saved = process.env.CRM_DB_URL;
  afterEach(() => { if (saved === undefined) delete process.env.CRM_DB_URL; else process.env.CRM_DB_URL = saved; });

  it('pushLead падает понятной ошибкой, а не подключается с зашитым паролем', async () => {
    delete process.env.CRM_DB_URL;
    await expect(leads.pushLead(() => '', { contact: '@x', contact_type: 'telegram' }))
      .rejects.toThrow(/crm_db_url не задан/);
  });

  it('ping возвращает ok:false с той же причиной', async () => {
    delete process.env.CRM_DB_URL;
    const r = await leads.ping(() => '');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/crm_db_url не задан/);
  });

  it('в исходнике нет зашитой строки подключения с паролем', () => {
    const src = require('fs').readFileSync(require.resolve('../src/crm/twenty-leads.js'), 'utf8');
    expect(src).not.toMatch(/postgresql:\/\/\w+:[^<\s'"]+@/);
  });
});
