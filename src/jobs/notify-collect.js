'use strict';

/**
 * Notification collector (Stage 18.15).
 *
 * Periodically scans live state for the "ambient" notifications that the
 * Telegram alerts framework doesn't already cover: long-offline modems,
 * clients in debt. Each finding is upserted into the
 * `notifications` table via alerts.recordBellEvent — which itself dedupes
 * by dedup_key. We use a per-day bucket in the key so the same condition
 * surfaces once per day rather than once per scan.
 *
 * Also purges rows older than NOTIF_TTL_DAYS — keeps the bell history
 * focused on what's actionable and the table small.
 *
 * Design choices:
 *   - one job, runs every 2 minutes, sequential passes
 *   - offline-modem pass fires on exactly fleet.disconnectedList (WP4.2) —
 *     since 2026-07-28 that includes long-dead modems too (no 48h cut-off);
 *     the per-day dedup_key below keeps a week-dead modem from flooding
 *     the bell (one entry per day)
 */

const NOTIF_TTL_DAYS = 30;
const { computeFleet } = require('../modems/fleet');   // WP4.2: bell set == card set
const scheduler = require('./scheduler');              // C8/§10.7: реестр → /api/admin/health.jobs
const CLIENT_DEBT_THRESHOLD = -10;       // ₽

let deps = null;
let _interval = null;

function init(injectedDeps) {
  deps = injectedDeps;
  // C8/§10.7: register in the unified scheduler registry (last-run/status in
  // /api/admin/health → jobs). wrapJob preserves semantics — runOnce already
  // catches per-pass errors internally, so behaviour/cadence don't change.
  const { safeFn } = scheduler.wrapJob('NotifyCollect', 'every 2 min', runOnce, deps.logger);
  // First run after a short delay so live state has time to settle on boot.
  setTimeout(safeFn, 30 * 1000);
  _interval = setInterval(safeFn, 2 * 60 * 1000);
  return { stop };
}

function stop() {
  if (_interval) { clearInterval(_interval); _interval = null; }
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
  if (!enabled || enabled('modem_offline_20m')) {
    try { await passOfflineModems(); } catch (e) { deps.logger.warn('[NotifyCollect] offline: ' + e.message); }
  }
  if (!enabled || enabled('sim_redirect_imposed') || enabled('sim_status_bad') || enabled('reboot_score_high')) {
    try { passSimSignals(); }      catch (e) { deps.logger.warn('[NotifyCollect] sim: ' + e.message); }
  }
  if (!enabled || enabled('client_balance_negative')) {
    try { passClientDebts(); }     catch (e) { deps.logger.warn('[NotifyCollect] debts: ' + e.message); }
  }
  try { passCleanup(); } catch (e) { deps.logger.warn('[NotifyCollect] cleanup: ' + e.message); }
}

// ── Pass 1: offline modems ──────────────────────────────────────
// WP4.2: the bell fires on EXACTLY the set the «Модем отключен» card shows —
// fleet.disconnectedList, computed here with the same inputs /api/admin/data
// uses. Two historic divergences die with this:
//   - glitched-to-random twins used to bell while the card credited them away
//     («алерт есть, в карточке пусто») — the fleet layer credits them;
//   - the >12h stale suppression meant «в карточке есть, в колокольчике
//     тишина» — removed; day-level dedup below keeps it from flooding.
//
// D3: скан вынесен в scanDisconnected() — его же использует дневная TG-сводка
// (строка «Лежат >12 ч»), чтобы источник данных был один.
async function scanDisconnected() {
  const { uptimeTracking, trackingDb, fetchAllServersDataCached, mergeServerData, getSetting } = deps;
  if (!trackingDb || !fetchAllServersDataCached || !mergeServerData) return [];
  const results = await fetchAllServersDataCached();
  const merged = mergeServerData(results, '*');
  // Same disconnected threshold as the card (modem_offline_threshold_min, default 10).
  const discMs = (Number(getSetting && getSetting('modem_offline_threshold_min', 10)) || 10) * 60000;
  const roster = typeof trackingDb.metaFleetRosterStmt === 'function'
    ? trackingDb.metaFleetRosterStmt().all()
    : (trackingDb.metaFleetRoster ? trackingDb.metaFleetRoster.all() : []);
  const fleet = computeFleet(roster, uptimeTracking, merged.status || [], { disconnectedMs: discMs });
  return fleet.disconnectedList;
}

