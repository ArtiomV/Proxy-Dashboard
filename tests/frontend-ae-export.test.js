// tests/frontend-ae-export.test.js — логика окна экспорта прокси в админке.
// Чистая часть (aeBuildExport из public/js/admin/delegated-helpers.js):
// группировка портов по клиентам (portName), фильтрация выгрузки по выбранному
// клиенту и протоколу. Переключатель нужен, когда один модем несёт порты
// разных клиентов — раньше выгружались все скопом.

import { test, expect, describe } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { aeBuildExport } = require('../public/js/admin/delegated-helpers.js');

const PROXIES = [
  { host: '1.1.1.1', http: 10001, socks: 11001, login: 'u1', pass: 'p1', portName: 'WildBox' },
  { host: '1.1.1.1', http: 10002, socks: 11002, login: 'u2', pass: 'p2', portName: 'WildBox' },
  { host: '1.1.1.1', http: 10003, socks: 11003, login: 'u3', pass: 'p3', portName: 'Brandanalytics' },
  { host: '1.1.1.1', http: 10004, socks: '', login: 'u4', pass: 'p4', portName: '' },
];

describe('aeBuildExport — группировка и фильтры окна экспорта', () => {
  test('группирует по клиентам со счётчиками, сортировка по убыванию', () => {
    const r = aeBuildExport(PROXIES, {});
    expect(r.clients).toEqual([
      { name: 'WildBox', count: 2 },
      { name: 'Brandanalytics', count: 1 },
      { name: '', count: 1 },
    ]);
  });

  test('по умолчанию — все клиенты, http-порты, формат login:pass@host:port', () => {
    const r = aeBuildExport(PROXIES, {});
    expect(r.selected).toBe('*');
    expect(r.proto).toBe('http');
    expect(r.lines).toEqual([
      'u1:p1@1.1.1.1:10001',
      'u2:p2@1.1.1.1:10002',
      'u3:p3@1.1.1.1:10003',
      'u4:p4@1.1.1.1:10004',
    ]);
  });

  test('фильтр по клиенту отдаёт только его прокси', () => {
    const r = aeBuildExport(PROXIES, { client: 'WildBox' });
    expect(r.selected).toBe('WildBox');
    expect(r.lines).toEqual(['u1:p1@1.1.1.1:10001', 'u2:p2@1.1.1.1:10002']);
    const b = aeBuildExport(PROXIES, { client: 'Brandanalytics' });
    expect(b.lines).toEqual(['u3:p3@1.1.1.1:10003']);
  });

  test('порт без portName попадает в группу «без клиента» (пустое имя)', () => {
    const r = aeBuildExport(PROXIES, { client: '' });
    expect(r.selected).toBe('');
    expect(r.lines).toEqual(['u4:p4@1.1.1.1:10004']);
  });

  test('socks5: берёт socks-порт и пропускает порты без socks-пары', () => {
    const r = aeBuildExport(PROXIES, { proto: 'socks5' });
    expect(r.proto).toBe('socks5');
    expect(r.lines).toEqual([
      'u1:p1@1.1.1.1:11001',
      'u2:p2@1.1.1.1:11002',
      'u3:p3@1.1.1.1:11003',
      // u4 — без socks, пропущен
    ]);
  });

  test('выбранный клиент исчез из выгрузки — откат на «все»', () => {
    const r = aeBuildExport([PROXIES[0]], { client: 'Brandanalytics' });
    expect(r.selected).toBe('*');
    expect(r.lines).toEqual(['u1:p1@1.1.1.1:10001']);
  });

  test('один клиент — переключатель не нужен (clients.length === 1)', () => {
    const r = aeBuildExport([PROXIES[0], PROXIES[1]], {});
    expect(r.clients).toEqual([{ name: 'WildBox', count: 2 }]);
  });
});
