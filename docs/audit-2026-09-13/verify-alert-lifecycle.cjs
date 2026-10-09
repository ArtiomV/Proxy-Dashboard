'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const Database = require('better-sqlite3');
const https = require('node:https');
const originalRequest = https.request;
let unexpectedNetwork = 0;
https.request = () => { unexpectedNetwork++; throw new Error('Network forbidden in acceptance probe'); };
const db = new Database(':memory:');
const checks = [];
async function check(name, f) {
  try { await f(); checks.push({ name, passed: true }); }
  catch (e) { checks.push({ name, passed: false, error: e.message }); }
}
async function main() {
  db.exec(fs.readFileSync(require.resolve('../../migrations/032_notifications.sql'), 'utf8'));
  db.exec('CREATE TABLE server_downtime(id INTEGER PRIMARY KEY)');
  db.exec(fs.readFileSync(require.resolve('../../migrations/076_monitoring_v2_stage4.sql'), 'utf8'));
  const migration = fs.readdirSync(__dirname + '/../../migrations').find(x => x.startsWith('103_'));
  assert.ok(migration);
  db.exec(fs.readFileSync(__dirname + '/../../migrations/' + migration, 'utf8'));
  let now = Date.now();
  class Clock extends Date { static now() { return now; } }
  const filename = require.resolve('../../src/telegram/alerts');
  const box = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module: box, exports: box.exports,
    require: createRequire(filename), Date: Clock, setTimeout() { return { unref() {} }; }, clearTimeout() {} }, { filename });
  const alerts = box.exports, bot = require('../../src/telegram/bot');
  let reject = true, attempts = 0;
  const warnings = [], sent = [], edits = [];
  const settings = { telegram_chat_id: 'test', telegram_bot_token: 'test', alert_incident_correlation_enabled: false, telegram_night_digest_enabled: false };
  bot.init({ getSetting: (k, d) => k in settings ? settings[k] : d,
    logger: { warn(x) { warnings.push(x); } }, onAlertAck: alerts.onAlertAck,
    sendMessageImpl: async () => ({ ok: true }),
    tgRequestImpl: async (token, method, params) => {
    if (method === 'sendMessage') { attempts++; sent.push({ id: attempts, params }); return reject ? { ok: false, error_code: 400, description: 'injected' } : { ok: true, result: { message_id: attempts } }; }
    if (method === 'editMessageReplyMarkup') edits.push(params);
    return { ok: true };
  } });
  // alerts calls exported tgRequest directly for markup edits; that bypasses bot's internal DI.
  const alertTransport = { sendMessage: bot.sendMessage, tgRequest: async (token, method, params) => {
    if (method === 'editMessageReplyMarkup') edits.push(params);
    return { ok: true };
  } };
  alerts.init({ db, tgBot: alertTransport, appSettings: settings, getSetting: (k, d) => k in settings ? settings[k] : d,
    kvGet: { get() {} }, kvSetCritical() {}, logger: { warn(x) { warnings.push(x); } } });
  now += 600000;
  await check('DEEP-73: explicit 400 is logged and next trigger retries', async () => {
    assert.equal(alerts.trigger('server_unreachable', { server: 'reject' }), true);
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(warnings.some(x => x.includes('tg send rejected')));
    assert.equal(alerts.trigger('server_unreachable', { server: 'reject' }), true);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(attempts, 2);
  });
  reject = false;
  const payload = { server: 'episode' }, hash = alerts._ackHash('server_unreachable', 'srv_episode');
  assert.equal(alerts.trigger('server_unreachable', payload), true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await alerts.onAlertAck('solved', hash, 'admin')).ok, true);
  alerts.clearCooldown('server_unreachable', payload);
  now += 7200000;
  await check('DEEP-74: recovery closes prior solved and new outage is accepted', () => {
    assert.ok(db.prepare("SELECT closed_at FROM alert_acks WHERE dedup_key='srv_episode'").get().closed_at);
    assert.equal(alerts.trigger('server_unreachable', payload), true);
  });
  await new Promise(resolve => setImmediate(resolve));
  await check('DEEP-74: solve on new episode creates a new active acknowledgement', async () => {
    const ack = await alerts.onAlertAck('solved', hash, 'admin');
    assert.equal(ack.ok, true);
    assert.equal(db.prepare("SELECT count(*) n FROM alert_acks WHERE dedup_key='srv_episode' AND closed_at IS NULL").get().n, 1);
  });
  // Independent server: old message was never acknowledged, so no solved row masks stale-button effects.
  const stalePayload = { server: 'stale-button' };
  assert.equal(alerts.trigger('server_unreachable', stalePayload), true);
  await new Promise(resolve => setImmediate(resolve));
  const oldMessage = sent.at(-1);
  alerts.clearCooldown('server_unreachable', stalePayload);
  now += 7200000;
  assert.equal(alerts.trigger('server_unreachable', stalePayload), true);
  await new Promise(resolve => setImmediate(resolve));
  const newMessage = sent.at(-1);
  await bot.handleUpdate('test', { callback_query: { id: 'test-callback',
    data: oldMessage.params.reply_markup.inline_keyboard[0][1].callback_data,
    from: { id: 1, username: 'admin' }, message: { message_id: oldMessage.id, chat: { id: 'test' } } } });
  await check('DEEP-74: old message button must not acknowledge a newer episode', () => {
    assert.equal(db.prepare("SELECT count(*) n FROM alert_acks WHERE dedup_key='srv_stale-button' AND closed_at IS NULL").get().n, 0);
  });
  await check('DEEP-74: old button must not remove buttons from a newer message', () => {
    assert.equal(edits.some(x => x.message_id === newMessage.id), false);
  });
  await check('Isolation: no unmocked HTTPS requests', () => assert.equal(unexpectedNetwork, 0));
  const report = { generatedAt: new Date().toISOString(), meaning: 'Acceptance: PASS means correct behavior',
    isolation: 'real alerts and bot.sendMessage, injected API, SQLite migrations 032/076/103, controlled clock/timers; no network',
    total: checks.length, passed: checks.filter(c => c.passed).length, checks };
  fs.writeFileSync(__dirname + '/alert-lifecycle-verification.json', JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
  if (checks.some(c => !c.passed)) process.exitCode = 1;
}
main().catch(e => { console.error(e); process.exitCode = 1; }).finally(() => { https.request = originalRequest; db.close(); });
