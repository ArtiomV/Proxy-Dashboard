'use strict';
//
// src/services/proxy-issues.js — computeProxyIssues: список модемов с
// устойчивыми потерями штатного ProxySmart ping_stats. Потребители:
// /api/admin/data (один из сигналов единой плитки «Сбоит прокси») и
// runAutoReboot.
//
// FIX-05/06 + DEEP-12/13 (2026-09-18): единая модель свежести.
//   • Текущее состояние читается ТОЛЬКО из modem_ping_state (миграция 093):
//     missing/invalid там немедленно затирают прежний результат, поэтому
//     старая failed-строка истории больше не держит кандидата на reboot.
//     Исторические строки modem_ping без quality для текущего статуса и
//     reboot не используются (граница новой модели).
//   • Свежесть — общая политика src/services/ping-freshness.js: возраст от
//     measured_at/observed_at пересчитывается на каждом чтении, TTL общий
//     (ping_fresh_ttl_min, дефолт 10 мин), время из будущего недостоверно.
//   • DEEP-13: dead-порог (ok в истории) и порог качества разведены.
//     Свежие 40% потерь при dead=100% — это degraded-проблема в списке,
//     а не «модем исчез из проблем». В reboot идут только dead-кандидаты
//     (флаг dead) — подтверждённый устойчивый текущий отказ: последний
//     валидный замер свежий и с потерями ≥ dead-порога, и таких замеров
//     за TTL-окно минимум два (одиночный блип не считается).

const pingFresh = require('./ping-freshness');

function create(deps) {
  const { db, appSettings, logger } = deps;

  function computeProxyIssues() {
    try {
      const winMin   = Math.max(5, Math.min(720, appSettings.proxy_alert_window_min || 60));
      const errLimit = Math.max(0, Math.min(100, appSettings.proxy_alert_error_pct || 5));
      const deadPct  = Math.max(1, Math.min(100, Number(appSettings.ping_loss_dead_pct) || 100));
      const since = new Date(Date.now() - winMin * 60000).toISOString();
      const ttl = pingFresh.ttlMs((k, d) => (appSettings[k] != null ? appSettings[k] : d));
      const freshSince = new Date(Date.now() - ttl).toISOString();
      const nowMs = Date.now();

      const stateRows = db.prepare(`
        SELECT s.server AS server_name, s.nick, s.quality, s.ok AS latest_ok,
               s.loss_pct AS latest_loss, s.latency_ms AS latest_latency,
               s.observed_at, s.measured_at,
               (SELECT COUNT(*) FROM modem_ping p
                 WHERE p.server = s.server AND p.nick = s.nick AND p.ts >= ?) AS total,
               (SELECT AVG(COALESCE(p.loss_pct, CASE WHEN p.ok = 1 THEN 0 ELSE 100 END))
                  FROM modem_ping p
                 WHERE p.server = s.server AND p.nick = s.nick AND p.ts >= ?) AS avg_loss,
               (SELECT COUNT(*) FROM modem_ping p
                 WHERE p.server = s.server AND p.nick = s.nick AND p.ts >= ?
                   AND p.ok = 0) AS fresh_failed,
               COALESCE((SELECT json_extract(k.data, '$.portName')
                         FROM known_modems k
                         WHERE k.server_name = s.server
                           AND json_extract(k.data, '$.nick') = s.nick
                           AND COALESCE(json_extract(k.data, '$.portName'), '') <> ''
                         ORDER BY k.updated_at DESC LIMIT 1), '') AS client_name,
               COALESCE((SELECT m.operator FROM modem_meta m
                         WHERE m.server_name = s.server AND m.nick = s.nick
                         ORDER BY m.updated_at DESC LIMIT 1), '') AS operator
          FROM modem_ping_state s
      `).all(since, since, freshSince);

      const issues = [];
      for (const c of stateRows) {
        // Текущее наблюдение должно быть валидным и свежим; stale/missing/
        // invalid — «нет достоверных данных», а не кандидат (DEEP-12).
        if (!pingFresh.isFreshValid(c, nowMs, ttl)) continue;
        const latestLoss = c.latest_loss != null
          ? Number(c.latest_loss)
          : (Number(c.latest_ok) === 1 ? 0 : 100);
        const errPct = c.avg_loss != null ? Math.round(Number(c.avg_loss) * 10) / 10 : null;
        // dead = подтверждённый УСТОЙЧИВЫЙ текущий отказ: последний замер за
        // dead-порогом и минимум два failed-замера за TTL-окно. Именно такие
        // кандидаты допускаются к auto-reboot (FIX-05 п.4).
        const dead = latestLoss >= deadPct && Number(c.fresh_failed || 0) >= 2;
        // DEEP-13: degraded требует деградации и в ТЕКУЩЕМ замере, и в среднем
        // по окну — иначе восстановившийся модем висел бы в проблемах, пока
        // не «остыло» среднее, а одиночный блип давал бы ложный сигнал.
        if (!dead && (errPct == null || errPct <= errLimit || latestLoss <= errLimit)) continue;
        const shownPct = dead ? latestLoss : errPct;
        const reasons = [`потери ${shownPct}%`];
        issues.push({
          nick: c.nick,
          server: c.server_name,
          operator: c.operator || '',
          client: c.client_name || '',
          errorPct: shownPct,
          dead,
          severity: dead ? 'dead' : 'degraded',
          reasons,
          detail: reasons.join(' · ')
        });
      }
      issues.sort((a, b) => (Number(b.dead) - Number(a.dead)) || (b.errorPct - a.errorPct));
      return issues;
    } catch (e) {
      logger.error('[proxyIssues]', e.message);
      return [];
    }
  }

  return { computeProxyIssues };
}

module.exports = { create };
