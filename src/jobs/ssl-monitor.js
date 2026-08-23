'use strict';
// src/jobs/ssl-monitor.js — D2 (ТЗ мониторинга v2, 23.08): суточный контроль
// SSL-сертификата домена дашборда. ≤14 дней → important-алерт, ≤3 → critical.
// Cert читаем живым TLS-хендшейком (не из файлов nginx) — ловим и «забыли
// продлить», и «nginx отдаёт старый cert после продления».
//
// Тесты подсовывают deps.tlsConnect и deps.nowMs — сеть не дёргаем.
const tls = require('tls');

function create(deps) {
  const { logger, alerts, getSetting, logActivity } = deps;
  const _tlsConnect = deps.tlsConnect || _defaultTlsConnect;
  const _now = deps.nowMs || (() => Date.now());

  function _defaultTlsConnect(host, port) {
    return new Promise((resolve, reject) => {
      const sock = tls.connect({ host, port, servername: host, rejectUnauthorized: false, timeout: 10000 }, () => {
        const cert = sock.getPeerCertificate();
        sock.end();
        if (!cert || !cert.valid_to) return reject(new Error('no peer certificate'));
        resolve(cert);
      });
      sock.on('timeout', () => sock.destroy(new Error('tls timeout')));
      sock.on('error', reject);
    });
  }

  async function checkOnce() {
    const host = (getSetting && getSetting('ssl_monitor_host', '')) || 'app.arendaproxy.ru';
    if (getSetting && !getSetting('ssl_monitor_enabled', true)) return { skipped: true };
    let cert;
    try {
      cert = await _tlsConnect(host, 443);
    } catch (e) {
      logger.warn('[SSLMonitor] TLS check failed: ' + e.message);
      // Сеть до собственного домена лежит — это симптом другой проблемы,
      // алертим отдельно (cooldown сутки в правиле).
      alerts.trigger('ssl_cert_critical', { host, daysLeft: -1, validTo: '', error: e.message });
      return { ok: false, error: e.message };
    }
    const validToMs = Date.parse(cert.valid_to);
    if (!Number.isFinite(validToMs)) {
      logger.warn('[SSLMonitor] unparsable valid_to: ' + cert.valid_to);
      return { ok: false, error: 'bad valid_to' };
    }
    const daysLeft = Math.floor((validToMs - _now()) / 86400000);
    const validTo = new Date(validToMs).toLocaleDateString('ru-RU', { timeZone: 'Europe/Moscow' });
    if (daysLeft <= 3) {
      alerts.trigger('ssl_cert_critical', { host, daysLeft, validTo });
      if (logActivity) logActivity('system', 'critical', 'ssl_cert_expiring', host, `SSL ${host}: осталось ${daysLeft} дн (до ${validTo})`, { daysLeft });
    } else if (daysLeft <= 14) {
      alerts.trigger('ssl_cert_expiring', { host, daysLeft, validTo });
      if (logActivity) logActivity('system', 'warn', 'ssl_cert_expiring', host, `SSL ${host}: осталось ${daysLeft} дн (до ${validTo})`, { daysLeft });
    } else {
      logger.info(`[SSLMonitor] ${host}: cert OK, ${daysLeft} дн (до ${validTo})`);
    }
    return { ok: true, host, daysLeft, validTo };
  }

  return { checkOnce };
}

module.exports = { create };
