'use strict';
//
// src/jobs/shadow-billing.js — теневой тест тарификации (Фаза 0, §2 ТЗ).
//
// ShadowBilling (ежедневно 01:10 UTC, сразу за DailyBilling): для каждого
// активного per_gb клиента считает два варианта списания за вчерашнюю
// МСК-дату и пишет сравнение в billing_shadow_log. НИЧЕГО не списывает —
// ни ledger, ни балансы клиентов не трогаются.
//   V1 (legacy, прод сейчас): gb_v1 = MAX(gb_durable, gb_live), rub = gb × price
//   V2 (канон):               gb_v2 = gb_durable; если hours_present < 20 →
//                               gb_v2 = gb_live, fallback_used = 1
// gb_durable — тем же кодом, что боевой durable-путь billing.js
// (getClientBytesForMskDate: Σ traffic_hourly → фолбэк daily_traffic);
// hours_present / gb_uncertain — голым SQL по traffic_hourly.
//
// ShadowBillingWeekly (понедельник 06:00 UTC = 09:00 МСК): сводка за 7 дней
// в TG-канал алертов — Σ rub_v1 / Σ rub_v2 / Δ%, топ-10 расхождений,
// fallback-срабатывания, доля uncertain-ГБ (критерии перехода §2.2).

function create(deps) {
  const {
    db, logger, logActivity,
    fetchAllServersData,
    getMoscowYesterday, getMoscowNow,
    trafficDb,
    getClientBytesForMskDate, computeClientYesterdayBytes, trafficBytesToGb,
    clients,
    appSettings, tgBot,
    getSetting,   // WP5: токен — enc1: в kv, читаем через getSetting
  } = deps;

  const upsertStmt = db.prepare(`INSERT INTO billing_shadow_log
    (date, client_id, hours_present, gb_durable, gb_uncertain, gb_live, gb_v1, rub_v1, gb_v2, rub_v2, fallback_used)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(date, client_id) DO UPDATE SET
      hours_present = excluded.hours_present,
      gb_durable    = excluded.gb_durable,
      gb_uncertain  = excluded.gb_uncertain,
      gb_live       = excluded.gb_live,
      gb_v1         = excluded.gb_v1,
      rub_v1        = excluded.rub_v1,
      gb_v2         = excluded.gb_v2,
      rub_v2        = excluded.rub_v2,
      fallback_used = excluded.fallback_used,
      created_at    = datetime('now')`);

  function round2(x) { return Math.round(x * 100) / 100; }

  // Те же фильтры, что у DailyBilling (billing.js): без portName, без цены /
  // цена ≤ 0, billingPaused — плюс per_modem исключены (флэт, трафик не влияет).
  function isShadowBillable(client) {
    if (!client.portName || !client.price || client.price <= 0 || client.billingPaused) return false;
    if (client.billingType === 'per_modem') return false;
    return true;
  }

  async function runShadowBilling() {
    const yesterdayStr = getMoscowYesterday();
    logger.info(`[ShadowBilling] Starting shadow run for ${yesterdayStr}...`);
    logActivity('billing', 'info', 'shadow_billing_start', null, `Shadow billing run for ${yesterdayStr}`);

    let results;
    try {
      results = await fetchAllServersData();
    } catch (e) {
      logger.error('[ShadowBilling] Failed to fetch server data:', e.message);
      logActivity('billing', 'error', 'shadow_billing_error', null, `Fetch failed: ${e.message}`);
      return { date: yesterdayStr, error: e.message };
    }

    let written = 0, skipped = 0;
    for (const client of clients) {
      if (!isShadowBillable(client)) { skipped++; continue; }
      try {
        // Боевой durable-путь (включая внутренний фолбэк на daily_traffic)
        const durableBytes = getClientBytesForMskDate(client.portName, yesterdayStr);
        // Голый traffic_hourly за ту же дату: покрытие по часам + uncertain-доля
        const stats = trafficDb.hourlyShadowByClientDateStmt().get(client.portName, yesterdayStr)
          || { durable_bytes: 0, uncertain_bytes: 0, hours_present: 0 };
        const liveBytes = computeClientYesterdayBytes(results, client.portName);

        const gbDurable = trafficBytesToGb(durableBytes);
        const gbUncertain = trafficBytesToGb(stats.uncertain_bytes);
        const gbLive = trafficBytesToGb(liveBytes);
        const hoursPresent = stats.hours_present || 0;

        const gbV1 = Math.max(gbDurable, gbLive);
        const rubV1 = round2(gbV1 * client.price);
        let gbV2 = gbDurable, fallbackUsed = 0;
        if (hoursPresent < 20) { gbV2 = gbLive; fallbackUsed = 1; }
        const rubV2 = round2(gbV2 * client.price);

        upsertStmt.run(yesterdayStr, client.id, hoursPresent,
          gbDurable, gbUncertain, gbLive, gbV1, rubV1, gbV2, rubV2, fallbackUsed);
        written++;
      } catch (e) {
        logger.error(`[ShadowBilling] Error for ${client.name}:`, e.message);
        logActivity('billing', 'error', 'shadow_billing_error', client.name,
          `Shadow billing error: ${e.message}`, { client_id: client.id });
      }
    }

    logger.info(`[ShadowBilling] Complete: ${written} rows for ${yesterdayStr}, ${skipped} skipped`);
    logActivity('billing', 'info', 'shadow_billing_complete', null,
      `Shadow billing: ${written} rows for ${yesterdayStr}, ${skipped} skipped`,
      { written, skipped, date: yesterdayStr });
    return { date: yesterdayStr, written, skipped };
  }

  async function runShadowBillingWeekly() {
    // scheduleRepeating не умеет день недели — проверяем внутри (как
    // MonthlyReconciliation проверяет 1-е число). Понедельник по МСК.
    if (getMoscowNow().getDay() !== 1) return { skipped: 'not_monday' };

    const weekStartDate = getMoscowNow();
    weekStartDate.setDate(weekStartDate.getDate() - 7);
    const weekStart = weekStartDate.toLocaleDateString('en-CA'); // "YYYY-MM-DD"

    const totals = db.prepare(`
      SELECT COUNT(*)                  AS rows,
             SUM(rub_v1)               AS week_v1,
             SUM(rub_v2)               AS week_v2,
             SUM(ABS(rub_v1 - rub_v2)) AS week_abs_diff,
             SUM(fallback_used)        AS fallbacks,
             SUM(gb_uncertain)         AS gb_uncertain,
             SUM(gb_durable)           AS gb_durable
        FROM billing_shadow_log
       WHERE date >= ?`).get(weekStart);

    if (!totals || !totals.rows) {
      logger.info('[ShadowBillingWeekly] No shadow rows for the last 7 days, nothing to report');
      return { skipped: 'no_data' };
    }

    const top = db.prepare(`
      SELECT client_id,
             SUM(rub_v1)               AS rub_v1,
             SUM(rub_v2)               AS rub_v2,
             SUM(ABS(rub_v1 - rub_v2)) AS abs_diff
        FROM billing_shadow_log
       WHERE date >= ?
       GROUP BY client_id
       ORDER BY abs_diff DESC
       LIMIT 10`).all(weekStart);

    const weekV1 = totals.week_v1 || 0;
    const weekV2 = totals.week_v2 || 0;
    // Δ% — по формуле A.5: Σ|rub_v1 − rub_v2| / Σ rub_v1 × 100
    const diffPct = weekV1 > 0 ? round2(totals.week_abs_diff / weekV1 * 100) : null;
    const uncertainShare = totals.gb_durable > 0
      ? round2(totals.gb_uncertain / totals.gb_durable * 100) : null;

    const clientName = (id) => {
      const c = clients.find(x => x.id === id);
      return c ? c.name : id;
    };
    const lines = [
      `📊 <b>Теневой биллинг — итог 7 дней</b> (с ${weekStart})`,
      ``,
      `Σ V1 (legacy): <b>${round2(weekV1)} ₽</b>`,
      `Σ V2 (канон):  <b>${round2(weekV2)} ₽</b>`,
      `Δ: ${round2(totals.week_abs_diff)} ₽ (${diffPct === null ? '—' : diffPct + '%'})`,
      `Fallback-срабатываний (hours<20): ${totals.fallbacks || 0}`,
      `Uncertain: ${round2(totals.gb_uncertain || 0)} ГБ (${uncertainShare === null ? '—' : uncertainShare + '%'} от durable)`,
    ];
    if (top.length > 0 && top[0].abs_diff > 0) {
      lines.push(``, `Топ расхождений:`);
      for (const t of top) {
        if (!(t.abs_diff > 0)) break;
        lines.push(`• ${clientName(t.client_id)}: V1 ${round2(t.rub_v1)} / V2 ${round2(t.rub_v2)} ₽ (Δ ${round2(t.abs_diff)})`);
      }
    }
    const text = lines.join('\n');

    const token = getSetting ? getSetting('telegram_bot_token', '') : appSettings.telegram_bot_token;
    const chatId = appSettings.telegram_chat_id;
    if (!token || !chatId) {
      logger.warn('[ShadowBillingWeekly] Telegram not configured (token/chat_id), report not sent');
      logActivity('billing', 'warn', 'shadow_weekly_skipped', null, 'Weekly shadow report: telegram not configured');
      return { skipped: 'no_telegram' };
    }
    const resp = await tgBot.sendMessage(token, chatId, text);
    if (resp && resp.ok === false) throw new Error('Telegram: ' + (resp.description || JSON.stringify(resp)));

    logger.info(`[ShadowBillingWeekly] Weekly shadow report sent (week from ${weekStart})`);
    logActivity('billing', 'info', 'shadow_weekly_sent', null,
      `Weekly shadow report: V1 ${round2(weekV1)}₽ vs V2 ${round2(weekV2)}₽ (Δ ${diffPct}%)`,
      { week_start: weekStart, week_v1: weekV1, week_v2: weekV2, diff_pct: diffPct, fallbacks: totals.fallbacks });
    return { sent: true, week_start: weekStart, week_v1: weekV1, week_v2: weekV2, diff_pct: diffPct };
  }

  return { runShadowBilling, runShadowBillingWeekly };
}

module.exports = { create };
