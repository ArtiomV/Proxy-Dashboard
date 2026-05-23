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

function init(deps) {
  db          = deps.db;
  logger      = deps.logger;
  clientById  = deps.clientById;
  getSetting  = deps.getSetting;
  aiInsights  = deps.aiInsights || null;
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
  // server_unreachable events from system_log
  let infraEvents = [];
  try {
    infraEvents = db.prepare(`
      SELECT source, message, level, created_at
      FROM system_log
      WHERE created_at >= ? AND created_at < ?
        AND (action = 'server_unreachable' OR level IN ('error','critical'))
      ORDER BY created_at DESC LIMIT 50
    `).all(utcStartStr, utcEndStr);
  } catch (_) { /* table or column may differ */ }

  const serverDownSet = new Set();
  let errorCount = 0;
  for (const e of infraEvents) {
    if (e.message && /unreachable|server_unreachable/i.test(e.message)) {
      if (e.source) serverDownSet.add(e.source);
    }
    if (e.level === 'error' || e.level === 'critical') errorCount++;
  }

  // proxy issues right now
  const proxyIssues = db.prepare(`
    SELECT server_name, nick,
           AVG(total_ms) FILTER (WHERE error IS NULL) AS avg_ms,
           COUNT(*) AS total,
           SUM(CASE WHEN error IS NOT NULL THEN 1 ELSE 0 END) AS errors
    FROM proxy_checks
    WHERE checked_at >= ? AND checked_at < ?
    GROUP BY server_name, nick
    HAVING (avg_ms > 1500 OR (errors*100.0/total) > 10)
  `).all(utcStartStr, utcEndStr);

  // Auto-reboots
  const rebootRow = db.prepare(`
    SELECT COUNT(*) as n,
           SUM(CASE WHEN status='success' THEN 1 ELSE 0 END) as ok
    FROM auto_reboot_log
    WHERE rebooted_at >= ? AND rebooted_at < ?
  `).get(utcStartStr, utcEndStr);

  // SLA violations
  let slaCount = 0;
  try {
    const sla = db.prepare(`SELECT COUNT(*) c FROM sla_violations WHERE date = ?`).get(date);
    slaCount = (sla && sla.c) || 0;
  } catch (_) {}

  lines.push('');
  lines.push('⚙️ <b>Инфраструктура</b>');
  if (serverDownSet.size) lines.push(`Серверы недоступны: <b>${Array.from(serverDownSet).join(', ')}</b>`);
  else lines.push('Все серверы доступны');
  if (proxyIssues.length) lines.push(`Проблемных прокси: ${proxyIssues.length} (latency >1500мс или errors >10%)`);
  if (rebootRow && rebootRow.n > 0) lines.push(`Авто-перезагрузок: ${rebootRow.n} (успешных ${rebootRow.ok}/${rebootRow.n})`);
  if (slaCount) lines.push(`⚠️ SLA-нарушений: ${slaCount}`);
  if (errorCount) lines.push(`Ошибок в системном логе: ${errorCount}`);

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
  } catch (_) {}

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
  const dashUrl = getSetting('public_url', '') || 'https://dashboard.proxies.rent';
  lines.push('');
  lines.push(`<a href="${dashUrl}/admin">Открыть дашборд →</a>`);

  return { text: lines.join('\n'), parse_mode: 'HTML' };
}

module.exports = { init, buildDailySummary };
