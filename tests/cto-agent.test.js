// 2026-10-13: ИИ-технический директор (src/cto). Видит и предлагает всё,
// исполняет только белый список и только после «ок». Расписание — в
// коридоре 6–12 ч, решение за моделью, но коридор держит код.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const boundaries = require('../src/cto/boundaries.js');
const agentMod = require('../src/cto/agent.js');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const ROSTER = { S4: { p1: { portName: 'client', nick: 'MD_1', imei: '111' } } };

describe('cto/boundaries', () => {
  it('ротация — только у модема БЕЗ клиента', () => {
    expect(boundaries.validateAction('set_modem_rotation', { server: 'S4', nick: 'MD_17', minutes: 0 }, { knownModems: ROSTER }).ok).toBe(true);
    const r = boundaries.validateAction('set_modem_rotation', { server: 'S4', nick: 'MD_1', minutes: 0 }, { knownModems: ROSTER });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/клиент/);
    expect(boundaries.validateAction('set_modem_rotation', { server: 'S4', nick: 'MD_17', minutes: 0 }, { knownModems: {} }).ok).toBe(false);
  });
  it('настройки — белый список и диапазоны; биллинг и секреты запрещены', () => {
    const v = (key, value) => boundaries.validateAction('set_setting', { key, value }, {});
    expect(v('ping_loss_warn_pct', 40).ok).toBe(true);
    expect(v('ping_loss_warn_pct', 4).ok).toBe(false);
    expect(v('httpcheck_alert_threshold', 'x').ok).toBe(false);
    expect(v('rotation_fail_norm', '{"default":25,"exceptions":{"Vodafone RO":80}}').ok).toBe(true);
    expect(v('rotation_fail_norm', '{"default":250}').ok).toBe(false);
    for (const k of ['price_per_gb', 'telegram_bot_token', 'anthropic_api_key', 'smtp_pass', 'billing_enabled', 'unknown_key']) expect(v(k, 1).ok).toBe(false);
  });
  it('неизвестное действие вне реестра', () => {
    expect(boundaries.validateAction('delete_client', {}, {}).ok).toBe(false);
    expect(boundaries.validateAction('advice', {}, {}).ok).toBe(true);
  });
});

function setup({ review, roster = ROSTER, applyResult = { ok: true, before: { x: 1 }, after: { x: 2 } } } = {}) {
  const db = new Database(':memory:');
  db.exec(fs.readFileSync(path.join(root, 'migrations/112_cto_agent.sql'), 'utf8'));
  const kv = {};
  const sent = [], edits = [], bell = [];
  const executor = { apply: vi.fn(async () => applyResult), rollback: vi.fn(async () => ({ ok: true })), check: vi.fn(async () => ({ ok: true })) };
  const settings = { telegram_bot_token: 't', telegram_chat_id: '1' };
  const a = agentMod.create({
    db, logger: { info() {}, warn() {}, error() {} },
    getSetting: (k, d) => (k in settings ? settings[k] : d),
    kvGet: (k) => (kv[k] !== undefined ? { value: kv[k] } : null), kvSet: (k, v) => { kv[k] = v; },
    observe: { snapshot: async () => ({ generated_at: 'now' }) },
    executor,
    tgBot: {
      sendMessage: async (t, c, text, opts) => { sent.push({ text, opts }); return { ok: true, result: { message_id: 100 + sent.length } }; },
      tgRequest: async (t, m, p) => { edits.push({ m, p }); return { ok: true }; },
    },
    recordBellEvent: (o) => { bell.push(o); return 1; },
    logActivity: () => {}, auditLog: () => {}, knownModems: roster,
    callModel: vi.fn(async () => ({ input: review, usage: { input_tokens: 10, output_tokens: 5 } })),
  });
  return { a, db, kv, sent, edits, bell, executor };
}

const REVIEW = (over = {}) => ({
  summary: 'Всё работает, есть одна проблема.',
  proposals: [{
    title: 'Выключить ротацию у MD_17', category: 'rotations', severity: 'warn',
    summary: 'Ротации вхолостую.', evidence: [{ fact: '137/137 неуспешных', kind: 'data' }, { fact: 'SIM без сети', kind: 'assumption' }],
    expected: 'Прогон 88 с → 3 с', action: { type: 'set_modem_rotation', params: { server: 'S4', nick: 'MD_17', minutes: 0 } },
  }],
  next_run_in_hours: 8, next_run_reason: 'нужна проверка эффекта', ...over,
});

