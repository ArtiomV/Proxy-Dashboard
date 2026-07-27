'use strict';
//
// src/services/proxy-issues.js — computeProxyIssues: агрегация proxy_checks
// за окно и список модемов с проблемами качества (latency/error% выше порогов).
// Extracted from server.js (Stage 9) — без изменения логики. Потребители:
// /api/admin/data (карточка проблем) и runAutoReboot.

function create(deps) {
  const { db, appSettings, logger } = deps;

  function computeProxyIssues() {
    try {
      const winMin   = Math.max(5, Math.min(720, appSettings.proxy_alert_window_min || 60));
      const latLimit = Math.max(100, Math.min(60000, appSettings.proxy_alert_latency_ms || 1500));
      const errLimit = Math.max(0, Math.min(100, appSettings.proxy_alert_error_pct || 5));
      const sinceExpr = `datetime('now', '-${winMin} minutes')`;

      const checkRows = db.prepare(`
        SELECT server_name, nick,
               AVG(total_ms) FILTER (WHERE error IS NULL) AS avg_ms,
               COUNT(*)                                  AS total,
               SUM(CASE WHEN error IS NOT NULL THEN 1 ELSE 0 END) AS errors,
               MAX(client_name)                          AS client_name,
               MAX(operator)                             AS operator
          FROM proxy_checks
         WHERE checked_at >= ${sinceExpr}
         GROUP BY server_name, nick
      `).all();

      const issues = [];
      for (const c of checkRows) {
        const errPct  = c.total > 0 ? Math.round(c.errors / c.total * 1000) / 10 : 0;
        const latency = c.avg_ms != null ? Math.round(c.avg_ms) : null;
        const reasons = [];
        if (latency != null && latency > latLimit) reasons.push(`задержка ${latency}мс`);
        if (errPct > errLimit) reasons.push(`ошибки ${errPct}%`);
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
