'use strict';

/**
 * Daily AI-driven operational analysis ("ОС за вчера").
 *
 * Pulls yesterday's metrics from SQLite, builds a compact JSON context,
 * sends to Claude (Opus 4.7 with adaptive thinking), and returns a
 * Russian-language HTML snippet to append to the daily Telegram summary.
 *
 * Design notes:
 *   - Single Claude call per day; ~once per 24h, so prompt caching wouldn't
 *     hit anyway (5-min TTL) — not configured.
 *   - Streaming used because adaptive thinking + analysis can push past
 *     non-stream SDK timeout on large input.
 *   - Graceful degradation: missing ANTHROPIC_API_KEY → returns null, daily
 *     summary still ships without AI section. Same for API errors.
 *   - Length-capped at ~3500 chars so the combined Telegram message
 *     stays under the 4096-char limit.
 *
 * Inputs (via init):
 *   db, logger, getSetting
 */

let Anthropic;
try { Anthropic = require('@anthropic-ai/sdk').default; } catch (_) { Anthropic = null; }

let db, logger, getSetting;
let _client = null;
let _clientKey = null; // for hot-reload if key changes via UI

function init(deps) {
  db = deps.db;
  logger = deps.logger;
  getSetting = deps.getSetting;
}

function _getClient() {
  if (!Anthropic) return null;
  const key = process.env.ANTHROPIC_API_KEY || getSetting('anthropic_api_key', '');
  if (!key) return null;
  if (_client && _clientKey === key) return _client;
  _client = new Anthropic({ apiKey: key });
  _clientKey = key;
  return _client;
}

// ─── Context building ──────────────────────────────────────────────────────────
// MSK day [date 00:00, date 24:00) = UTC [(date-1) 21:00, date 21:00).
// Mirrors daily_summary.js so AI analysis covers the exact same window the
// human-facing summary describes.
function _mskBoundaries(date) {
  const utcStart = new Date(date + 'T00:00:00Z'); utcStart.setUTCHours(utcStart.getUTCHours() - 3);
  const utcEnd   = new Date(date + 'T00:00:00Z'); utcEnd.setUTCHours(utcEnd.getUTCHours() + 21);
  return {
    from: utcStart.toISOString().slice(0, 19).replace('T', ' '),
    to:   utcEnd.toISOString().slice(0, 19).replace('T', ' '),
    fromIso: utcStart.toISOString(),
    toIso: utcEnd.toISOString(),
  };
}