async function passOfflineModems() {
  const { alerts } = deps;
  if (!deps.trackingDb || !deps.fetchAllServersDataCached || !deps.mergeServerData) return;
  for (const o of await scanDisconnected()) {
    const lastMs = o.lastOnline || 0;
    const mins = lastMs ? Math.floor((Date.now() - lastMs) / 60000) : 0;
    const lastOnlineLocal = lastMs ? new Date(lastMs).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' }) : '—';
    const nick = o.nick || o.key;
    alerts.recordBellEvent({
      // Exact canonical alert key: if the tracking alert already wrote the
      // bell card, recordBellEvent sees it and does not create a second one.
      dedup_key: 'modem_offline_20m|mof_' + o.server + '_' + (String(o.key).split('|')[1] || ''),
      dedup_window_sec: 86400,
      rule_id: 'modem_offline_20m',
      priority: mins > 60 ? 'important' : 'early',
      entity_kind: 'modem',
      entity_id: nick,
      title: 'Модем оффлайн',
      message: `📴 <b>${esc(nick)}</b> (${esc(o.server)}) — не отвечает ${mins} мин.\nПоследний онлайн: ${esc(lastOnlineLocal)} МСК`,
      payload: { server: o.server, imei: String(o.key).split('|')[1] || '', nick, mins, lastOnline: lastOnlineLocal },
    });
  }
}

// ── Pass 1c: ProxySmart SIM / health signals (Batch 1) ──────────
// Reads the live signal columns persisted on modem_meta and raises the
// matching alert via alerts.trigger (tg+bell, cooldown-suppressed across
// scans). Freshness-gated on signals_updated_at so a modem that has since
// gone offline (signals frozen) stops firing — offline has its own alert.
function passSimSignals() {
  const { alerts, db, getSetting, knownModems } = deps;
  const threshold = Number((getSetting && getSetting('reboot_score_alert_threshold', 70)) || 70);
  // Alert ONLY for modems that are actually on the Модемы page = have a live port
  // binding in known_modems. A modem physically present in the feed but with NO port
  // (dead SIM can't register → no proxy port, so it's invisible in the UI) must not
  // spam SIM/redirect/reboot alerts the operator can't even see or act on (RO2_44).
  const activeKeys = new Set();
  if (knownModems) {
    for (const srv of Object.keys(knownModems)) {
      const ports = knownModems[srv] || {};
      for (const pid of Object.keys(ports)) {
        const info = ports[pid];
        if (info && info.imei) activeKeys.add(srv + '|' + info.imei);
      }
    }
  }
  let rows = [];
  try {
    rows = db.prepare(
      "SELECT server_name, imei, nick, sim_status, reboot_score, http_redirect " +
      "FROM modem_meta WHERE signals_updated_at >= datetime('now','-15 minutes') " +
      "  AND (deleted IS NULL OR deleted = 0)"   // soft-deleted → never alert (RO2_35 class)
    ).all();
  } catch (_) { return; }   // signal columns missing pre-migration → skip
  for (const r of rows) {
    const nick = r.nick || r.imei;
    if (/^random/i.test(nick)) continue;
    if (!activeKeys.has(r.server_name + '|' + r.imei)) continue;   // not on the modems page → skip
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
  for (const c of clients) {
    const bal = Number(c.balance) || 0;
    if (bal >= CLIENT_DEBT_THRESHOLD) continue;
    alerts.recordBellEvent({
      dedup_key: 'client_balance_negative|debt_' + c.id + '_balance_negative',
      dedup_window_sec: 86400,
      rule_id: 'client_balance_negative',
      priority: bal < -1000 ? 'important' : 'early',
      entity_kind: 'client',
      entity_id: c.id,
      title: 'Клиент в долгу',
      message: `💸 <b>${esc(c.name)}</b> — баланс ${Math.round(bal)} ₽.`,
      payload: { client_id: c.id, client: c.name, balance: bal },
    });
  }
}

// ── Pass 3: purge old rows (TTL) ────────────────────────────────
function passCleanup() {
  const { db } = deps;
  // P2-4: NOTIF_TTL_DAYS is a module constant, but pass it as a bound int rather
  // than interpolating it into the SQL string — keeps this safe if the TTL ever
  // becomes a setting. CASCADE on notification_read_state handles read markers.
  const ttl = Math.max(1, Number(NOTIF_TTL_DAYS) | 0);
  db.prepare("DELETE FROM notifications WHERE created_at < datetime('now', '-' || ? || ' days')").run(ttl);
}

module.exports = { init, runOnce, scanDisconnected: async () => { if (!deps) return []; return scanDisconnected(); } };
