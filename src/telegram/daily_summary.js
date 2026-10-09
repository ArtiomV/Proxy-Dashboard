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
let hasClientPorts;  // optional — (portName) => bool; гейт «Неактивные» (0 прокси) в списке должников
let modemHasClient;  // optional — (server, nick) => bool; гейт «свободные модемы» в дайджесте застрявших симок

function init(deps) {
  db          = deps.db;
  logger      = deps.logger;
  clientById  = deps.clientById;
  getSetting  = deps.getSetting;
  aiInsights  = deps.aiInsights || null;
  listDisconnectedModems = deps.listDisconnectedModems || null;
  hasClientPorts = deps.hasClientPorts || null;
  modemHasClient = deps.modemHasClient || null;
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
// 2026-09-26: в сводке — отображаемые имена серверов (Настройки → Серверы),
// не технические S-коды. Кэш на минуту (как в alerts.js).
let _srvNamesCache = null, _srvNamesCacheAt = 0;
function srvLabel(name) {
  if (!name) return name;
  try {
    if (!_srvNamesCache || Date.now() - _srvNamesCacheAt > 60e3) {
      const row = db.prepare("SELECT value FROM kv_store WHERE key = 'api_servers'").get();
      const list = row && row.value ? JSON.parse(row.value) : [];
      _srvNamesCache = {};
      if (Array.isArray(list)) for (const s of list) _srvNamesCache[s.name] = s.displayName || s.name;
      _srvNamesCacheAt = Date.now();
    }
    return _srvNamesCache[name] || name;
  } catch (_) { return name; }
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
  // 2026-09-26: дельта к вчера вместо статичного топ-списка каждый день.
  const prevDate = new Date(new Date(date + 'T00:00:00Z').getTime() - 86400000).toISOString().slice(0, 10);
  const prevCharged = (db.prepare(`
    SELECT COALESCE(SUM(amount),0) AS total FROM billing_ledger
    WHERE type IN ('charge','correction','manual_charge') AND date = ?
  `).get(prevDate) || {}).total || 0;
  const revDeltaPct = prevCharged > 0 ? Math.round((totalCharged - prevCharged) / prevCharged * 100) : null;
  // Полнота биллинга: billing_jobs (миграция 099) — кого не списали и почему.
  let billingNote = '';
  if (hasTable('billing_jobs')) {
    try {
      const rows = db.prepare(`SELECT status, COUNT(*) n FROM billing_jobs WHERE billing_date = ? GROUP BY status`).all(date);
      const by = Object.fromEntries(rows.map(r => [r.status, r.n]));
      const bad = (by.failed || 0) + (by.no_data || 0);
      if (bad > 0) billingNote = ` · пропущено/ошибок: <b>${bad}</b>`;
    } catch (_) {}
  }
  // Новые клиенты и розничные продажи за день.
  let newClients = 0, newSales = 0;
  try { newClients = (db.prepare("SELECT COUNT(*) n FROM clients WHERE substr(created_at,1,10) = ?").get(date) || {}).n || 0; } catch (_) {}
  try { newSales = (db.prepare("SELECT COUNT(*) n FROM retail_purchases WHERE status='charged' AND substr(created_at,1,10) = ?").get(date) || {}).n || 0; } catch (_) {}

  lines.push('');
  lines.push('💰 <b>Финансы</b>');
  lines.push(`Доход: <b>${fmtMoney(totalCharged)}</b>` +
    (revDeltaPct != null ? ` (${revDeltaPct >= 0 ? '↑' : '↓'} ${Math.abs(revDeltaPct)}% к вчера)` : '') +
    ` · списано с ${charges.length} клиентов${billingNote}`);
  if (totalPaid > 0) lines.push(`Поступления: ${fmtMoney(totalPaid)} (${payments.n})`);
  if (newClients || newSales) {
    lines.push(`Новых клиентов: ${newClients} · продаж розницы: ${newSales}`);
  }
  // Истекающие прокси (<3 дн) — доход под угрозой, лучше увидеть утром.
  try {
    if (hasTable('known_modems')) {
      const today = new Date().toISOString().slice(0, 10);
      const in3d = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
      const rows = db.prepare(`
        SELECT json_extract(data, '$.portName') AS pn
        FROM known_modems
        WHERE json_extract(data, '$.portInfo.PROXY_VALID_BEFORE') != ''
          AND substr(json_extract(data, '$.portInfo.PROXY_VALID_BEFORE'), 1, 10) BETWEEN ? AND ?
      `).all(today, in3d);
      if (rows.length) {
        const byClient = {};
        for (const r of rows) { const k = r.pn || '?'; byClient[k] = (byClient[k] || 0) + 1; }
        const top = Object.entries(byClient).sort((a, b) => b[1] - a[1]).slice(0, 3);
        lines.push(`Истекают прокси &lt;3 дн: <b>${rows.length}</b> портов (${top.map(([k, n]) => `${escHtml(trunc(k, 24))}: ${n}`).join(', ')})`);
      }
    }
  } catch (_) {}
  if (charges.length > 0) {
    const top = charges.slice(0, 3);
    for (const c of top) {
      const cl = clientById.get(c.client_id);
      const name = cl ? trunc(cl.name || cl.portName || c.client_id, 32) : c.client_id.slice(0, 12);
      lines.push(`  • ${escHtml(name)} — ${fmtMoney(c.total)}`);
    }
    if (charges.length > 3) lines.push(`  …и ещё ${charges.length - 3}`);
  }

  // Должники (отрицательный баланс прямо сейчас)
  const debtors = [];
  if (clientById && typeof clientById.values === 'function') {
    for (const c of clientById.values()) {
      if (c.balance < 0 && !c.billingPaused) {
        // 20.09: клиент без единого прокси-порта (вкладка «Неактивные») в
        // дайджест должников не попадает — списания по нему не идут, долг
        // исторический; ежедневно напоминать о нём нет смысла. Зависимость
        // опциональна: без hasClientPorts поведение прежнее.
        if (hasClientPorts && !hasClientPorts(c.portName)) continue;
        debtors.push(c);
      }
    }
    debtors.sort((a, b) => a.balance - b.balance);
  }
  if (debtors.length) {
    const totalDebt = debtors.reduce((s, c) => s + c.balance, 0);
    lines.push(`Должников: ${debtors.length} · долг ${fmtMoney(Math.abs(totalDebt))}`);
    // 2026-09-26: вместо ежедневного повтора одного и того же списка —
    // должники с движениями за неделю (живые) по одному, остальные — свёрнуты.
    const activeDebtors = [];
    let staleDebt = 0, staleCount = 0;
    for (const d of debtors) {
      let lastMove = null;
      try {
        const r = db.prepare("SELECT MAX(timestamp) ts FROM billing_ledger WHERE client_id = ?").get(d.id);
        lastMove = r && r.ts ? Date.parse(r.ts.replace(' ', 'T') + (r.ts.includes('Z') ? '' : 'Z')) : null;
      } catch (_) {}
      const fresh = lastMove && (Date.now() - lastMove) < 7 * 86400000;
      if (fresh) activeDebtors.push(d);
      else { staleCount++; staleDebt += d.balance; }
    }
    for (const d of activeDebtors.slice(0, 3)) {
      lines.push(`  • ${escHtml(trunc(d.name || d.portName, 32))}: ${fmtMoney(d.balance)}`);
    }
    if (staleCount) lines.push(`  • старые (>7 дн без движений): ${staleCount} шт, ${fmtMoney(Math.abs(staleDebt))} — свёрнуты`);
  }

  // ----- 2) Трафик per_gb -----
  // MSK boundaries
  const utcStart = new Date(date + 'T00:00:00Z'); utcStart.setUTCHours(utcStart.getUTCHours() - 3);
  const utcEnd   = new Date(date + 'T00:00:00Z'); utcEnd.setUTCHours(utcEnd.getUTCHours() + 21);
  const utcStartStr = utcStart.toISOString().slice(0, 16).replace('T', ' ');
  const utcEndStr   = utcEnd.toISOString().slice(0, 16).replace('T', ' ');
  // 09.10: в БД смешаны три формата дат, строковое сравнение с чужим форматом
  // даёт неверное окно ('T'/'@' > ' ' — захватывались строки не того дня):
  //   • traffic_hourly/system_log/notifications — 'YYYY-MM-DD hh:mm' (UTC) → utcStartStr
  //   • modem_httpcheck/modem_ping/server_downtime — ISO 'T...Z' (UTC) → iso*
  //   • rotation_log — формат ProxySmart 'YYYY-MM-DD@hh:mm:ss' (МСК боксов) → at*
  const isoStartStr = utcStart.toISOString();
  const isoEndStr   = utcEnd.toISOString();
  const nextDayStr  = new Date(new Date(date + 'T00:00:00Z').getTime() + 86400000).toISOString().slice(0, 10);
  const atStartStr  = date + '@00:00:00';
  const atEndStr    = nextDayStr + '@00:00:00';

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
  // 2026-09-28: эффективная цена как в биллинге (priceOverride → tariff → price),
  // иначе сводка показывала список по базовой цене (Палитрумлаб: 29 ₽ в блоке
  // трафика при фактическом списании по override 23 ₽ — «два разных дохода»).
  function effectivePrice(cl) {
    if (cl && typeof cl.priceOverride === 'number' && cl.priceOverride > 0) return cl.priceOverride;
    if (cl && cl.tariffId != null) {
      try { const t = db.prepare('SELECT price FROM tariffs WHERE id = ?').get(cl.tariffId); if (t && t.price > 0) return t.price; } catch (_) {}
    }
    return cl ? cl.price : 0;
  }
  const perGbClients = trafficRows.filter(r => {
    const cl = Array.from(clientById.values()).find(c => c.portName === r.client_name);
    return cl && cl.billingType === 'per_gb';
  });
  if (perGbClients.length) {
    lines.push('per_gb клиенты:');
    for (const r of perGbClients.slice(0, 5)) {
      const cl = Array.from(clientById.values()).find(c => c.portName === r.client_name);
      const cost = (r.bytes / 1e9) * effectivePrice(cl);
      lines.push(`  • ${escHtml(trunc(cl ? cl.name : r.client_name, 32))}: ${fmtGb(r.bytes)} → ${fmtMoney(cost)}`);
    }
  }

  // ----- 2b) Пакеты операторов (2026-09-26): остаток + прогноз — то, ради
  // чего оператор открывает сводку, когда симки умирают от квоты.
  try {
    const pkgsRaw = getSetting('operator_packages', '[]');
    const pkgs = typeof pkgsRaw === 'string' ? JSON.parse(pkgsRaw || '[]') : pkgsRaw;
    if (Array.isArray(pkgs) && pkgs.length) {
      const { buildForecasts } = require('../jobs/volume-guard');
      const forecasts = buildForecasts(db, pkgs);
      const bundleRows = forecasts.filter(f => f.scope === 'package' && f.status !== 'unlimited' && f.status !== 'not_configured');
      const simRows = forecasts.filter(f => f.scope === 'sim');
      if (bundleRows.length || simRows.length) {
        lines.push('');
        lines.push('📦 <b>Пакеты операторов</b>');
        for (const f of bundleRows) {
          const pct = f.package_gb > 0 ? Math.round(f.used_gb / f.package_gb * 100) : 0;
          // 2026-09-26: прогноз ОТНОСИТЕЛЬНО конца отчётного периода
          // (reset_date из настроек оператора), а не «хватит до 2027» —
          // оператору важно: доживёт ли пакет до обнуления.
          let left;
          if (f.days_left == null) {
            left = 'расхода нет';
          } else if (f.reset_date && f.full_date && f.full_date > f.reset_date) {
            left = `до обнуления (${f.reset_date}) хватит`;
          } else if (f.full_date) {
            const gap = f.reset_date ? Math.max(0, Math.round((Date.parse(f.reset_date) - Date.parse(f.full_date)) / 86400000)) : null;
            left = `кончится ${f.full_date}` + (gap != null ? ` (за ${gap} дн. до обнуления)` : '');
          } else {
            left = 'расхода нет';
          }
          lines.push(`• ${escHtml(f.operator)}: <b>${Math.round(f.used_gb).toLocaleString('ru-RU')} / ${Math.round(f.package_gb).toLocaleString('ru-RU')} ГБ</b> (${pct}%), темп ${f.gb_day} ГБ/сут — ${left}`);
        }
        if (simRows.length) {
          const hot = simRows.filter(s => s.package_gb > 0 && s.used_gb / s.package_gb >= 0.8)
            .sort((a, b) => (b.used_gb / b.package_gb) - (a.used_gb / a.package_gb));
          const total = simRows.length;
          if (hot.length) {
            lines.push(`• ${escHtml(hot[0].operator)} (на симку): <b>${hot.length} из ${total}</b> симок >80% пакета — ближе всех: ${hot.slice(0, 3).map(s => `${escHtml(s.nick)} (${Math.round(s.used_gb / s.package_gb * 100)}%)`).join(', ')}`);
          } else {
            const resetDate = simRows[0].reset_date;
            lines.push(`• ${escHtml(simRows[0].operator)} (на симку): все ${total} симок &lt;80% пакета` + (resetDate ? ` (обнуление ${resetDate})` : ''));
          }
        }
      }
    }
  } catch (e) {
    if (logger && logger.warn) logger.warn('[DailySummary] packages block failed: ' + (e.message || e));
  }

  // ----- 2c) Ревизия пакетов за месяц (03.10): включается в сводку за
  // ПОСЛЕДНИЙ день месяца — факт потребления vs оплаченный бандл, чтобы
  // 1-го числа было чем руководствоваться при пересмотре пакетов у операторов.
  try {
    const dayD = new Date(date + 'T12:00:00');
    const nextD = new Date(dayD.getFullYear(), dayD.getMonth(), dayD.getDate() + 1);
    if (nextD.getDate() === 1) {   // date — последний день месяца
      const pkgsRaw = getSetting('operator_packages', '[]');
      const pkgs = typeof pkgsRaw === 'string' ? JSON.parse(pkgsRaw || '[]') : pkgsRaw;
      const bundles = (Array.isArray(pkgs) ? pkgs : []).filter(p => p && p.package_gb > 0);
      if (bundles.length) {
        const monthStart = date.slice(0, 7) + '-01';
        const usage = db.prepare(`
          SELECT LOWER(REPLACE(TRIM(operator), ' ', '')) AS op,
                 SUM(bytes_in + bytes_out) AS bytes
          FROM traffic_hourly
          WHERE hour_start >= ? AND hour_start < datetime(?, '+1 month')
            AND operator IS NOT NULL AND TRIM(operator) != ''
          GROUP BY op`).all(monthStart, monthStart);
        const byOp = {};
        for (const r of usage) byOp[r.op] = (byOp[r.op] || 0) + (r.bytes || 0);
        const daysInMonth = dayD.getDate();
        lines.push('');
        lines.push('💼 <b>Ревизия пакетов за ' + escHtml(fmtDateLong(date).replace(/^\d+ /, '')) + '</b>');
        for (const p of bundles) {
          const key = String(p.operator || '').toLowerCase().replace(/\s+/g, '');
          // пакет «на симку» — оценка по всем симкам оператора не складывается
          // в бандл: такие пропускаем, они в ежедневном блоке «на симку»
          if (p.scope === 'sim' || p.per_sim) continue;
          const used = byOp[key] || 0;
          const usedGb = used / 1e9;
          const pct = Math.round(usedGb / p.package_gb * 100);
          const verdict = pct < 60 ? '⬇️ переплата: можно уменьшить пакет'
            : pct <= 95 ? '✅ утилизация в норме'
            : '⚠️ на грани — расширить пакет к следующему периоду';
          lines.push(`• ${escHtml(p.operator)}: ${Math.round(usedGb).toLocaleString('ru-RU')} / ${Math.round(p.package_gb).toLocaleString('ru-RU')} ГБ (${pct}%), ~${(usedGb / daysInMonth).toFixed(1)} ГБ/сут — ${verdict}`);
        }
      }
    }
  } catch (e) {
    if (logger && logger.warn) logger.warn('[DailySummary] monthly package review failed: ' + (e.message || e));
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

  // 2026-09-26: не «кто хоть раз не ответил», а сколько МИНУТ реально лежал —
  // микро-столл панели (самолечение бокса) ≠ недоступность. <5 мин суммарно
  // за день — в сводку не попадает. Имена — отображаемые, не S-коды.
  let downLines = [];
  try {
    if (hasTable('server_downtime')) {
      const rows = db.prepare(`
        SELECT server_name, SUM(duration_sec) AS sec, COUNT(*) AS n
        FROM server_downtime
        WHERE down_from >= ? AND down_from < ?
        GROUP BY server_name ORDER BY sec DESC
      `).all(utcStart.toISOString(), utcEnd.toISOString());
      for (const r of rows) {
        const mins = Math.round((r.sec || 0) / 60);
        if (mins >= 5) downLines.push(`${escHtml(srvLabel(r.server_name))} — ${mins} мин (${r.n}×)`);
      }
    }
  } catch (e) {
    if (logger && logger.warn) logger.warn('[DailySummary] downtime query failed: ' + (e.message || e));
  }
  // Сервер, который «не отвечал» и НЕ восстановился за день (нет записи
  // downtime — пишется только при recovery): ≥5 событий unreachable за день
  // (≈5 мин подряд) — попадает в сводку как «не восстановился».
  const unrecovered = {};
  for (const e of infraEvents) {
    if (e.action === 'server_unreachable' && e.target) unrecovered[e.target] = (unrecovered[e.target] || 0) + 1;
  }
  try {
    if (hasTable('server_downtime')) {
      const withDt = new Set(db.prepare(`
        SELECT DISTINCT server_name FROM server_downtime WHERE down_from >= ? AND down_from < ?
      `).all(utcStart.toISOString(), utcEnd.toISOString()).map(r => r.server_name));
      for (const [srv, n] of Object.entries(unrecovered)) {
        if (n >= 5 && !withDt.has(srv)) downLines.push(`${escHtml(srvLabel(srv))} — не восстановился (${n} сбоев)`);
      }
    }
  } catch (_) {}
  // Ошибки системного лога за день — счётчик + топ причин (иначе «3 ошибки»
  // ни о чём не говорит).
  let errorCount = 0, topError = null;
  for (const e of infraEvents) {
    if (e.level === 'error' || e.level === 'critical') errorCount++;
  }
  if (errorCount) {
    const byAction = {};
    for (const e of infraEvents) {
      if (e.level === 'error' || e.level === 'critical') byAction[e.action || '?'] = (byAction[e.action || '?'] || 0) + 1;
    }
    topError = Object.entries(byAction).sort((a, b) => b[1] - a[1])[0];
  }

  // 09.10: «проблемные прокси» — по HTTP-чекам (реальный сигнал), а не по
  // ping_stats: канарейка ProxySmart (8.8.8.8) не обслуживает TCP:80 by
  // design, а порог «потери >10%» ловил 1 потерянный ICMP из 7 — штатное
  // поведение мобильной сети, метрика показывала десятки ложных «проблемных».
  // Считаем модем проблемным, если доля реальных фейлов чека >20% за день.
  let proxyIssues = [];
  try {
    proxyIssues = db.prepare(`
      SELECT server AS server_name, nick,
             SUM(CASE WHEN TRIM(COALESCE(error, '')) NOT IN ('', 'offline', 'rotating', 'no_valid_client_credentials', 'ambiguous_clone_imei') THEN 1 ELSE 0 END) AS failures,
             SUM(CASE WHEN TRIM(COALESCE(error, '')) NOT IN ('offline', 'rotating', 'no_valid_client_credentials', 'ambiguous_clone_imei') THEN 1 ELSE 0 END) AS total
      FROM modem_httpcheck
      WHERE ts >= ? AND ts < ?
      GROUP BY server, nick
      HAVING total >= 3 AND failures * 1.0 / total > 0.2
    `).all(isoStartStr, isoEndStr);
  } catch (e) {
    // минимальная схема без modem_httpcheck (тесты) — блок молча пропускаем
    if (logger && logger.warn) logger.warn('[DailySummary] proxy issues (httpcheck) query failed: ' + (e.message || e));
  }

  // Auto-reboots
  const rebootRow = db.prepare(`
    SELECT COUNT(*) as n,
           SUM(CASE WHEN status='success' THEN 1 ELSE 0 END) as ok
    FROM auto_reboot_log
    WHERE rebooted_at >= ? AND rebooted_at < ?
  `).get(utcStartStr, utcEndStr);

  lines.push('');
  lines.push('⚙️ <b>Инфраструктура</b>');
  if (downLines.length) lines.push(`Простои серверов: <b>${downLines.join(' · ')}</b>`);
  else lines.push('Все серверы доступны (простоев ≥5 мин не было)');
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
  // 2026-09-26: дельта к вчера — «35» без контекста ни о чём не говорит.
  let issuesDelta = '';
  try {
    let prevN = 0;
    try {
      const prevRow = db.prepare(`
        SELECT COUNT(*) AS n FROM (
          SELECT server, nick FROM modem_httpcheck
          WHERE ts >= ? AND ts < ?
            AND TRIM(COALESCE(error, '')) NOT IN ('offline', 'rotating', 'no_valid_client_credentials', 'ambiguous_clone_imei')
          GROUP BY server, nick
          HAVING COUNT(*) >= 3
             AND SUM(CASE WHEN TRIM(COALESCE(error, '')) != '' THEN 1 ELSE 0 END) * 1.0 / COUNT(*) > 0.2
        )
      `).get(
        new Date(utcStart.getTime() - 86400000).toISOString(),
        isoStartStr
      );
      prevN = (prevRow && prevRow.n) || 0;
    } catch (_) { /* минимальная схема без таблицы */ }
    const d = proxyIssues.length - prevN;
    issuesDelta = d === 0 ? ' (= вчера)' : d > 0 ? ` (▲ +${d} к вчера)` : ` (▼ −${-d} к вчера)`;
  } catch (_) {}
  if (proxyIssues.length) lines.push(`Проблемных прокси: ${proxyIssues.length} (доля фейлов http-чека >20%)${issuesDelta}`);
  if (rebootRow && rebootRow.n > 0) lines.push(`Авто-перезагрузок: ${rebootRow.n} (успешных ${rebootRow.ok}/${rebootRow.n})`);
  if (errorCount) lines.push(`Ошибок в системном логе: ${errorCount}${topError ? ` (чаще всего: ${escHtml(topError[0])} ×${topError[1]})` : ''}`);
  // Correlated incidents are the useful overnight signal: one operator/server
  // episode instead of dozens of modem cards.
  try {
    const incidents = hasTable('monitoring_incidents') ? db.prepare(`SELECT state,server,operator,opened_at,closed_at,duration_sec,modem_count,client_count
      FROM monitoring_incidents WHERE opened_at >= ? AND opened_at < ? ORDER BY opened_at`).all(utcStart.toISOString(), utcEnd.toISOString()) : [];
    if (incidents.length) {
      // 2026-09-26: микро-эпизоды (<3 мин) — флапы групп, а не инциденты;
      // в список — только значимые, флапы свёрнуты в счётчик.
      const flaps = incidents.filter(i => (i.duration_sec || 0) < 180);
      const real = incidents.filter(i => (i.duration_sec || 0) >= 180);
      if (real.length) {
        lines.push(`Инцидентов: <b>${real.length}</b>` + (flaps.length ? ` · ещё ${flaps.length} флапов (&lt;3 мин, скрыты)` : ''));
        for (const it of real.slice(0, 8)) {
          const state = it.state === 'closed' ? `закрыт за ${Math.max(1, Math.round((it.duration_sec || 0) / 60))} мин` : 'ещё открыт';
          lines.push(`  • ${escHtml(it.operator || 'общая связь')} · ${escHtml(srvLabel(it.server))} — ${it.modem_count} мод., ${it.client_count} кл. · ${state}`);
        }
      } else if (flaps.length) {
        lines.push(`Значимых инцидентов не было; групповых флапов (&lt;3 мин): ${flaps.length}`);
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
          // 2026-09-26: пары «модем оффлайн» + «вернулся» — это флапы, а не
          // две строки одинакового веса. Сворачиваем их в одну.
          const FLAP_RULES = new Set(['modem_offline_20m', 'modem_recovered', 'modem_ping_dead', 'modem_ping_recovered', 'modem_http_fail', 'modem_http_recovered']);
          const flapCount = quietRows.filter(r => FLAP_RULES.has(r.rule_id)).reduce((s, r) => s + Number(r.n || 0), 0);
          const rest = quietRows.filter(r => !FLAP_RULES.has(r.rule_id));
          const restTotal = rest.reduce((s, r) => s + Number(r.n || 0), 0);
          lines.push(`Ночью без Telegram: <b>${quietTotal}</b> некритичных событий (они сохранены в колокольчике)`);
          if (flapCount) lines.push(`  • модемы моргали ночью (оффлайн/вернулся): ${flapCount} событий`);
          for (const row of rest) lines.push(`  • ${escHtml(row.title || row.rule_id)} — ${row.n}`);
          void restTotal;
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
    `).get(atStartStr, atEndStr);
  } catch (e) {
    // Rule (OPERATIONS.md): деградация через catch обязана писать warn.
    if (logger && logger.warn) logger.warn('[DailySummary] rotation_log query failed (rotations block degraded): ' + (e.message || e));
  }

  if (rotRow && rotRow.total > 0) {
    // 2026-09-26: % неуспешных с дельтой к вчера — рост процента и есть сигнал.
    let rotDelta = '';
    try {
      const prevRot = db.prepare(`
        SELECT COUNT(*) AS total, SUM(CASE WHEN old_ip = new_ip AND new_ip IS NOT NULL THEN 1 ELSE 0 END) AS failed
        FROM rotation_log WHERE started_at >= ? AND started_at < ?
      `).get(new Date(new Date(date + 'T00:00:00Z').getTime() - 86400000).toISOString().slice(0, 10) + '@00:00:00', atStartStr);
      if (prevRot && prevRot.total > 0) {
        const prevPct = (prevRot.failed * 100) / prevRot.total;
        const d = ((rotRow.failed * 100) / rotRow.total) - prevPct;
        rotDelta = ` (${d >= 0 ? '▲' : '▼'} ${Math.abs(d).toFixed(1)} п.п. к вчера)`;
      }
    } catch (_) {}
    lines.push('');
    lines.push('🔄 <b>Ротации</b>');
    lines.push(`Всего: ${rotRow.total}, неуспешных: ${rotRow.failed} (${(rotRow.failed*100/rotRow.total).toFixed(1)}%)${rotDelta}`);
    if (rotRow.avg_sec) lines.push(`Среднее время: ${rotRow.avg_sec.toFixed(1)} сек`);

    // 2026-09-26: разбивка по операторам + «застрявшие» симки. Норма —
    // ≤20% неуспешных; исключения задаются настройкой rotation_fail_norm
    // (JSON {"default":20,"exceptions":{"Vodafone RO":80}}). Vodafone RO
    // редко меняет IP — это норма, поэтому у него порог выше.
    try {
      const normCfg = { default: 20, exceptions: { 'Vodafone RO': 80 } };
      const rawNorm = getSetting && getSetting('rotation_fail_norm', null);
      if (rawNorm) {
        try {
          const parsed = typeof rawNorm === 'string' ? JSON.parse(rawNorm) : rawNorm;
          if (parsed && typeof parsed === 'object') {
            if (Number.isFinite(+parsed.default)) normCfg.default = +parsed.default;
            if (parsed.exceptions && typeof parsed.exceptions === 'object') Object.assign(normCfg.exceptions, parsed.exceptions);
          }
        } catch (_) {}
      }
      const normFor = (op) => {
        const ex = normCfg.exceptions;
        for (const k in ex) if (k.toLowerCase() === String(op || '').toLowerCase() && Number.isFinite(+ex[k])) return +ex[k];
        return normCfg.default;
      };
      const rotOps = db.prepare(`
        SELECT COALESCE(NULLIF(TRIM(m.operator), ''), 'unknown') AS operator,
               COUNT(*) AS total,
               SUM(CASE WHEN r.old_ip = r.new_ip AND r.new_ip IS NOT NULL THEN 1 ELSE 0 END) AS failed
        FROM rotation_log r
        LEFT JOIN modem_meta m ON m.server_name = r.server_name AND m.nick = r.nick
        WHERE r.started_at >= ? AND r.started_at < ?
        GROUP BY operator
        ORDER BY total DESC
      `).all(atStartStr, atEndStr);
      const flagged = rotOps.filter(o => o.total >= 10 && (o.failed * 100 / o.total) > normFor(o.operator));
      if (flagged.length) {
        lines.push('⚠️ Неуспешные по операторам: ' + flagged.map(o =>
          `${escHtml(o.operator)} ${(o.failed * 100 / o.total).toFixed(0)}% (${o.failed}/${o.total}, норма ≤${normFor(o.operator)}%)`
        ).join(', '));
      }
      // Симки, у которых IP не меняется всю неделю (≥10 попыток, ≥80% фейлов)
      // — показываем даже если за день аномалий нет: это хроника, не разовость.
      const stuckRows = db.prepare(`
        SELECT r.server_name, r.nick,
               COUNT(*) AS total,
               SUM(CASE WHEN r.old_ip = r.new_ip AND r.new_ip IS NOT NULL THEN 1 ELSE 0 END) AS failed
        FROM rotation_log r
        WHERE r.started_at >= ? AND r.started_at < ?
        GROUP BY r.server_name, r.nick
        HAVING total >= 10 AND failed * 1.0 / total >= 0.8
        ORDER BY failed DESC
      `).all(new Date(new Date(date + 'T00:00:00Z').getTime() - 6 * 86400000).toISOString().slice(0, 10) + '@00:00:00', atEndStr);
      // 09.10: свободные модемы (без единого клиентского порта) в список не
      // берём — их застрявший IP никому не мешает, а строка путает (MD_17/18/19).
      const stuckSims = (modemHasClient
        ? stuckRows.filter(s => modemHasClient(s.server_name, s.nick))
        : stuckRows
      ).slice(0, 5);
      if (stuckSims.length) {
        lines.push('🔴 Симки без смены IP (7 дн): ' + stuckSims.map(s => `${escHtml(s.nick)} — ${s.failed}/${s.total}`).join(', '));
      }
    } catch (e) {
      if (logger && logger.warn) logger.warn('[DailySummary] rotation per-operator block failed (degraded): ' + (e.message || e));
    }
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