// Build the structured day-context that Claude will reason over.
// Aim: compact (a few KB), specific (named servers, percentages), no raw rows.
function buildDayContext(date) {
  const b = _mskBoundaries(date);
  const ctx = { date, period: { from_msk: date + ' 00:00', to_msk: date + ' 24:00 MSK' } };

  // ── 1) Per-server health (the headline view)
  try {
    ctx.servers = db.prepare(`
      WITH active AS (
        SELECT DISTINCT server_name FROM proxy_checks WHERE checked_at >= ? AND checked_at < ?
        UNION
        SELECT DISTINCT server_name FROM traffic_hourly WHERE hour_start >= ? AND hour_start < ?
      ),
      checks AS (
        SELECT server_name,
               COUNT(*) AS total_checks,
               SUM(CASE WHEN error IS NOT NULL THEN 1 ELSE 0 END) AS err_checks,
               ROUND(AVG(CASE WHEN error IS NULL THEN total_ms END), 0) AS avg_total_ms,
               ROUND(AVG(CASE WHEN error IS NULL THEN connect_ms END), 0) AS avg_connect_ms
        FROM proxy_checks
        WHERE checked_at >= ? AND checked_at < ?
        GROUP BY server_name
      ),
      traffic AS (
        SELECT server_name, SUM(bytes_in + bytes_out) AS bytes
        FROM traffic_hourly
        WHERE hour_start >= ? AND hour_start < ?
        GROUP BY server_name
      ),
      rotations AS (
        SELECT server_name,
               COUNT(*) AS total,
               SUM(CASE WHEN old_ip = new_ip THEN 1 ELSE 0 END) AS failed,
               ROUND(AVG(took_sec), 1) AS avg_sec
        FROM rotation_log
        WHERE started_at >= ? AND started_at < ? AND ended_at IS NOT NULL
        GROUP BY server_name
      )
      SELECT a.server_name,
             c.total_checks, c.err_checks, c.avg_total_ms, c.avg_connect_ms,
             t.bytes,
             r.total AS rot_total, r.failed AS rot_failed, r.avg_sec AS rot_avg_sec
      FROM active a
      LEFT JOIN checks c ON c.server_name = a.server_name
      LEFT JOIN traffic t ON t.server_name = a.server_name
      LEFT JOIN rotations r ON r.server_name = a.server_name
      ORDER BY a.server_name
    `).all(b.fromIso, b.toIso, b.from, b.to, b.fromIso, b.toIso, b.from, b.to, b.fromIso, b.toIso).map(r => ({
      server: r.server_name,
      checks: { total: r.total_checks || 0, errors: r.err_checks || 0,
                error_pct: r.total_checks > 0 ? Math.round(r.err_checks / r.total_checks * 1000) / 10 : 0 },
      latency: { total_ms: r.avg_total_ms, connect_ms: r.avg_connect_ms },
      traffic_gb: r.bytes ? Math.round(r.bytes / 1e9 * 100) / 100 : 0,
      rotations: r.rot_total
        ? { total: r.rot_total, failed: r.rot_failed,
            failed_pct: Math.round(r.rot_failed / r.rot_total * 1000) / 10,
            avg_sec: r.rot_avg_sec }
        : null,
    }));
  } catch (e) { logger.warn('[AIInsights] servers query: ' + e.message); ctx.servers = []; }

  // ── 2) Top outlier modems (high latency OR high errors) — capped at 15
  try {
    ctx.problem_modems = db.prepare(`
      SELECT server_name, nick,
             COALESCE(operator, '') AS operator,
             COUNT(*) AS total,
             SUM(CASE WHEN error IS NOT NULL THEN 1 ELSE 0 END) AS errors,
             ROUND(AVG(CASE WHEN error IS NULL THEN total_ms END), 0) AS avg_ms
      FROM proxy_checks
      WHERE checked_at >= ? AND checked_at < ?
      GROUP BY server_name, nick
      HAVING (errors * 100.0 / total > 15) OR (avg_ms > 1500)
      ORDER BY errors DESC, avg_ms DESC
      LIMIT 15
    `).all(b.fromIso, b.toIso).map(r => ({
      modem: r.nick, server: r.server_name, operator: r.operator,
      checks: r.total, errors: r.errors,
      error_pct: Math.round(r.errors / r.total * 1000) / 10,
      avg_latency_ms: r.avg_ms,
    }));
  } catch (e) { logger.warn('[AIInsights] modems query: ' + e.message); ctx.problem_modems = []; }

  // ── 3) Critical system events
  try {
    const errLog = db.prepare(`
      SELECT category, action, target, message, level
      FROM system_log
      WHERE timestamp >= ? AND timestamp < ?
        AND level IN ('error', 'critical', 'warn')
      ORDER BY timestamp DESC LIMIT 30
    `).all(b.from, b.to);
    // Roll up by (action, level) so a noisy hourly job doesn't dominate the prompt.
    const rollup = {};
    for (const r of errLog) {
      const key = r.level + ':' + r.action;
      if (!rollup[key]) rollup[key] = { level: r.level, action: r.action, count: 0, sample: r.message, targets: new Set() };
      rollup[key].count++;
      if (r.target) rollup[key].targets.add(r.target);
    }
    ctx.events = Object.values(rollup).map(e => ({
      level: e.level, action: e.action, count: e.count,
      targets: Array.from(e.targets).slice(0, 5),
      sample: (e.sample || '').slice(0, 200),
    }));
  } catch (e) { logger.warn('[AIInsights] events query: ' + e.message); ctx.events = []; }

  // ── 4) Traffic top-N clients with day-over-day delta vs trailing 7-day median
  try {
    const yest = db.prepare(`
      SELECT client_name, SUM(bytes_in + bytes_out) AS bytes
      FROM traffic_hourly
      WHERE hour_start >= ? AND hour_start < ? AND client_name != ''
      GROUP BY client_name
      ORDER BY bytes DESC LIMIT 10
    `).all(b.from, b.to);
    // 7-day trailing median per client
    const baselineFrom = new Date(b.fromIso); baselineFrom.setUTCDate(baselineFrom.getUTCDate() - 7);
    const baseline = db.prepare(`
      SELECT client_name, substr(hour_start, 1, 10) AS day, SUM(bytes_in + bytes_out) AS bytes
      FROM traffic_hourly
      WHERE hour_start >= ? AND hour_start < ? AND client_name != ''
      GROUP BY client_name, day
    `).all(baselineFrom.toISOString().slice(0, 19).replace('T', ' '), b.from);
    const baseByClient = {};
    for (const r of baseline) {
      (baseByClient[r.client_name] = baseByClient[r.client_name] || []).push(r.bytes);
    }
    function median(arr) { if (!arr.length) return 0; const s = arr.slice().sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; }
    ctx.traffic_top = yest.map(r => {
      const med = median(baseByClient[r.client_name] || []);
      return {
        client: r.client_name,
        gb_yesterday: Math.round(r.bytes / 1e9 * 100) / 100,
        gb_median_7d: Math.round(med / 1e9 * 100) / 100,
        delta_pct: med > 0 ? Math.round((r.bytes - med) / med * 100) : null,
      };
    });
  } catch (e) { logger.warn('[AIInsights] traffic query: ' + e.message); ctx.traffic_top = []; }

  // ── 5) Trend: compare yesterday's overall checks/errors vs trailing 7-day avg
  try {
    const baselineFrom = new Date(b.fromIso); baselineFrom.setUTCDate(baselineFrom.getUTCDate() - 7);
    const trend = db.prepare(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN error IS NOT NULL THEN 1 ELSE 0 END) AS errors,
        ROUND(AVG(CASE WHEN error IS NULL THEN total_ms END), 0) AS avg_ms
      FROM proxy_checks
      WHERE checked_at >= ? AND checked_at < ?
    `).get(baselineFrom.toISOString(), b.fromIso);
    if (trend && trend.total) {
      const days = 7;
      ctx.baseline_7d = {
        avg_daily_checks: Math.round(trend.total / days),
        avg_daily_errors: Math.round(trend.errors / days),
        baseline_error_pct: Math.round(trend.errors / trend.total * 1000) / 10,
        baseline_avg_ms: trend.avg_ms,
      };
    }
  } catch (e) { logger.warn('[AIInsights] trend query: ' + e.message); }

  return ctx;
}

// ─── Claude call ────────────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `Ты — старший аналитик инфраструктуры прокси-сервиса proxies.rent.

Сервис управляет SIM-модемами в России, Молдове и Румынии (серверы S1, S2, S3, S4 и др.).
Каждый модем ротирует внешний IP по расписанию и обслуживает трафик платных клиентов.

Твоя задача — ежедневно анализировать сводку за прошедший день и писать в Telegram операционной команде короткую обратную связь («ОС за вчера»).

Требования к ответу:
- Язык: русский, дружелюбный профессиональный тон.
- Длина: до 3500 символов (ограничение Telegram).
- HTML-разметка для Telegram: <b>жирный</b>, <i>курсив</i>, переносы строк, маркер «•» для списков.
- Структура:
  🔍 <b>ИИ-анализ за день</b>
  <b>🎯 Главное</b> — 1-2 предложения про самое важное (победа или проблема).
  <b>⚠️ Требует внимания</b> — конкретные проблемы с цифрами и локациями. Если ничего критичного — напиши «всё в норме» честно.
  <b>💡 Рекомендации</b> — 2-3 действия, что сделать дальше.
- Будь конкретным: называй серверы, модемы, проценты. НЕ «некоторые серверы проблемные», А «S1 (Молдова) — средняя задержка 1850мс при норме <500мс».
- Игнорируй шум: мелкие колебания одного модема — нормально. Сигнал — повторяющийся паттерн, целиком сервер, аномальный сдвиг трафика, всплеск ошибок.
- Сравнивай с baseline_7d если он есть — это даёт контекст «хуже/лучше обычного».
- Если данных мало (<100 проверок за день), скажи об этом и не выдумывай выводы.
- НЕ повторяй сводку из вышестоящего блока — давай ИНТЕРПРЕТАЦИЮ.`;

async function generateInsights(date) {
  const client = _getClient();
  if (!client) {
    logger.info('[AIInsights] Skipped: no ANTHROPIC_API_KEY configured (env or setting "anthropic_api_key")');
    return null;
  }
  const ctx = buildDayContext(date);
  if (!ctx.servers || ctx.servers.length === 0) {
    logger.info('[AIInsights] Skipped: no server activity for ' + date);
    return null;
  }
  const userPrompt = `Данные за ${date} (МСК):\n\n` + JSON.stringify(ctx, null, 2);

  try {
    let text = '';
    // Stream so adaptive thinking + analysis don't trip the non-stream SDK timeout.
    //
    // max_tokens budget: adaptive thinking + effort=high can spend
    // 10–25K tokens on internal reasoning before producing any text. The
    // old 4000 cap meant the model exhausted its budget mid-thought and
    // returned an empty content[] — daily summaries silently dropped the
    // ИИ-анализ block. 32K leaves comfortable room for adaptive thinking
    // PLUS the ~1000 output tokens the final HTML snippet needs.
    const stream = await client.messages.stream({
      model: 'claude-opus-4-7',
      max_tokens: 32000,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'high' },
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userPrompt }],
    });
    const final = await stream.finalMessage();
    let thinkingChars = 0;
    for (const block of final.content) {
      if (block.type === 'text') text += block.text;
      else if (block.type === 'thinking') thinkingChars += (block.thinking || '').length;
    }
    text = text.trim();
    const usage = final.usage || {};
    if (!text) {
      // Empty text after adaptive thinking almost always means the model
      // hit max_tokens during reasoning — log enough context to confirm.
      logger.warn(
        `[AIInsights] Empty response for ${date}: ` +
        `stop_reason=${final.stop_reason} ` +
        `in=${usage.input_tokens} out=${usage.output_tokens} ` +
        `thinking_chars=${thinkingChars}. ` +
        `If stop_reason="max_tokens", raise max_tokens above ${32000}.`
      );
      return null;
    }
    // Hard cap so combined message fits Telegram's 4096 limit
    if (text.length > 3700) text = text.slice(0, 3650) + '\n…(обрезано)';
    logger.info(
      `[AIInsights] Generated ${text.length} chars for ${date} ` +
      `(stop=${final.stop_reason}, in=${usage.input_tokens}, out=${usage.output_tokens}, ` +
      `thinking_chars=${thinkingChars})`
    );
    return text;
  } catch (e) {
    // Most common failure modes: 401 (bad key), 429 (rate limit), 529 (overloaded).
    // Log status when available so admin can diagnose without scrolling pino noise.
    const status = e && (e.status || e.statusCode);
    const type = e && e.type;
    logger.error(
      `[AIInsights] Claude API error for ${date}: ` +
      (status ? `[${status}] ` : '') +
      (type ? `(${type}) ` : '') +
      (e.message || e)
    );
    return null;
  }
}

module.exports = { init, buildDayContext, generateInsights };
