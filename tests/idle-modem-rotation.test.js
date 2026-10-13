// 2026-10-13: у модема без клиента авторотация выключается автоматически
// (свободные MD_17–19 на S4 ротировались вхолостую, бокс пытался их
// перезагрузить и блокировал панель до 161 с). Прежний интервал возвращается,
// когда на модем снова посажен клиент.

import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const idle = require('../src/jobs/idle-modem-rotation.js');

function setup({ roster, rotation = {}, formRot = {}, setting = true, failPost = false }) {
  const kv = {};
  const forms = { ...formRot };              // 'srv:imei' → минуты в «форме бокса»
  const posts = [];
  const proxyConf = {
    getConfForm: vi.fn(async (server, path) => {
      const imei = path.split('/').pop();
      const v = forms[server.name + ':' + imei];
      return { ok: true, html: `<input name="AUTO_IP_ROTATION" value="${v || ''}">`, fields: { X: '1' } };
    }),
    postConfForm: vi.fn(async (server, path, merged) => {
      if (failPost) return { ok: false, reason: 'HTTP_500' };
      posts.push({ srv: server.name, imei: merged.IMEI, mins: merged.AUTO_IP_ROTATION });
      forms[server.name + ':' + merged.IMEI] = parseInt(merged.AUTO_IP_ROTATION, 10) || 0;
      return { ok: true };
    }),
    parseRotation: (html) => { const m = html.match(/value="(\d*)"/); return m[1] === '' ? 0 : parseInt(m[1], 10); },
    verifyRotation: vi.fn(async (server, path, want) => {
      const imei = path.split('/').pop();
      return { ok: forms[server.name + ':' + imei] === want };
    }),
  };
  const status = [
    { modem_details: { IMEI: '111', NICK: 'MD_1' } },    // с клиентом
    { modem_details: { IMEI: '222', NICK: 'MD_17' } },   // свободный
    { modem_details: { IMEI: '333', NICK: 'MD_18' } },   // свободный, ротация уже выключена
  ];
  const logs = [];
  const job = idle.create({
    logger: { info() {}, warn() {}, error() {} },
    logActivity: (...a) => logs.push(a),
    fetchAllServersDataCached: async () => [{ serverName: 'S4', status }],
    findServer: (n) => ({ name: n }),
    proxyConf,
    kvGet: (k) => (kv[k] !== undefined ? { value: kv[k] } : null),
    kvSet: (k, v) => { kv[k] = v; },
    getSetting: () => setting,
    knownModems: roster,
    modemRotationCache: { 'S4:111': 10, 'S4:222': 10, 'S4:333': 0, ...rotation },
    invalidateCache: () => {},
    db: { prepare: () => ({ get: () => null }) },
  });
  return { job, posts, forms, kv, logs, proxyConf };
}

const ROSTER = { S4: { p1: { portName: 'client', nick: 'MD_1', imei: '111' } } };

describe('idle-modem-rotation', () => {
  it('выключает ротацию у модема без клиента только со второго прогона подряд', async () => {
    const t = setup({ roster: ROSTER, formRot: { 'S4:222': 10, 'S4:111': 10 } });
    let r = await t.job.runOnce();
    expect(r.changed).toBe(0);                          // первый раз — подтверждение
    r = await t.job.runOnce();
    expect(r.changed).toBe(1);
    expect(t.posts).toEqual([{ srv: 'S4', imei: '222', mins: '0' }]);   // клиентский MD_1 и уже выключенный MD_18 не тронуты
    expect(JSON.parse(t.kv.idle_rotation_prev)).toEqual({ 'S4:222': 10 });
  });

  it('возвращает прежний интервал, когда на модем посадили клиента', async () => {
    const t = setup({ roster: ROSTER, formRot: { 'S4:222': 10 } });
    await t.job.runOnce(); await t.job.runOnce();
    expect(t.forms['S4:222']).toBe(0);
    ROSTER.S4.p2 = { portName: 'newclient', nick: 'MD_17', imei: '222' };
    try {
      const r = await t.job.runOnce();
      expect(r.restored).toBe(1);
      expect(t.forms['S4:222']).toBe(10);
      expect(JSON.parse(t.kv.idle_rotation_prev)).toEqual({});
    } finally { delete ROSTER.S4.p2; }
  });

  it('если ротацию включили вручную — при возврате клиента не перезаписываем', async () => {
    const t = setup({ roster: ROSTER, formRot: { 'S4:222': 10 } });
    await t.job.runOnce(); await t.job.runOnce();
    t.forms['S4:222'] = 30;                              // владелец включил сам
    ROSTER.S4.p2 = { portName: 'newclient', nick: 'MD_17', imei: '222' };
    try {
      const r = await t.job.runOnce();
      expect(r.restored).toBe(0);
      expect(t.forms['S4:222']).toBe(30);
    } finally { delete ROSTER.S4.p2; }
  });

  it('пустой ростер, выключенная настройка и ошибка записи — безопасный пропуск', async () => {
    let t = setup({ roster: {} });
    expect((await t.job.runOnce()).reason).toBe('empty_roster');
    t = setup({ roster: ROSTER, setting: false });
    expect((await t.job.runOnce()).reason).toBe('disabled');
    t = setup({ roster: ROSTER, formRot: { 'S4:222': 10 }, failPost: true });
    await t.job.runOnce();
    const r = await t.job.runOnce();
    expect(r.failed).toBe(1);
    expect(JSON.parse(t.kv.idle_rotation_prev)).toEqual({});
  });
});
