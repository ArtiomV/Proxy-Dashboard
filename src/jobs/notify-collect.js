'use strict';

/**
 * Notification collector (Stage 18.15).
 *
 * Periodically scans live state for the "ambient" notifications that the
 * Telegram alerts framework doesn't already cover: long-offline modems,
 * clients in debt, due CRM reminders. Each finding is upserted into the
 * `notifications` table via alerts.recordBellEvent — which itself dedupes
 * by dedup_key. We use a per-day bucket in the key so the same condition
 * surfaces once per day rather than once per scan.
 *
 * Also purges rows older than NOTIF_TTL_DAYS — keeps the bell history
 * focused on what's actionable and the table small.
 *
 * Design choices:
 *   - one job, runs every 2 minutes, sequential passes
 *   - offline-modem pass reuses getStaleNicks() so we don't alert on
 *     long-dead modems (those have their own «удалить» flow elsewhere)
 *   - CRM pass is best-effort: external Postgres failures are swallowed
 *     so a CRM outage doesn't block offline/debt collection
 */

const NOTIF_TTL_DAYS = 30;
const OFFLINE_MIN_MS = 10 * 60 * 1000;   // «Модем отключен» = dark >10 min (matches computeFleet disconnectedMs + the TG offline alert)
const CLIENT_DEBT_THRESHOLD = -10;       // ₽

let deps = null;
let _interval = null;

function init(injectedDeps) {
  deps = injectedDeps;
  // First run after a short delay so live state has time to settle on boot.
  setTimeout(runOnce, 30 * 1000);
  _interval = setInterval(runOnce, 2 * 60 * 1000);
  return { stop };
}

function stop() {
  if (_interval) { clearInterval(_interval); _interval = null; }
}

function todayBucket() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Moscow' });
}

