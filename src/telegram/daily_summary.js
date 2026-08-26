'use strict';

/**
 * Build a daily summary text for Telegram.
 * Pulls everything from the existing dashboard DB — no live API calls,
 * so it can run from any process and won't be affected by ProxySmart outages.
 *
 * Inputs (via init):
 *   db          — better-sqlite3 instance
 *   logger      — pino-like
 *   clientById  — Map<id, client>  (in-memory clients)
 *   getSetting  — (key, def) => value (for dashboard URL etc.)
 *
 * Output (buildDailySummary(date)):
 *   { text: string, parse_mode: 'HTML' }
 */

let db, logger, clientById, getSetting;
let aiInsights;  // optional — injected via init; if absent, AI section is skipped
let listDisconnectedModems;  // optional (D3) — async () => fleet.disconnectedList; без него дайджест оффлайна пропускается

function init(deps) {
  db          = deps.db;
  logger      = deps.logger;
  clientById  = deps.clientById;
  getSetting  = deps.getSetting;
  aiInsights  = deps.aiInsights || null;
  listDisconnectedModems = deps.listDisconnectedModems || null;
}

function fmtMoney(v) {
  const n = Math.round(v || 0);
  return n.toLocaleString('ru-RU') + ' ₽';
}
function fmtGb(bytes) {
  const gb = (bytes || 0) / 1e9;
  if (gb >= 100) return Math.round(gb) + ' GB';
  if (gb >= 10) return gb.toFixed(1) + ' GB';
  return gb.toFixed(2) + ' GB';
}
function escHtml(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function trunc(s, n) {
  s = String(s || '');
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}
function hasTable(name) {
  try {
    return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
  } catch (_) { return false; }
}

const RU_MONTHS = ['января','февраля','марта','апреля','мая','июня','июля','августа','сентября','октября','ноября','декабря'];
const RU_WEEKDAYS = ['воскресенье','понедельник','вторник','среда','четверг','пятница','суббота'];

function fmtDateLong(yyyymmdd) {
  const d = new Date(yyyymmdd + 'T00:00:00');
  return d.getDate() + ' ' + RU_MONTHS[d.getMonth()] + ' ' + d.getFullYear() + ' (' + RU_WEEKDAYS[d.getDay()] + ')';
}

/**
 * Build summary for a single MSK day "YYYY-MM-DD".
 * MSK day [date 00:00, date 24:00) = UTC [(date-1) 21:00, date 21:00).
 */
async function buildDailySummary(date) {
  const lines = [];
  lines.push(`🌙 <b>Сводка за ${escHtml(fmtDateLong(date))}</b>`);

  // ----- 1) Финансы -----
  const charges = db.prepare(`
    SELECT client_id,
           SUM(amount) as total,
           COUNT(*) as n
    FROM billing_ledger
    WHERE type IN ('charge','correction','manual_charge') AND date = ?
    GROUP BY client_id
    ORDER BY total DESC
  `).all(date);

  const totalCharged = charges.reduce((s, r) => s + (r.total || 0), 0);
  const payments = db.prepare(`
    SELECT SUM(amount) as total, COUNT(*) as n
    FROM billing_ledger
    WHERE type IN ('payment','bank_payment','manual_credit') AND date = ?
  `).get(date);
  const totalPaid = (payments && payments.total) || 0;

  lines.push('');
  lines.push('💰 <b>Финансы</b>');
  lines.push(`Доход: <b>${fmtMoney(totalCharged)}</b> · списано с ${charges.length} клиентов`);
  if (totalPaid > 0) lines.push(`Поступления: ${fmtMoney(totalPaid)} (${payments.n})`);
  if (charges.length > 0) {
    const top = charges.slice(0, 5);
    for (const c of top) {
      const cl = clientById.get(c.client_id);
      const name = cl ? trunc(cl.name || cl.portName || c.client_id, 32) : c.client_id.slice(0, 12);
      lines.push(`  • ${escHtml(name)} — ${fmtMoney(c.total)}`);
    }
    if (charges.length > 5) lines.push(`  …и ещё ${charges.length - 5}`);
  }

  // Должники (отрицательный баланс прямо сейчас)
  const debtors = [];
  if (clientById && typeof clientById.values === 'function') {
    for (const c of clientById.values()) {
      if (c.balance < 0 && !c.billingPaused) debtors.push(c);
    }
    debtors.sort((a, b) => a.balance - b.balance);
  }
  if (debtors.length) {
    const totalDebt = debtors.reduce((s, c) => s + c.balance, 0);
    lines.push(`Должников: ${debtors.length} · долг ${fmtMoney(Math.abs(totalDebt))}`);
    for (const d of debtors.slice(0, 3)) {
      lines.push(`  • ${escHtml(trunc(d.name || d.portName, 32))}: ${fmtMoney(d.balance)}`);
    }
  }

  // ----- 2) Трафик per_gb -----
  // MSK boundaries
  const utcStart = new Date(date + 'T00:00:00Z'); utcStart.setUTCHours(utcStart.getUTCHours() - 3);
  const utcEnd   = new Date(date + 'T00:00:00Z'); utcEnd.setUTCHours(utcEnd.getUTCHours() + 21);
  const utcStartStr = utcStart.toISOString().slice(0, 16).replace('T', ' ');
  const utcEndStr   = utcEnd.toISOString().slice(0, 16).replace('T', ' ');

  const trafficRows = db.prepare(`
    SELECT client_name, SUM(bytes_in+bytes_out) as bytes, COUNT(DISTINCT port_id) as ports
    FROM traffic_hourly
    WHERE hour_start >= ? AND hour_start < ? AND client_name != ''
    GROUP BY client_name
    ORDER BY bytes DESC
  `).all(utcStartStr, utcEndStr);

  const totalBytes = trafficRows.reduce((s, r) => s + (r.bytes || 0), 0);

  // peak hour overall
  const peakHourRow = db.prepare(`
    SELECT strftime('%H:00', datetime(hour_start, '+3 hours')) as h,
           SUM(bytes_in+bytes_out) as bytes
    FROM traffic_hourly
    WHERE hour_start >= ? AND hour_start < ?
    GROUP BY h ORDER BY bytes DESC LIMIT 1
  `).get(utcStartStr, utcEndStr);

  lines.push('');
  lines.push('📊 <b>Трафик</b>');
  lines.push(`Всего за день: <b>${fmtGb(totalBytes)}</b>` + (peakHourRow ? `, пик в ${peakHourRow.h} (${fmtGb(peakHourRow.bytes)})` : ''));

  // Per-client breakdown for per_gb tariff
  const perGbClients = trafficRows.filter(r => {
    const cl = Array.from(clientById.values()).find(c => c.portName === r.client_name);
    return cl && cl.billingType === 'per_gb';
  });
  if (perGbClients.length) {
    lines.push('per_gb клиенты:');
    for (const r of perGbClients.slice(0, 5)) {
      const cl = Array.from(clientById.values()).find(c => c.portName === r.client_name);
      const price = cl ? cl.price : 0;
      const cost = (r.bytes / 1e9) * price;
      lines.push(`  • ${escHtml(trunc(cl ? cl.name : r.client_name, 32))}: ${fmtGb(r.bytes)} → ${fmtMoney(cost)}`);
    }
  }

  // ----- 3) Инфраструктура -----
  // server_unreachable events from system_log. C7: query uses the REAL columns
  // (timestamp/category/action/target — the old `source`/`created_at` don't
  // exist, the query threw daily and the silent catch left this block empty).
  let infraEvents = [];
  try {
    infraEvents = db.prepare(`
      SELECT target, action, message, level, timestamp
      FROM system_log
      WHERE timestamp >= ? AND timestamp < ?
        AND (action = 'server_unreachable' OR level IN ('error','critical'))
      ORDER BY timestamp DESC LIMIT 50
    `).all(utcStartStr, utcEndStr);
  } catch (e) {
    // Rule (OPERATIONS.md): деградация через catch обязана писать warn.
    if (logger && logger.warn) logger.warn('[DailySummary] system_log query failed (infra block degraded): ' + (e.message || e));
  }

  const serverDownSet = new Set();
  let errorCount = 0;
  for (const e of infraEvents) {
    // server_unreachable rows are written by modem-tracking with the server
    // name in `target` (category 'modem', level 'warn').
    if (e.action === 'server_unreachable' && e.target) serverDownSet.add(e.target);
    if (e.level === 'error' || e.level === 'critical') errorCount++;
  }

  // Connectivity issues from ProxySmart's own per-modem ping destination.
  const proxyIssues = db.prepare(`
    SELECT server AS server_name, nick,
           AVG(latency_ms) FILTER (WHERE ok = 1) AS avg_ms,
           COUNT(*) AS total,
           AVG(COALESCE(loss_pct, CASE WHEN ok = 1 THEN 0 ELSE 100 END)) AS loss_pct
    FROM modem_ping
    WHERE ts >= ? AND ts < ?
    GROUP BY server, nick
    HAVING (avg_ms > 1500 OR loss_pct > 10)
  `).all(utcStartStr, utcEndStr);

  // Auto-reboots
  const rebootRow = db.prepare(`
    SELECT COUNT(*) as n,
           SUM(CASE WHEN status='success' THEN 1 ELSE 0 END) as ok
    FROM auto_reboot_log
    WHERE rebooted_at >= ? AND rebooted_at < ?
  `).get(utcStartStr, utcEndStr);

  lines.push('');
  lines.push('⚙️ <b>Инфраструктура</b>');
  if (serverDownSet.size) lines.push(`Серверы недоступны: <b>${Array.from(serverDownSet).join(', ')}</b>`);
  else lines.push('Все серверы доступны');
  // D3: оффлайн-дайджест. TG-алерты оффлайна глушатся после stale_modem_hours
  // (12 ч) — долголежащие модемы были видны только в колокольчике. Строка в
  // сводке закрывает дыру. Источник тот же, что у колокольчика
  // (notify-collect → fleet.disconnectedList), список — топ-10 + «и ещё N».
  if (listDisconnectedModems) {
    try {
      const staleH = Number(getSetting('stale_modem_hours', 12)) || 12;
      const nowMs = Date.now();
      const longDead = (await listDisconnectedModems())
        .filter(o => o.lastOnline && (nowMs - o.lastOnline) >= staleH * 3600 * 1000)
        .sort((a, b) => a.lastOnline - b.lastOnline);   // дольше всех лежит — первым
      if (longDead.length) {
        const names = longDead.slice(0, 10).map(o => `${escHtml(o.nick || o.key)} (${escHtml(o.server)})`);
        lines.push(`Лежат >${staleH} ч: <b>${longDead.length}</b> модемов: ${names.join(', ')}`
          + (longDead.length > 10 ? ` …и ещё ${longDead.length - 10}` : ''));
      }
    } catch (e) {
      // Rule (OPERATIONS.md): деградация через catch обязана писать warn.
      if (logger && logger.warn) logger.warn('[DailySummary] offline digest failed (block degraded): ' + (e.message || e));
    }
  }
  if (proxyIssues.length) lines.push(`Проблемных прокси: ${proxyIssues.length} (пинг >1500мс или потери >10%)`);
  if (rebootRow && rebootRow.n > 0) lines.push(`Авто-перезагрузок: ${rebootRow.n} (успешных ${rebootRow.ok}/${rebootRow.n})`);
  if (errorCount) lines.push(`Ошибок в системном логе: ${errorCount}`);
  // Correlated incidents are the useful overnight signal: one operator/server
  // episode instead of dozens of modem cards.
  try {
    const incidents = hasTable('monitoring_incidents') ? db.prepare(`SELECT state,server,operator,opened_at,closed_at,duration_sec,modem_count,client_count
      FROM monitoring_incidents WHERE opened_at >= ? AND opened_at < ? ORDER BY opened_at`).all(utcStart.toISOString(), utcEnd.toISOString()) : [];
    if (incidents.length) {
      lines.push(`Инцидентов: <b>${incidents.length}</b>`);
      for (const it of incidents.slice(0, 8)) {
        const state = it.state === 'closed' ? `закрыт за ${Math.max(1, Math.round((it.duration_sec || 0) / 60))} мин` : 'ещё открыт';
        lines.push(`  • ${escHtml(it.operator || 'общая связь')} · ${escHtml(it.server)} — ${it.modem_count} мод., ${it.client_count} кл. · ${state}`);
      }
    }
  } catch (e) {
    if (logger && logger.warn) logger.warn('[DailySummary] incidents query failed (block degraded): ' + (e.message || e));
  }

  // Non-critical alerts are deliberately not duplicated to Telegram during
  // the quiet window. They remain in the bell and are condensed here, so the
  // morning summary closes the loop without an overnight message storm.
  if (getSetting('telegram_night_digest_enabled', true) !== false && hasTable('notifications')) {
    try {
      const from = String(getSetting('telegram_quiet_from', '23:00'));
      const to = String(getSetting('telegram_quiet_to', '08:00'));
      const parseMin = value => {
        const m = /^(\d{2}):(\d{2})$/.exec(value);
        if (!m || +m[1] > 23 || +m[2] > 59) return null;
        return +m[1] * 60 + +m[2];
      };
      const fromMin = parseMin(from), toMin = parseMin(to);
      if (fromMin != null && toMin != null && fromMin !== toMin) {
        const wallToUtc = (dayOffset, mins) => {
          const d = new Date(date + 'T00:00:00Z');
          d.setUTCDate(d.getUTCDate() + dayOffset);
          d.setUTCMinutes(mins - 180); // MSK → UTC
          return d.toISOString().slice(0, 19).replace('T', ' ');
        };
        const quietStart = wallToUtc(0, fromMin);
        const quietEnd = wallToUtc(fromMin > toMin ? 1 : 0, toMin);
        const quietRows = db.prepare(`
          SELECT rule_id, title, COUNT(*) AS n
          FROM notifications
          WHERE created_at >= ? AND created_at < ? AND priority <> 'critical'
            AND json_extract(COALESCE(payload_json, '{}'), '$._telegram_night_deferred') = 1
          GROUP BY rule_id, title ORDER BY n DESC, title LIMIT 8
        `).all(quietStart, quietEnd);
        const quietTotal = quietRows.reduce((sum, row) => sum + Number(row.n || 0), 0);
        if (quietTotal) {
          lines.push(`Ночью без Telegram: <b>${quietTotal}</b> некритичных событий (они сохранены в колокольчике)`);
          for (const row of quietRows) lines.push(`  • ${escHtml(row.title || row.rule_id)} — ${row.n}`);
        }
      }
    } catch (e) {
      if (logger && logger.warn) logger.warn('[DailySummary] quiet digest failed (block degraded): ' + (e.message || e));
    }
  }

  // ----- 4) Ротации -----
  let rotRow = null;
  try {
    rotRow = db.prepare(`
      SELECT COUNT(*) as total,
             SUM(CASE WHEN old_ip = new_ip AND new_ip IS NOT NULL THEN 1 ELSE 0 END) as failed,
             AVG(took_sec) as avg_sec
      FROM rotation_log
      WHERE started_at >= ? AND started_at < ?
    `).get(utcStartStr, utcEndStr);
  } catch (e) {
    // Rule (OPERATIONS.md): деградация через catch обязана писать warn.
    if (logger && logger.warn) logger.warn('[DailySummary] rotation_log query failed (rotations block degraded): ' + (e.message || e));
  }

  if (rotRow && rotRow.total > 0) {
    lines.push('');
    lines.push('🔄 <b>Ротации</b>');
    lines.push(`Всего: ${rotRow.total}, неуспешных: ${rotRow.failed} (${(rotRow.failed*100/rotRow.total).toFixed(1)}%)`);
    if (rotRow.avg_sec) lines.push(`Среднее время: ${rotRow.avg_sec.toFixed(1)} сек`);
  }

  // ----- 5) AI-driven analysis ("ОС за вчера") -----
  // Optional — only fires when ai_insights module is wired AND
  // ai_insights_enabled setting is true AND ANTHROPIC_API_KEY is set.
  // Any failure here is non-fatal — we still ship the stats above.
  if (aiInsights && getSetting('ai_insights_enabled', true)) {
    try {
      const aiBlock = await aiInsights.generateInsights(date);
      if (aiBlock) {
        lines.push('');
        lines.push('━━━━━━━━━━━━━━━');
        lines.push(aiBlock);
      }
    } catch (e) {
      logger && logger.warn && logger.warn('[DailySummary] AI insights failed: ' + (e.message || e));
    }
  }

  // ----- 6) Footer -----
  const dashUrl = getSetting('public_url', '') || 'https://app.arendaproxy.ru';
  lines.push('');
  lines.push(`<a href="${dashUrl}/admin">Открыть дашборд →</a>`);

  return { text: lines.join('\n'), parse_mode: 'HTML' };
}

module.exports = { init, buildDailySummary };
