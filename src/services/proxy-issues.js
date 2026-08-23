'use strict';
//
// src/services/proxy-issues.js — computeProxyIssues: агрегация штатного
// ProxySmart ping_stats за окно и список модемов с высокой задержкой/потерями.
// Extracted from server.js (Stage 9) — без изменения логики. Потребители:
// /api/admin/data (карточка проблем) и runAutoReboot.

function create(deps) {
  const { db, appSettings, logger } = deps;

  function computeProxyIssues() {
    try {
      const winMin   = Math.max(5, Math.min(720, appSettings.proxy_alert_window_min || 60));
      const latLimit = Math.max(100, Math.min(60000, appSettings.proxy_alert_latency_ms || 1500));
      const errLimit = Math.max(0, Math.min(100, appSettings.proxy_alert_error_pct || 5));
      const since = new Date(Date.now() - winMin * 60000).toISOString();

      const checkRows = db.prepare(`
        SELECT p.server AS server_name, p.nick,
               AVG(p.latency_ms) FILTER (WHERE p.ok = 1 AND p.latency_ms IS NOT NULL) AS avg_ms,
               COUNT(*) AS total,
               AVG(COALESCE(p.loss_pct, CASE WHEN p.ok = 1 THEN 0 ELSE 100 END)) AS avg_loss,
               SUM(CASE WHEN p.ok = 0 THEN 1 ELSE 0 END) AS errors,
               COALESCE((SELECT json_extract(k.data, '$.portName')
                         FROM known_modems k
                         WHERE k.server_name = p.server
                           AND json_extract(k.data, '$.nick') = p.nick
                           AND COALESCE(json_extract(k.data, '$.portName'), '') <> ''
                         ORDER BY k.updated_at DESC LIMIT 1), '') AS client_name,
               COALESCE((SELECT m.operator FROM modem_meta m
                         WHERE m.server_name = p.server AND m.nick = p.nick
                         ORDER BY m.updated_at DESC LIMIT 1), '') AS operator
          FROM modem_ping p
         WHERE p.ts >= ?
         GROUP BY p.server, p.nick
      `).all(since);

      const issues = [];
      for (const c of checkRows) {
        const errPct  = c.avg_loss != null ? Math.round(Number(c.avg_loss) * 10) / 10 : 0;
        const latency = c.avg_ms != null ? Math.round(c.avg_ms) : null;
        const reasons = [];
        if (latency != null && latency > latLimit) reasons.push(`задержка ${latency}мс`);
        if (errPct > errLimit) reasons.push(`потери ${errPct}%`);
        if (reasons.length === 0) continue;
        issues.push({
          nick: c.nick,
          server: c.server_name,
          operator: c.operator || '',
          client: c.client_name || '',
          latency,
          errorPct: errPct,
          reasons,
          detail: reasons.join(' · ')
        });
      }
      issues.sort((a, b) => b.reasons.length - a.reasons.length || (b.errorPct - a.errorPct));
      return issues;
    } catch (e) {
      logger.error('[proxyIssues]', e.message);
      return [];
    }
  }

  return { computeProxyIssues };
}

module.exports = { create };