function esc(s) {
  if (s == null) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function runOnce() {
  if (!deps) return;
  const enabled = deps.alerts && deps.alerts.isRuleEnabled;
  // Per-rule toggle gates whole passes — if the admin turned the rule off in
  // Settings → Уведомления, we skip the scan entirely. Saves an SQLite walk.
  if (!enabled || enabled('modem_offline')) {
    try { passOfflineModems(); }   catch (e) { deps.logger.warn('[NotifyCollect] offline: ' + e.message); }
  }
  if (!enabled || enabled('sim_redirect_imposed') || enabled('sim_status_bad') || enabled('reboot_score_high')) {
    try { passSimSignals(); }      catch (e) { deps.logger.warn('[NotifyCollect] sim: ' + e.message); }
  }
  if (!enabled || enabled('client_debt')) {
    try { passClientDebts(); }     catch (e) { deps.logger.warn('[NotifyCollect] debts: ' + e.message); }
  }
  if (!enabled || enabled('crm_reminder')) {
    try { await passCrmReminders(); } catch (e) { deps.logger.warn('[NotifyCollect] crm: ' + e.message); }
  }
  try { passCleanup(); } catch (e) { deps.logger.warn('[NotifyCollect] cleanup: ' + e.message); }
}

// ── Pass 1: offline modems ──────────────────────────────────────
// Walks uptimeTracking + knownModems. A modem is reported when:
//   - it has been online at some point (we have last_online_check)
//   - it has been offline >= 20 min since then
//   - it is NOT in the "stale" set (already offline > stale_modem_hours)
function passOfflineModems() {
  const { alerts, uptimeTracking, knownModems, getStaleNicks } = deps;
  const now = Date.now();
  const day = todayBucket();
  const staleNicks = (typeof getStaleNicks === 'function') ? getStaleNicks() : new Set();

  // Build (server,imei → nick) map from knownModems for friendly names.
  const nickByKey = {};
  for (const [srvName, ports] of Object.entries(knownModems || {})) {
    for (const p of Object.values(ports || {})) {
      if (p && p.imei) nickByKey[srvName + '_' + p.imei] = p.nick || p.imei;
    }
  }

  for (const [key, ut] of Object.entries(uptimeTracking || {})) {
    if (!ut || !ut.last_online_check) continue;
    const lastMs = Date.parse(ut.last_online_check);
    if (isNaN(lastMs)) continue;
    const offlineMs = now - lastMs;
    if (offlineMs < OFFLINE_MIN_MS) continue;
    // key format: <serverName>_<imei>
    const m = key.match(/^(\w+)_(\d{10,20})$/);
    if (!m) continue;
    const server = m[1], imei = m[2];
    const nick = nickByKey[key];
    // No nick → uptimeTracking has history for an IMEI that's no longer
    // registered in ProxySmart (modem swapped, removed, etc.). Don't alert
    // on these — they'd flood the bell with raw IMEIs the operator can't
    // act on. Same idea as staleNicks below, just covers the "removed
    // from API entirely" gap.
    if (!nick) continue;
    if (staleNicks.has(nick)) continue;  // long-dead — bell would spam

    const mins = Math.floor(offlineMs / 60000);
    const lastOnlineLocal = new Date(lastMs).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' });
    alerts.recordBellEvent({
      dedup_key: 'modem_offline_' + nick + '_' + day,
      rule_id: 'modem_offline',
      priority: mins > 60 ? 'important' : 'early',
      entity_kind: 'modem',
      entity_id: nick,
      title: 'Модем оффлайн',
      message: `📴 <b>${esc(nick)}</b> (${esc(server)}) — не отвечает ${mins} мин.\nПоследний онлайн: ${esc(lastOnlineLocal)} МСК`,
      payload: { server, imei, nick, mins, lastOnline: lastOnlineLocal },
    });
  }
}

// ── Pass 1c: ProxySmart SIM / health signals (Batch 1) ──────────
// Reads the live signal columns persisted on modem_meta and raises the
// matching alert via alerts.trigger (tg+bell, cooldown-suppressed across
// scans). Freshness-gated on signals_updated_at so a modem that has since
// gone offline (signals frozen) stops firing — offline has its own alert.
function passSimSignals() {
  const { alerts, db, getSetting } = deps;
  const threshold = Number((getSetting && getSetting('reboot_score_alert_threshold', 70)) || 70);
  let rows = [];
  try {
    rows = db.prepare(
      "SELECT server_name, imei, nick, sim_status, reboot_score, http_redirect " +
      "FROM modem_meta WHERE signals_updated_at >= datetime('now','-15 minutes')"
    ).all();
  } catch (_) { return; }   // signal columns missing pre-migration → skip
  for (const r of rows) {
    const nick = r.nick || r.imei;
    if (/^random/i.test(nick)) continue;
    const base = { server: r.server_name, imei: r.imei, nick };
    // (a) operator captive redirect == SIM out of money / blocked
    if (r.http_redirect) alerts.trigger('sim_redirect_imposed', base);
    // (b) SIM status not healthy. ProxySmart reports several GOOD forms:
    // "OK", "SIM OK", "+CPIN: READY". "UNKNOWN"/"" = no data (modem offline /
    // signal loss) — NOT a confirmed fault, so don't alert. Anything else
    // (e.g. MODEM_SIM_UNDETECTED) is a real problem.
    const ss = String(r.sim_status || '').toUpperCase();
    if (ss && ss !== 'UNKNOWN' && !/\bOK\b|READY/.test(ss)) alerts.trigger('sim_status_bad', { ...base, simStatus: ss });
    // (c) high reboot score
    if (r.reboot_score != null && Number(r.reboot_score) >= threshold) {
      alerts.trigger('reboot_score_high', { ...base, score: r.reboot_score });
    }
  }
}

// ── Pass 2: clients in debt ────────────────────────────────────
function passClientDebts() {
  const { alerts, clients } = deps;
  if (!Array.isArray(clients)) return;
  const day = todayBucket();
  for (const c of clients) {
    const bal = Number(c.balance) || 0;
    if (bal >= CLIENT_DEBT_THRESHOLD) continue;
    alerts.recordBellEvent({
      dedup_key: 'client_debt_' + c.id + '_' + day,
      rule_id: 'client_debt',
      priority: bal < -1000 ? 'important' : 'early',
      entity_kind: 'client',
      entity_id: c.id,
      title: 'Клиент в долгу',
      message: `💸 <b>${esc(c.name)}</b> — баланс ${Math.round(bal)} ₽.`,
      payload: { client_id: c.id, client: c.name, balance: bal },
    });
  }
}

// ── Pass 3: CRM reminders ───────────────────────────────────────
// Same query as /api/admin/crm_reminders (src/routes/telegram-crm.js).
// Wrapped in try/catch — if the external CRM is down, swallow and skip.
async function passCrmReminders() {
  const { alerts } = deps;
  const dbUrl = process.env.CRM_DB_URL;
  const workspace = process.env.CRM_WORKSPACE;
  if (!dbUrl || !workspace || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(workspace)) return;
  let Pool;
  try { Pool = require('pg').Pool; } catch (_) { return; }
  const pool = new Pool({ connectionString: dbUrl, max: 1, idleTimeoutMillis: 5000 });
  try {
    const result = await pool.query(
      `SELECT id, name, "reminderDate"
       FROM ${workspace}.opportunity
       WHERE "reminderDate" IS NOT NULL AND "reminderDate" <= NOW() AND "deletedAt" IS NULL
       ORDER BY "reminderDate" ASC LIMIT 50`
    );
    for (const r of result.rows) {
      // Per-day bucket so a long-overdue reminder doesn't surface 720x/day.
      const day = todayBucket();
      const dt = r.reminderDate ? new Date(r.reminderDate).toLocaleDateString('ru-RU', { timeZone: 'Europe/Moscow' }) : '';
      alerts.recordBellEvent({
        dedup_key: 'crm_' + r.id + '_' + day,
        rule_id: 'crm_reminder',
        priority: 'important',
        entity_kind: 'crm',
        entity_id: r.id,
        title: 'Напоминание CRM',
        message: `🔔 <b>${esc(r.name || 'Сделка')}</b>${dt ? ' (' + esc(dt) + ')' : ''}`,
        payload: { id: r.id, name: r.name, reminderDate: r.reminderDate },
      });
    }
  } finally {
    pool.end().catch(() => {});
  }
}

// ── Pass 4: purge old rows (TTL) ────────────────────────────────
function passCleanup() {
  const { db } = deps;
  // P2-4: NOTIF_TTL_DAYS is a module constant, but pass it as a bound int rather
  // than interpolating it into the SQL string — keeps this safe if the TTL ever
  // becomes a setting. CASCADE on notification_read_state handles read markers.
  const ttl = Math.max(1, Number(NOTIF_TTL_DAYS) | 0);
  db.prepare("DELETE FROM notifications WHERE created_at < datetime('now', '-' || ? || ' days')").run(ttl);
}

module.exports = { init, runOnce };
