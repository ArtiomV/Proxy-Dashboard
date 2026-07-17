'use strict';
//
// src/jobs/modem-tracking.js — the modem polling machine.
// Extracted VERBATIM from server.js (2026-07): 517-line trackModems —
// IP/uptime tracking, offline/recovery alert pairing, auto-recovery
// (USB reboot → Re-Add escalation), server downtime recording, operator
// metadata persistence. Every dependency arrives via the deps object;
// nothing global is captured.
//
function create(deps) {
  const {
    apiServers, fetchServerData, db, logger, logActivity, alerts,
    SERVER_COUNTRIES, normalizeOperator, operatorsDb, fetchApi, postFormApi,
    recordIpChange, saveIpTracking, saveUptimeTracking,
    _serverDownSince, _serverUnreachableAlertSent, uptimeTracking, ipTracking,
    offlineAlertSent, autoRecovery, appSettings, knownModems, _downSince,
    _alertEnabledAt, _metaOpGetByImei, _modemMetaUpsert, _deletedModemSet,
  } = deps;

async function trackModems() {
  const now = Date.now();
  let totalTracked = 0;
  const seenRecoveryKeys = new Set();

  for (const server of apiServers) {
    let statusArr;
    try {
      const data = await fetchServerData(server);
      statusArr = Array.isArray(data.status) ? data.status : [];
      // Stage 18.13: server returned to life after recorded outage → recovery alert.
      // Stage 18.21: gated on _serverUnreachableAlertSent — we don't emit a
      // «вернулся» message unless we previously sent a «недоступен» one.
      // Otherwise sub-10-min blips spawned recovery noise (asymmetric to the
      // 10-min grace on unreachable).
      if (_serverDownSince[server.name]) {
        const downStart = _serverDownSince[server.name];
        const downSec = Math.round((Date.now() - downStart) / 1000);
        const alerted = _serverUnreachableAlertSent[server.name] ? 1 : 0;
        if (alerted) alerts.trigger('server_recovered', { server: server.name, downSec });
        // Persist the outage episode (skip sub-2-min single-poll blips). (mig 035)
        if (downSec >= 120) {
          try {
            db.prepare('INSERT INTO server_downtime (server_name, down_from, down_to, duration_sec, alerted) VALUES (?,?,?,?,?)')
              .run(server.name, new Date(downStart).toISOString(), new Date().toISOString(), downSec, alerted);
            logActivity('modem', 'info', 'server_downtime_recorded', server.name, `S ${server.name} был недоступен ${Math.round(downSec / 60)} мин`, { downSec, alerted });
          } catch (e) { logger.warn('[Downtime] record failed: ' + e.message); }
        }
        delete _serverDownSince[server.name];
        delete _serverUnreachableAlertSent[server.name];
        alerts.clearCooldown('server_unreachable', { server: server.name });
      }
    } catch (e) {
      logger.info(`[Tracking] Server ${server.name} unreachable: ${e.message} — marking all modems as down`);
      logActivity('modem', 'warn', 'server_unreachable', server.name, `Server unreachable: ${e.message}`);
      if (!_serverDownSince[server.name]) _serverDownSince[server.name] = Date.now();
      // Stage 18.14: only alert if down ≥10 min — RO server has occasional
      // transient ECONNRESET that recovers within minutes; firing per blip
      // was just noise. Cooldown (1h) still prevents repeat spam after that.
      const downMs = Date.now() - _serverDownSince[server.name];
      if (downMs >= 10 * 60 * 1000) {
        if (alerts.trigger('server_unreachable', { server: server.name, error: e.message })) {
          _serverUnreachableAlertSent[server.name] = true;
        }
      }
      // Server unreachable = all its modems are down
      const todayBucket = new Date().toLocaleDateString('en-CA');
      for (const k of Object.keys(uptimeTracking)) {
        if (k.startsWith(server.name + '_')) {
          seenRecoveryKeys.add(k); // preserve autoRecovery state for unreachable servers
          if (!uptimeTracking[k].daily) uptimeTracking[k].daily = {};
          if (!uptimeTracking[k].daily[todayBucket]) uptimeTracking[k].daily[todayBucket] = { online: 0, total: 0 };
          uptimeTracking[k].total_checks++;
          uptimeTracking[k].daily[todayBucket].total++;
          // don't increment online = downtime
        }
      }
      continue;
    }

    const prefix = server.name + '_';

    // Sync modem metadata to SQLite (nick, operator, model, phone — rarely changes)
    try {
      const serverCountry = (SERVER_COUNTRIES[server.name] && SERVER_COUNTRIES[server.name].country) || '';
      const metaBatch = db.transaction(() => {
        for (const m of statusArr) {
          const md = m.modem_details || {};
          const imei = md.IMEI;
          if (!imei) continue;
          // Stage 18.1: don't persist ProxySmart's auto-generated placeholder
          // modems ("random*" nicks or USB-bus-path "IMEIs" like "1-3.1.2").
          // They appear when a real port binding is deleted but the modem
          // is still physically connected — not real customer-facing modems.
          // Without this guard they pile up in modem_meta and resurface in
          // the admin via the Stage 18 dual-source fallback. User asked to
          // keep them out of the dashboard entirely.
          const nick = md.NICK || '';
          if (/^random/i.test(nick) || imei.indexOf('.') >= 0) continue;
          const nd = m.net_details || {};
          const rawOp = (nd.CELLOP || md.OPERATOR || '').toLowerCase().trim();
          const isRO = server.name === 'S2' || server.name.indexOf('S2') === 0;
          // normalizeOperator already derives from CELLOP/OPERATOR and collapses
          // the "unknown" placeholder + empties to ''. Do NOT fall back to the raw
          // nd.CELLOP/md.OPERATOR here — that re-injects the literal "Unknown"
          // during signal-loss polls and poisons modem_meta (see RO2_31). An empty
          // normOp instead lets the guard below recover the last known operator.
          let normOp = normalizeOperator(rawOp, isRO);

          // Stage 17 guard #5 (Stage 18.11 history fallback, Stage 18.12 ALWAYS).
          // Earlier guard only recovered the operator when modem was online —
          // but ProxySmart marks the modem offline for some polls (signal loss,
          // restart), and during those polls the empty CELLOP was written into
          // modem_meta and stuck. RO_3 reproduced this: offline poll → guard
          // skipped → empty operator persisted.
          //
          // New: NEVER overwrite a non-empty operator with empty, regardless
          // of online/offline. Logic:
          //   1) prefer existing modem_meta.operator if it's non-empty
          //   2) else look in traffic_hourly (14d window)
          //   3) else look in proxy_checks (14d window)
          //   4) else accept the empty value (first time we ever see this modem)
          if (!normOp) {
            const existing = _metaOpGetByImei.get(server.name, imei);
            // A stale "Unknown" already in modem_meta must NOT be preferred —
            // otherwise it re-confirms itself every blic poll. Treat it like
            // empty so we recover the real carrier from traffic/proxy history.
            if (existing && existing.operator && existing.operator.toLowerCase().trim() !== 'unknown') {
              normOp = existing.operator;
            } else {
              try {
                const fromTraffic = db.prepare(`
                  SELECT operator FROM traffic_hourly
                  WHERE nick = ? AND operator IS NOT NULL AND TRIM(operator) != ''
                    AND hour_start >= datetime('now','-14 days')
                  ORDER BY hour_start DESC LIMIT 1
                `).get(md.NICK || '');
                if (fromTraffic && fromTraffic.operator) {
                  normOp = fromTraffic.operator;
                } else {
                  const fromChecks = db.prepare(`
                    SELECT operator FROM proxy_checks
                    WHERE nick = ? AND operator IS NOT NULL AND TRIM(operator) != ''
                      AND checked_at >= datetime('now','-14 days')
                    ORDER BY checked_at DESC LIMIT 1
                  `).get(md.NICK || '');
                  if (fromChecks && fromChecks.operator) normOp = fromChecks.operator;
                }
              } catch (_) { /* best-effort */ }
            }
          }

          // ProxySmart signal fields we already receive but never used (Batch 1):
          // SIM status, reboot-need score, operator HTTP-redirect (captive ==
          // SIM out of money / blocked), LTE band, modem-locked flag. Normalized
          // here so the persisted snapshot, alerts, health and failover all agree.
          const _simStatus = String(nd.SimStatus || '').toUpperCase().trim();
          const _bandRaw = String(nd.BAND || '').trim();
          const _band = (_bandRaw && _bandRaw !== '?') ? _bandRaw : '';
          const _redRaw = String(nd.HTTP_REDIRECT_IMPOSED == null ? '' : nd.HTTP_REDIRECT_IMPOSED).toLowerCase().trim();
          const _httpRedirect = (_redRaw && !['no', 'null', '0', 'false', 'none'].includes(_redRaw)) ? 1 : 0;
          const _rsNum = Number(md.REBOOT_SCORE);
          const _rebootScore = (md.REBOOT_SCORE != null && md.REBOOT_SCORE !== '' && Number.isFinite(_rsNum)) ? Math.round(_rsNum) : null;
          const _isLocked = (m.IS_LOCKED === true || m.IS_LOCKED === 'true') ? 1 : 0;

          // Only persist REAL modems. A glitched/random port reports a USB-path
          // pseudo-IMEI (e.g. "1-4.3.1.1") + a random nick — persisting it created
          // junk modem_meta rows. Real IMEIs are 14–16 digits.
          if (/^\d{14,16}$/.test(imei) && !/^random/i.test(md.NICK || '')
              && !_deletedModemSet.has(server.name + '|' + imei)) {   // 041: don't resurrect a soft-deleted modem
            _modemMetaUpsert.run(server.name, imei, md.NICK || '', normOp, md.MODEL || '', md.PHONE_NUMBER || '',
              _simStatus, _rebootScore, _httpRedirect, _band, _isLocked);
          }

          // Stage 17 auto-mapping (#1): persist operator → server's country
          // in operator_country_map. Manual overrides are protected — the
          // upsertAuto repo function does not overwrite source='manual' rows.
          if (normOp && serverCountry) {
            try { operatorsDb.upsertAuto(normOp, serverCountry, server.name); } catch (_) { /* best-effort */ }
          }
        }
      });
      metaBatch();
    } catch (e) { /* non-critical */ }

    for (const m of statusArr) {
      const imei = m.modem_details?.IMEI;
      if (!imei) continue;
      const key = prefix + imei;
      const nick = m.modem_details?.NICK || imei;  // hoisted from below to fix TDZ in IP-change log
      const extIp = m.net_details?.EXT_IP || '';
      const isOnline = m.net_details?.IS_ONLINE === 'yes';
      const isRotating = m.IS_ROTATED === 'true' || m.IS_ROTATED === true;
      const isRebooting = m.IS_REBOOTING === 'true' || m.IS_REBOOTING === true;

      // IP tracking (always, regardless of status)
      if (extIp && extIp !== 'IP_RESET') {
        if (!ipTracking[key]) {
          ipTracking[key] = { ip: extIp, since: new Date(now).toISOString() };
          // Record initial IP in history
          recordIpChange(key, null, extIp, now);
        } else if (ipTracking[key].ip !== extIp) {
          // IP changed! Record in history with timestamp
          recordIpChange(key, ipTracking[key].ip, extIp, now);
          logActivity('modem', 'info', 'ip_changed', nick, `IP changed: ${ipTracking[key].ip} → ${extIp}`, { server: server.name, old_ip: ipTracking[key].ip, new_ip: extIp });
          ipTracking[key] = { ip: extIp, since: new Date(now).toISOString() };
        }
        // else same IP -- keep existing `since`
      }

      // Uptime tracking
      // Rotating/rebooting = online (normal operation, not downtime)
      // Offline = immediately count as downtime (no threshold)
      if (!uptimeTracking[key]) {
        uptimeTracking[key] = { total_checks: 0, online_checks: 0, first_check: now, daily: {} };
      }
      if (!uptimeTracking[key].daily) uptimeTracking[key].daily = {};

      const todayBucket = new Date().toLocaleDateString('en-CA');
      if (!uptimeTracking[key].daily[todayBucket]) uptimeTracking[key].daily[todayBucket] = { online: 0, total: 0 };

      const isUp = isOnline || isRotating || isRebooting || extIp === 'IP_RESET';
      uptimeTracking[key].total_checks++;
      uptimeTracking[key].daily[todayBucket].total++;
      if (isUp) {
        uptimeTracking[key].online_checks++;
        uptimeTracking[key].daily[todayBucket].online++;
        // Stage 18.22: recovery alert. Earlier (Stage 18.17) we gated this
        // on `offlineAlertSent[key]`. That left two real-world cases silent:
        //
        //   1. Stale modems (>12h offline) coming back — the offline-alert
        //      block at line ~2992 skips them ("don't spam long-dead
        //      modems"), so the flag was never set. Operator never heard
        //      «вернулся».
        //   2. recovery_exhausted scenarios — that alert fires independently
        //      and doesn't touch offlineAlertSent. After USB-reset attempts
        //      gave up + modem eventually came back, no recovery message.
        //   3. Dashboard restarts — the in-memory map gets wiped; the
        //      offline-alert won't refire during boot grace; recovery alert
        //      then misses too.
        //
        // New gate: derive downtime from last_online_check itself. ≥10 min
        // (the SAME threshold the offline-alert uses — they MUST match, otherwise
        // an offline alert fires with no matching «вернулся». This was 20 min
        // while the offline alert is 10 min, so every 10–20 min outage — the
        // common modem flap — alerted offline but never recovered.) Cooldown 60s
        // on the rule still prevents flap-storms.
        const prevIso = uptimeTracking[key].last_online_check;
        let downSec = 0;
        if (prevIso) {
          const prevMs = Date.parse(prevIso);
          if (!isNaN(prevMs)) downSec = Math.max(0, Math.round((now - prevMs) / 1000));
        }
        // ПАРНОСТЬ (2026-07-16): «вернулся в строй» шлём ТОЛЬКО если по этому
        // модему реально ушёл «оффлайн» (флаг offline_alerted живёт в
        // uptimeTracking → переживает рестарт). Раньше гейтом был просто
        // downSec ≥ 10 мин, а offline-алерт при этом мог не уйти (модем лежал
        // >12ч = stale, или флаг потерялся при рестарте) — отсюда «рандом»:
        // приходило только «включился» без парного «отключился».
        if (uptimeTracking[key].offline_alerted) {
          // Resolve a friendly nick — prefer knownModems, fall back to modem_meta.
          let nickToShow = nick && nick !== imei ? nick : '';
          if (!nickToShow) {
            for (const info of Object.values(knownModems[server.name] || {})) {
              if (info && info.imei === imei) { nickToShow = info.nick || ''; break; }
            }
          }
          if (!nickToShow) {
            try { const row = db.prepare('SELECT nick FROM modem_meta WHERE server_name=? AND imei=? LIMIT 1').get(server.name, imei); if (row) nickToShow = row.nick || ''; } catch (_) {}
          }
          try { alerts.trigger('modem_recovered', { server: server.name, imei, nick: nickToShow, downSec }); } catch (_) {}
          uptimeTracking[key].offline_alerted = false;   // пара закрыта
          delete _downSince[key];
        }
        // Stage 18.9: separate timestamp for "last time we SAW this modem alive".
        // last_check is bumped every tick (even for offline modems via the
        // Stage 17.1 offline pass) — using it as "last seen alive" made the UI
        // show "offline 5min ago" for modems that hadn't responded in days.
        uptimeTracking[key].last_online_check = new Date(now).toISOString();
        // Stage 18.10: arm next alert. Modem came back online → if it goes
        // offline again later, we want to alert (don't keep stale "sent" flag).
        if (offlineAlertSent[key]) delete offlineAlertSent[key];
      }

      // Prune daily buckets older than 35 days
      const cutoffPrune = new Date(now - 35 * 86400000).toLocaleDateString('en-CA');
      for (const d of Object.keys(uptimeTracking[key].daily)) {
        if (d < cutoffPrune) delete uptimeTracking[key].daily[d];
      }

      // Auto-recovery: USB reset for offline modems
      const recoveryKey = key; // prefix + imei
      seenRecoveryKeys.add(recoveryKey);
      // `nick` already declared at top of loop body (hoisted)
      if (isUp) {
        if (autoRecovery[recoveryKey]) {
          if (autoRecovery[recoveryKey].attempts > 0) {
            logger.info(`[AutoRecovery] ${nick} back online after ${autoRecovery[recoveryKey].attempts} reset(s)`);
            logActivity('recovery', 'info', 'modem_recovered', nick, `Back online after ${autoRecovery[recoveryKey].attempts} USB reset(s)`, { server: server.name, attempts: autoRecovery[recoveryKey].attempts });
          }
          delete autoRecovery[recoveryKey];
        }
        // Stage 18.13: arm next offline alert + clear our recovery_exhausted cooldown
        // for this modem (so future failures alert again).
        alerts.clearCooldown('modem_offline_20m', { server: server.name, imei });
        alerts.clearCooldown('recovery_exhausted', { server: server.name, nick });
      } else {
        if (!autoRecovery[recoveryKey]) {
          autoRecovery[recoveryKey] = { offlineSince: now, attempts: 0, lastAttempt: 0, readdDone: false, cyclesToday: 0, dayStamp: 0 };
        }
        const rec = autoRecovery[recoveryKey];
        const offlineSec = (now - rec.offlineSince) / 1000;
        const _recOffSec = appSettings.recovery_offline_sec || 300;
        const _recMaxAtt = appSettings.recovery_max_attempts || 3;
        const _recRetryMs = (appSettings.recovery_retry_min || 5) * 60000;
        const _recCap = appSettings.recovery_daily_cap || 6;
        // Daily-cap rollover (MSK day) — caps recovery actions per modem per day
        // so a flapping modem can't re-storm reboots across many short outages.
        const _dayKey = Math.floor((now + 3 * 3600000) / 86400000);
        if (rec.dayStamp !== _dayKey) { rec.dayStamp = _dayKey; rec.cyclesToday = 0; }
        // Gating — skip modems where a reboot is futile or unwanted.
        const _simS = String((m.net_details && m.net_details.SimStatus) || '').toUpperCase();
        const _deadSim = /UNDETECT|ABSENT|NOT.?INSERT|FAIL|ERROR|NO ?SIM/.test(_simS);
        let _skip = false;
        if (/^random/i.test(nick)) _skip = true;                                              // phantom port
        else if (appSettings.recovery_skip_dead_sim !== false && _deadSim) _skip = true;       // dead SIM — reboot can't fix
        else if (appSettings.recovery_skip_unsold === true) {                                  // optional: skip free/unsold
          const _km = (knownModems[server.name] || {})[imei];
          const _pn = (_km && _km.portName) ? String(_km.portName) : '';
          if (!_pn || /^random/i.test(_pn)) _skip = true;
        }
        if (appSettings.recovery_enabled && !_skip && offlineSec >= _recOffSec && (now - rec.lastAttempt) >= _recRetryMs && rec.cyclesToday < _recCap) {
          if (rec.attempts < _recMaxAtt) {
            // Step 1..N: soft REBOOT (unified action — works on E3372 and MF289D alike).
            rec.attempts++; rec.cyclesToday++; rec.lastAttempt = now;
            logger.warn(`[AutoRecovery] reboot #${rec.attempts}/${_recMaxAtt} for ${nick} (${server.name}), offline ${Math.round(offlineSec)}s`);
            logActivity('recovery', 'warn', 'reboot', nick, `Перезагрузка #${rec.attempts}/${_recMaxAtt} (офлайн ${Math.round(offlineSec)}с)`, { server: server.name, attempt: rec.attempts, offline_sec: Math.round(offlineSec) });
            fetchApi(server, `/apix/reboot_modem_by_imei?IMEI=${encodeURIComponent(imei)}`)
              .catch(e => {
                logger.error(`[AutoRecovery] reboot failed for ${nick}: ${e.message}`);
                logActivity('recovery', 'error', 'reboot_failed', nick, `Перезагрузка не удалась: ${e.message}`, { server: server.name });
              });
          } else if (appSettings.recovery_readd_after !== false && !rec.readdDone) {
            // Final escalation: Re-Add (re-register the USB device), then give up.
            rec.readdDone = true; rec.cyclesToday++; rec.lastAttempt = now;
            const _dev = m.net_details && m.net_details.DEV;
            logger.warn(`[AutoRecovery] Re-Add for ${nick} (${server.name}) after ${_recMaxAtt} reboots, DEV=${_dev || '?'}`);
            logActivity('recovery', 'warn', 'readd', nick, `Re-Add после ${_recMaxAtt} перезагрузок`, { server: server.name, dev: _dev || null });
            if (_dev) postFormApi(server, '/modem/add_dev', { DEV: _dev }).catch(e => logger.error(`[AutoRecovery] Re-Add failed for ${nick}: ${e.message}`));
            logger.warn(`[AutoRecovery] ${nick} exhausted (${_recMaxAtt} reboots + Re-Add), giving up`);
            logActivity('recovery', 'warn', 'recovery_exhausted', nick, `Исчерпано: ${_recMaxAtt} перезагрузок + Re-Add, сдаюсь`, { server: server.name });
            alerts.trigger('recovery_exhausted', { server: server.name, nick, attempts: _recMaxAtt });
          }
        }
      }

      totalTracked++;
    }

    // ── Stage 17.1 fix: account for OFFLINE modems that disappeared from ProxySmart's
    //    status response entirely. Previously trackModems iterated only over
    //    `statusArr`, so a switched-off modem never got `total++` — its uptime %
    //    stayed frozen at the last known value (often 100%). Health-score then
    //    showed the modem as healthy/green even though it had been off for days.
    //
    //    Fix: after the statusArr pass, walk known_modems[server.name] and for
    //    every modem-IMEI that we did NOT just process, write a downtime tick
    //    (total++, online does NOT increment). This mirrors the same logic
    //    we apply when the entire server is unreachable (lines ~2303).
    //
    //    Excludes random* port placeholders and duplicates (multiple ports can
    //    bind the same modem; we want one tick per IMEI per cycle).
    try {
      const processedImeis = new Set();
      // Modems present in the status feed but reporting offline NOW (not online,
      // not rotating/rebooting/resetting). The Telegram offline alert below used
      // to fire only for modems that VANISHED from the feed (offlineImeis); a
      // modem that stays enumerated but goes IS_ONLINE=no — the common case
      // (data channel dropped, USB still plugged) — never alerted on Telegram,
      // only in the bell. Collect them so the alert covers both. Their downtime
      // tick already happened in the main status loop above, so they are NOT
      // re-ticked in the offlineImeis downtime pass below.
      const offlineNowImeis = new Set();
      for (const m of statusArr) {
        const imei = m.modem_details && m.modem_details.IMEI;
        if (!imei) continue;
        processedImeis.add(imei);
        const nd = m.net_details || {};
        const up = nd.IS_ONLINE === 'yes'
          || m.IS_ROTATED === 'true' || m.IS_ROTATED === true
          || m.IS_REBOOTING === 'true' || m.IS_REBOOTING === true
          || nd.EXT_IP === 'IP_RESET';
        if (!up) offlineNowImeis.add(imei);
      }
      const km = knownModems[server.name] || {};
      const offlineImeis = new Set();
      for (const info of Object.values(km)) {
        if (info && info.imei && !processedImeis.has(info.imei)) {
          offlineImeis.add(info.imei);
        }
      }
      const todayBucket = new Date().toLocaleDateString('en-CA');
      for (const imei of offlineImeis) {
        const key = prefix + imei;
        if (!uptimeTracking[key]) {
          uptimeTracking[key] = { total_checks: 0, online_checks: 0, first_check: now, daily: {} };
        }
        if (!uptimeTracking[key].daily) uptimeTracking[key].daily = {};
        if (!uptimeTracking[key].daily[todayBucket]) uptimeTracking[key].daily[todayBucket] = { online: 0, total: 0 };
        uptimeTracking[key].total_checks++;
        uptimeTracking[key].daily[todayBucket].total++;
        // online intentionally NOT incremented — this is the whole point.
        // last_check tracks polling activity (when did we LAST tick this row).
        // last_online_check is NOT touched here — see Stage 18.9 comment in
        // the statusArr loop above. That field is the source of truth for
        // "how long has this modem been offline" in the UI.
        uptimeTracking[key].last_check = new Date(now).toISOString();
        seenRecoveryKeys.add(key);     // don't let pruning kill autoRecovery state
        totalTracked++;
      }
      if (offlineImeis.size > 0) {
        logger.debug(`[Tracking] ${server.name}: ${offlineImeis.size} offline modems also ticked (downtime)`);
      }

      // ── Stage 18.10: Telegram alert «модем оффлайн >10 минут» ──
      // Single shot per offline streak. Boot grace window (6 min) avoids a
      // flood after restart for modems that were already offline. Modems past
      // the stale threshold (default 12h) are NOT alerted — they're already
      // "long-dead" by policy and would just spam. Threshold matches the
      // «Модем отключен» card (computeFleet disconnectedMs) — a modem lands in
      // the card and the alert fires at the same 10-minute mark.
      if (Date.now() >= _alertEnabledAt) {
        const ALERT_MIN = 10;
        const ALERT_MS  = ALERT_MIN * 60 * 1000;
        const STALE_MS  = (Number(appSettings.stale_modem_hours) || 12) * 3600 * 1000;
        const km = knownModems[server.name] || {};
        // Alert for modems that vanished from the feed (offlineImeis) AND those
        // still enumerated but offline now (offlineNowImeis) — both are "dark".
        for (const imei of new Set([...offlineImeis, ...offlineNowImeis])) {
          const key = prefix + imei;
          if (offlineAlertSent[key]) continue;
          const ut = uptimeTracking[key];
          if (!ut || !ut.last_online_check) continue;          // never seen alive → skip (Stage 18.9)
          const lastOnlineMs = Date.parse(ut.last_online_check);
          if (isNaN(lastOnlineMs)) continue;
          const offlineMs = now - lastOnlineMs;
          if (offlineMs < ALERT_MS) continue;                  // not long enough yet
          if (offlineMs >= STALE_MS) continue;                 // already stale → don't spam
          // Find nick from known_modems for friendly message.
          let nickToShow = '';
          for (const info of Object.values(km)) {
            if (info && info.imei === imei) { nickToShow = info.nick || ''; break; }
          }
          if (!nickToShow) {
            try { const r = db.prepare('SELECT nick FROM modem_meta WHERE server_name=? AND imei=? LIMIT 1').get(server.name, imei); if (r) nickToShow = r.nick || ''; } catch (_) {}
          }
          const minsOff = Math.floor(offlineMs / 60000);
          // 2026-07-16: раньше слали напрямую tgBot.sendMessage, минуя alerts —
          // алерт не попадал в колокольчик, не уважал вкл/выкл правила и не
          // логировался как остальные. Теперь — через общий alerts.trigger,
          // как парный ему modem_recovered.
          try {
            alerts.trigger('modem_offline_20m', {
              server: server.name, imei, nick: nickToShow, mins: minsOff,
              lastOnline: new Date(lastOnlineMs).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' }),
            });
            offlineAlertSent[key] = true;
            // Флаг парности в персистентном uptimeTracking: «вернулся» уйдёт
            // только если этот «оффлайн» реально был отправлен.
            if (uptimeTracking[key]) uptimeTracking[key].offline_alerted = true;
            _downSince[key] = lastOnlineMs;   // для сводки «N модемов не работает»
            logActivity('modem', 'warn', 'modem_offline_alert', nickToShow || imei,
              `Offline ${minsOff} min — alert sent`,
              { server: server.name, imei, mins_offline: minsOff });
          } catch (e) { logger.warn('[OfflineAlert] dispatch failed: ' + e.message); }
        }
      }
    } catch (e) {
      logger.warn('[Tracking] offline-tick error for ' + server.name + ': ' + e.message);
    }
  }

  // Prune stale modem keys from uptimeTracking (modems removed or not seen in 7+ days)
  const MAX_UPTIME_KEYS = 500;
  const uptimeKeys = Object.keys(uptimeTracking);
  if (uptimeKeys.length > MAX_UPTIME_KEYS) {
    const now7d = new Date(Date.now() - 7 * 86400000).toLocaleDateString('en-CA');
    for (const k of uptimeKeys) {
      const days = Object.keys(uptimeTracking[k].daily || {});
      const latest = days.length ? days.sort().pop() : '';
      if (latest < now7d) { delete uptimeTracking[k]; }
    }
  }

  // Prune autoRecovery keys for modems no longer in the system
  for (const rk of Object.keys(autoRecovery)) {
    if (!seenRecoveryKeys.has(rk)) delete autoRecovery[rk];
  }

  saveIpTracking();
  // ── Сводка «N модемов не работает» (2026-07-16) ────────────────────────
  // В потоке одиночных сообщений масштаб аварии теряется. Считаем модемы,
  // по которым СЕЙЧАС открыт отправленный «оффлайн», и при достижении порога
  // шлём одно агрегированное сообщение (порог + вкл/выкл — в Настройках).
  try {
    const _thr = Number(appSettings.modems_down_threshold) || 5;
    const _downKeys = Object.keys(_downSince);
    if (_thr > 0 && _downKeys.length >= _thr) {
      const _now = Date.now();
      const _items = _downKeys.map(k => {
        const _srv = k.slice(0, k.indexOf('_'));
        const _im = k.slice(k.indexOf('_') + 1);
        let _nk = '';
        for (const info of Object.values(knownModems[_srv] || {})) {
          if (info && info.imei === _im) { _nk = info.nick || ''; break; }
        }
        if (!_nk) { try { const r = db.prepare('SELECT nick FROM modem_meta WHERE server_name=? AND imei=? LIMIT 1').get(_srv, _im); if (r) _nk = r.nick || ''; } catch (_) { /* best-effort */ } }
        return { nick: _nk || _im, server: _srv, mins: Math.floor((_now - _downSince[k]) / 60000) };
      }).sort((a, b) => b.mins - a.mins);
      const _byServer = {};
      for (const it of _items) _byServer[it.server] = (_byServer[it.server] || 0) + 1;
      try {
        alerts.trigger('modems_down_bulk', {
          count: _items.length,
          servers: Object.keys(_byServer).map(s => s + ': ' + _byServer[s]).join(', '),
          // Весь список: оператору нужны все лежащие модемы, а не top-N.
          // Обрезка (если упрётся в лимит Telegram) — в render правила.
          list: _items.map(i => i.nick + ' (' + i.server + ', ' + i.mins + ' мин)').join('\n'),
        });
      } catch (_) { /* alert best-effort */ }
    }
  } catch (e) { logger.warn('[ModemsDownBulk] ' + e.message); }

  saveUptimeTracking();
  // BUG-02: saveIpHistory() removed — recordIpChange() now does direct DB writes
  logger.info(`[Tracking] Updated IP & uptime for ${Object.keys(ipTracking).length} modems (${totalTracked} uptime checks)`);
  logActivity('modem', 'info', 'tracking_complete', null, `Tracked ${totalTracked} modems across ${apiServers.length} servers`, { modem_count: totalTracked, ip_count: Object.keys(ipTracking).length });
}

  return { trackModems };
}

module.exports = { create };
