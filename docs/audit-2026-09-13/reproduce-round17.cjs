'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const Database = require('better-sqlite3');
const db = new Database(':memory:');
async function main() {
  db.exec(fs.readFileSync(require.resolve('../../migrations/032_notifications.sql'), 'utf8'));
  db.exec('CREATE TABLE server_downtime(id INTEGER PRIMARY KEY, server_name TEXT, down_from TEXT, down_to TEXT)');
  db.exec(fs.readFileSync(require.resolve('../../migrations/076_monitoring_v2_stage4.sql'), 'utf8'));
  const filename = require.resolve('../../src/telegram/alerts');
  let now = Date.now();
  class Clock extends Date { static now() { return now; } }
  const moduleBox = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module: moduleBox, exports: moduleBox.exports, require: createRequire(filename), Date: Clock,
    // Only persistence debounce is scheduled: captured, never executed; no live handles.
    setTimeout() { return { unref() {} }; }, clearTimeout() {}
  }, { filename });
  const alerts = moduleBox.exports;
  const bot = require('../../src/telegram/bot');
  let sendAttempts = 0;
  const warnings = [];
  bot.init({ tgRequestImpl: async (token, method) => {
    if (method === 'sendMessage') { sendAttempts++; return { ok: false, error_code: 400, description: 'injected rejection' }; }
    return { ok: true };
  } });
  const settings = { telegram_bot_token: 'inert-test-token', telegram_chat_id: 'inert-test-chat',
    alert_incident_correlation_enabled: false, telegram_night_digest_enabled: false };
  alerts.init({ db, tgBot: bot, appSettings: settings,
    getSetting: (key, def) => key in settings ? settings[key] : def,
    kvGet: { get() {} }, kvSetCritical() {}, logger: { warn(text) { warnings.push(text); } } });
  now += 10 * 60000;
  assert.equal(alerts.trigger('server_unreachable', { server: 'reject-test' }), true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(sendAttempts, 1);
  assert.equal(warnings.some(x => x.includes('tg send')), false);
  assert.equal(alerts.trigger('server_unreachable', { server: 'reject-test' }), false);
  assert.equal(sendAttempts, 1);

  // Obtain a real ack mapping through trigger; button action uses actual SQLite writes.
  assert.equal(alerts.trigger('server_unreachable', { server: 'solved-test' }), true);
  await new Promise(resolve => setImmediate(resolve));
  const ack = await alerts.onAlertAck('solved', alerts._ackHash('server_unreachable', 'srv_solved-test'), 'test-admin');
  assert.equal(ack.ok, true);
  // Same calls used by recovery in modem-tracking, followed by a new outage.
  alerts.clearCooldown('server_unreachable', { server: 'solved-test' });
  assert.equal(alerts.trigger('server_recovered', { server: 'solved-test', downSec: 60 }), true);
  now += 2 * 3600000;
  assert.equal(alerts.trigger('server_unreachable', { server: 'solved-test' }), false);
  const saved = db.prepare("SELECT kind,until_ts FROM alert_acks WHERE dedup_key='srv_solved-test'").get();
  assert.equal(saved.kind, 'solved');
  assert.equal(saved.until_ts, null);
  assert.equal(db.prepare("SELECT count(*) n FROM notifications WHERE rule_id='server_unreachable' AND entity_id='solved-test'").get().n, 1);
  console.log(JSON.stringify({ findings: ['DEEP-73', 'DEEP-74'],
    isolation: 'actual alerts module with controlled clock/timer; actual bot.sendMessage with injected API; SQLite in memory',
    rejectedFirstSendReturnedAccepted: true, rejectionLogged: false, retrySuppressed: true,
    solvedSurvivesRecovery: true, newOutageAfterTwoHoursSuppressed: true,
    limitation: 'recovery public calls replayed; full modem-tracking job and live Telegram not executed' }, null, 2));
}
main().catch(e => { console.error(e); process.exitCode = 1; }).finally(() => db.close());