describe('cto/agent', () => {
  it('осмотр: предложение сохранено, ушло в Telegram с кнопками и в колокольчик', async () => {
    const t = setup({ review: REVIEW() });
    const r = await t.a.runCycle('manual');
    expect(r.created).toBe(1);
    const row = t.db.prepare('SELECT * FROM cto_proposals').get();
    expect(row.status).toBe('pending');
    expect(row.action_type).toBe('set_modem_rotation');
    expect(t.sent[0].opts.reply_markup.inline_keyboard[0].map(b => b.callback_data)).toEqual([`c:ok:${row.id}`, `c:no:${row.id}`, `c:later:${row.id}`]);
    expect(t.sent[0].text).toContain('гипотеза');
    expect(t.bell[0]).toMatchObject({ rule_id: 'cto_proposal', payload: { proposal_id: row.id, executable: true } });
  });

  it('коридор расписания: 1 ч → 6 ч, 30 ч → 12 ч', async () => {
    let t = setup({ review: REVIEW({ next_run_in_hours: 1 }) });
    await t.a.runCycle('manual');
    expect(t.db.prepare('SELECT next_run_in_h FROM cto_runs').get().next_run_in_h).toBe(6);
    t = setup({ review: REVIEW({ next_run_in_hours: 30 }) });
    await t.a.runCycle('manual');
    expect(t.db.prepare('SELECT next_run_in_h FROM cto_runs').get().next_run_in_h).toBe(12);
    expect(Number(t.kv.cto_next_run_at)).toBeGreaterThan(Date.now() + 11.9 * 3600000);
  });

  it('действие вне границ (модем с клиентом) превращается в совет', async () => {
    const rv = REVIEW();
    rv.proposals[0].action.params.nick = 'MD_1';
    const t = setup({ review: rv });
    await t.a.runCycle('manual');
    const row = t.db.prepare('SELECT * FROM cto_proposals').get();
    expect(row.action_type).toBe('advice');
    expect(row.action_json).toMatch(/вне границ/);
    await t.a.decide(row.id, 'approve', '@u');
    expect(t.executor.apply).not.toHaveBeenCalled();
    expect(t.db.prepare('SELECT status FROM cto_proposals').get().status).toBe('acknowledged');
  });

  it('одобрение: применяется, состояние «до» и срок проверки сохранены; повторное решение — отказ', async () => {
    const t = setup({ review: REVIEW() });
    await t.a.runCycle('manual');
    const id = t.db.prepare('SELECT id FROM cto_proposals').get().id;
    const r = await t.a.decide(id, 'approve', '@owner');
    expect(r).toMatchObject({ ok: true, status: 'applied' });
    expect(t.executor.apply).toHaveBeenCalledWith({ type: 'set_modem_rotation', params: { server: 'S4', nick: 'MD_17', minutes: 0 } });
    const row = t.db.prepare('SELECT * FROM cto_proposals').get();
    expect(JSON.parse(row.before_json)).toEqual({ x: 1 });
    expect(row.verify_after).toBeTruthy();
    expect((await t.a.decide(id, 'approve', '@owner')).error).toBe('already_decided');
    expect(t.edits.some(e => e.m === 'editMessageText')).toBe(true);
  });

  it('ошибка исполнения → failed, ничего не «применено»', async () => {
    const t = setup({ review: REVIEW(), applyResult: { ok: false, error: 'ProxySmart не применил' } });
    await t.a.runCycle('manual');
    const id = t.db.prepare('SELECT id FROM cto_proposals').get().id;
    const r = await t.a.decide(id, 'approve', '@o');
    expect(r.ok).toBe(false);
    expect(t.db.prepare('SELECT status FROM cto_proposals').get().status).toBe('failed');
  });

  it('отклонённое не повторяется 14 дней; отложенное — пока не истёк срок', async () => {
    const t = setup({ review: REVIEW() });
    await t.a.runCycle('manual');
    const id = t.db.prepare('SELECT id FROM cto_proposals').get().id;
    await t.a.decide(id, 'reject', '@o');
    const r2 = await t.a.runCycle('manual');
    expect(r2.created).toBe(0);
    expect(r2.skipped[0].why).toMatch(/отклонено/);
    expect(t.db.prepare('SELECT COUNT(*) n FROM cto_proposals').get().n).toBe(1);
  });

  it('суточный лимит применений', async () => {
    const t = setup({ review: REVIEW() });
    await t.a.runCycle('manual');
    const id = t.db.prepare('SELECT id FROM cto_proposals').get().id;
    for (let i = 0; i < boundaries.MAX_APPLIES_PER_DAY; i++) {
      t.db.prepare(`INSERT INTO cto_proposals (fingerprint, title, status, applied_at) VALUES ('x${i}','t','applied',datetime('now'))`).run();
    }
    const r = await t.a.decide(id, 'approve', '@o');
    expect(r.error).toBe('daily_limit');
    expect(t.executor.apply).not.toHaveBeenCalled();
  });

  it('тик: проверка эффекта переводит applied → verified; сбой модели не роняет и отодвигает следующий осмотр', async () => {
    const t = setup({ review: REVIEW() });
    await t.a.runCycle('manual');
    const id = t.db.prepare('SELECT id FROM cto_proposals').get().id;
    await t.a.decide(id, 'approve', '@o');
    t.db.prepare(`UPDATE cto_proposals SET verify_after = datetime('now','-1 minute') WHERE id = ?`).run(id);
    t.kv.cto_next_run_at = String(Date.now() + 3600000);
    await t.a.tick();
    expect(t.db.prepare('SELECT status FROM cto_proposals WHERE id = ?').get(id).status).toBe('verified');

    const bad = setup({ review: REVIEW() });
    bad.a = agentMod.create({ ...{}, db: bad.db, logger: { info() {}, warn() {}, error() {} }, getSetting: () => null, kvGet: () => null, kvSet: (k, v) => { bad.kv[k] = v; },
      observe: { snapshot: async () => { throw new Error('boom'); } }, executor: bad.executor, tgBot: {}, recordBellEvent() {}, logActivity() {}, auditLog() {}, knownModems: ROSTER, callModel: async () => ({}) });
    const r = await bad.a.runCycle('manual');
    expect(r.status).toBe('failed');
    expect(Number(bad.kv.cto_next_run_at)).toBeGreaterThan(Date.now());
  });
});
