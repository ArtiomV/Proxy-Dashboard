// 2026-07-26: «89/91, а отключён 1» — retention-cleanup сносил in-memory
// uptimeTracking уже при ПЕРВОМ выпадении модема из фида (комментарий обещал
// «>30 дней», порога в коде не было). Без last_online_check computeFleet
// считал модем «никогда не виденным»: не offline, не disconnected, но в total
// — шапка и карточка не сходились (RO2_34). Тест: свежее отсутствие НЕ чистится,
// чистится только >30 дней или бесхозный мусор.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { bootApp } from './_helpers/app.js';

const require = createRequire(import.meta.url);
const cleanupJob = require('../src/jobs/cleanup.js');

let cacheFile;
beforeAll(() => {
  cacheFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pdcache-')), 'server_cache.json');
  // В фиде живёт только LIVE1 — всё остальное «выпало из фида»
  fs.writeFileSync(cacheFile, JSON.stringify({ S2: { status: [{ modem_details: { IMEI: 'LIVE1' } }] } }));
});
afterAll(() => { try { fs.rmSync(path.dirname(cacheFile), { recursive: true, force: true }); } catch (_) {} });

function run(maps) {
  const { db } = bootApp();
  const job = cleanupJob.create({
    db, logger: { info() {}, warn() {}, error() {}, debug() {} }, fs,
    SERVER_CACHE_FILE: cacheFile,
    appSettings: {},
    dailyTraffic: {},
    ipTracking: maps.ip,
    uptimeTracking: maps.up,
    modemRotationCache: maps.rot,
    knownModems: {},
    saveKnownModems: () => {},
    logActivity: () => {},
  });
  return job.runRetentionCleanup();
}

const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();

describe('retention cleanup — порог 30д для tracking-мап', () => {
  it('модем выпал из фида НЕДАВНО → uptime/ip записи СОХРАНЯЮТСЯ (регрессия RO2_34)', () => {
    const up = {
      'S2_LIVE1': { last_check: iso(60e3), last_online_check: iso(60e3) },
      'S2_GONE_1D': { last_check: iso(1 * 86400e3), last_online_check: iso(25 * 3600e3) }, // RO2_34-кейс
    };
    const ip = { 'S2_GONE_2D': { ip: '1.2.3.4', since: iso(2 * 86400e3) } };
    const rot = { 'S2:GONE_1D': 10 };
    const res = run({ ip, up, rot });
    expect(up['S2_GONE_1D']).toBeTruthy();            // НЕ удалён
    expect(ip['S2_GONE_2D']).toBeTruthy();
    expect(rot['S2:GONE_1D']).toBeUndefined();        // rotation-кэш — как раньше
    expect(res.tracking_pruned.uptimeTracking).toBe(0);
    expect(res.tracking_pruned.ipTracking).toBe(0);
  });

  it('отсутствует >30 дней → чистится; бесхозные записи без времени → тоже', () => {
    const up = {
      'S2_GONE_31D': { last_check: iso(31 * 86400e3), last_online_check: iso(31 * 86400e3) },
      'S2_NO_TIME': {},
      'S2_ONLY_ONLINE_40D': { last_online_check: iso(40 * 86400e3) },   // фолбэк на last_online_check
    };
    const ip = { 'S2_GONE_40D': { ip: '1.2.3.4', since: iso(40 * 86400e3) } };
    const res = run({ ip, up, rot: {} });
    expect(up['S2_GONE_31D']).toBeUndefined();
    expect(up['S2_NO_TIME']).toBeUndefined();
    expect(up['S2_ONLY_ONLINE_40D']).toBeUndefined();
    expect(ip['S2_GONE_40D']).toBeUndefined();
    expect(res.tracking_pruned.uptimeTracking).toBe(3);
    expect(res.tracking_pruned.ipTracking).toBe(1);
  });
});
