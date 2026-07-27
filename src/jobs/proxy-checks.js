'use strict';
//
// src/jobs/proxy-checks.js — периодические проверки качества прокси:
// checkProxyLatency (батч ping-проверок каждые N минут, пишет proxy_checks)
// и runNightlySpeedtests (ночной прогон Ookla speedtest по всем модемам,
// с re-test низких скоростей). Extracted from server.js (Stage 9) — без
// изменения логики.

function create(deps) {
  const {
    db, dbStmts, logger, logActivity,
    fetchAllServersDataCached, SERVER_COUNTRIES, normalizeOperator, isAutoRandomPort,
    getProxyCheckConcurrency, curlCheckProxy,
    apiServers, fetchApi, appSettings, pushSpeedtestEntry,
  } = deps;

  async function checkProxyLatency() {
    try {
      const results = await fetchAllServersDataCached();
      const nowIso = new Date().toISOString();

      // Build list of proxies to check
      const proxies = [];
      for (const data of results) {
        const srv = data.serverName || '';
        const sc = SERVER_COUNTRIES[srv] || {};
        const serverIp = sc.serverIp || '';
        if (!serverIp) continue;
        const statusArr = Array.isArray(data.status) ? data.status : [];
        const portsMap = data.ports || {};

        // Map IMEI → modem info
        const modemInfo = {};
        for (const m of statusArr) {
          const md = m.modem_details || {};
          const imei = md.IMEI;
          if (!imei) continue;
          modemInfo[imei] = {
            nick: md.NICK || imei,
            isOnline: m.net_details?.IS_ONLINE === 'yes',
            isRotating: m.IS_ROTATED === 'true' || m.IS_ROTATED === true,
            operator: normalizeOperator(m.net_details?.CELLOP, srv === 'S2' || srv.startsWith('S2')),
          };
        }

        for (const [imei, portList] of Object.entries(portsMap)) {
          const info = modemInfo[imei];
          if (!info) continue;
          // Skip offline modems (not rotating)
          if (!info.isOnline && !info.isRotating) continue;
          for (const p of portList) {
            if (!p.HTTP_PORT || !p.LOGIN || !p.PASSWORD) continue;
            // Skip ports that are NOT actively serving a paying client — probing them
            // just generates false errors that wrongly flag a working modem as down:
            //  • unassigned (no portName), • ProxySmart "randomport*" phantoms,
            //  • expired rentals (PROXY_VALID_BEFORE in the past → port blocked by us).
            if (!p.portName || !p.portName.trim()) continue;
            if (isAutoRandomPort(p.portName)) continue;
            if (p.PROXY_VALID_BEFORE) { const _vb = Date.parse(p.PROXY_VALID_BEFORE); if (!isNaN(_vb) && _vb < Date.now()) continue; }
            proxies.push({
              server: srv,
              nick: info.nick,
              client: p.portName,
              operator: info.operator || '',
              proxyUrl: `http://${p.LOGIN}:${p.PASSWORD}@${serverIp}:${p.HTTP_PORT}`,
            });
            break; // one check per modem is enough
          }
        }
      }

      // Run checks with concurrency limit
      let ok = 0, errors = 0;
      const batch = db.transaction((entries) => {
        for (const e of entries) {
          dbStmts.proxyCheckInsert.run(e.server, e.nick, e.client, e.operator || '', nowIso, e.connect_ms, e.total_ms, e.status_code, e.error);
        }
      });

      const entries = [];
      for (let i = 0; i < proxies.length; i += getProxyCheckConcurrency()) {
        const chunk = proxies.slice(i, i + getProxyCheckConcurrency());
        const results = await Promise.all(chunk.map(async (p) => {
          const r = await curlCheckProxy(p.proxyUrl);
          return { server: p.server, nick: p.nick, client: p.client, operator: p.operator, ...r };
        }));
        for (const r of results) {
          entries.push(r);
          if (r.error) errors++;
          else ok++;
        }
      }

      batch(entries);
      logger.info(`[ProxyCheck] Checked ${entries.length} proxies: ${ok} ok, ${errors} errors`);
      logActivity('proxy_check', errors > 0 ? 'warn' : 'info', 'check_complete', null, `Checked ${entries.length} proxies: ${ok} ok, ${errors} errors`, { total: entries.length, ok, errors });
    } catch (e) {
      logger.error('[ProxyCheck] Error:', e.message);
      logActivity('proxy_check', 'error', 'check_error', null, `Proxy latency check failed: ${e.message}`);
    }
  }

  // BUG-03: speedtest result parsing (was duplicated in test + retry)
  function parseSpeedtestResult(result) {
    let dl = 0, ul = 0, ping = 0;
    if (result && typeof result === 'object') {
      dl = parseFloat(result.download || result.Download || result.dl || 0);
      ul = parseFloat(result.upload || result.Upload || result.ul || 0);
      ping = parseFloat(result.ping || result.Ping || result.latency || 0);
      if (result.raw && typeof result.raw === 'string') {
        const dlMatch = result.raw.match(/download[:\s]*([\d.]+)/i);
        const ulMatch = result.raw.match(/upload[:\s]*([\d.]+)/i);
        const pingMatch = result.raw.match(/ping[:\s]*([\d.]+)/i);
        if (dlMatch) dl = parseFloat(dlMatch[1]);
        if (ulMatch) ul = parseFloat(ulMatch[1]);
        if (pingMatch) ping = parseFloat(pingMatch[1]);
      }
    }
    return { dl, ul, ping };
  }

  // Re-entrancy guard — ночной прогон один за раз (был module-level в server.js).
  let speedtestRunning = false;

  async function runNightlySpeedtests() {
    if (speedtestRunning) {
      logger.info('[Speedtest] Already running, skipping...');
      return;
    }
    speedtestRunning = true;
    logger.info('[Speedtest] Starting speedtest run...');
    let testedCount = 0, errorCount = 0;

    try {
      for (const server of apiServers) {
        try {
          const statusData = await fetchApi(server, '/apix/show_status_json');
          const modems = Array.isArray(statusData) ? statusData : [];
          logger.info(`[Speedtest] ${server.name}: ${modems.length} modems to test`);

          for (const m of modems) {
            const nick = m.modem_details?.NICK;
            const imei = m.modem_details?.IMEI;
            const isOnline = m.net_details?.IS_ONLINE === 'yes';
            if (!nick || !imei || !isOnline) continue;

            const key = server.name + '_' + imei;
            try {
              logger.info(`[Speedtest] Testing ${nick} (${server.name})...`);
              const result = await fetchApi(server, `/apix/speedtest?arg=${encodeURIComponent(nick)}`, 180000);
              const { dl, ul, ping } = parseSpeedtestResult(result);

              const entry = { date: new Date().toISOString(), download: dl, upload: ul, ping, raw: result };

              // Re-test if DL or UL is below threshold
              const _stLowThresh = appSettings.speedtest_low_threshold || 1;
              const _stRetestMs = (appSettings.speedtest_retest_delay_min || 10) * 60000;
              if (dl < _stLowThresh || ul < _stLowThresh) {
                logger.info(`[Speedtest] ${nick}: DL=${dl} UL=${ul} — below ${_stLowThresh} Mbps, re-testing in ${appSettings.speedtest_retest_delay_min || 10} min...`);
                setTimeout(async () => {
                  try {
                    logger.info(`[Speedtest] Re-testing ${nick} (${server.name})...`);
                    const retryResult = await fetchApi(server, `/apix/speedtest?arg=${encodeURIComponent(nick)}`, 180000);
                    const r = parseSpeedtestResult(retryResult);
                    if (r.dl + r.ul > dl + ul) {
                      pushSpeedtestEntry(key, { date: new Date().toISOString(), download: r.dl, upload: r.ul, ping: r.ping, raw: retryResult, retry: true, ...(r.dl < _stLowThresh || r.ul < _stLowThresh ? { _lowSpeed: true } : {}) });
                      logger.info(`[Speedtest] Re-test ${nick}: DL=${r.dl} UL=${r.ul} (improved)`);
                    } else {
                      logger.info(`[Speedtest] Re-test ${nick}: DL=${r.dl} UL=${r.ul} (not improved)`);
                    }
                  } catch (e) { logger.error(`[Speedtest] Re-test ${nick} error:`, e.message); }
                }, _stRetestMs);
              }

              pushSpeedtestEntry(key, entry);
              testedCount++;
              logger.info(`[Speedtest] ${nick}: DL=${dl} UL=${ul} Ping=${ping}`);
              if (dl < _stLowThresh || ul < _stLowThresh) {
                logActivity('speedtest', 'warn', 'low_speed', nick, `Low speed: DL=${dl} UL=${ul} Ping=${ping}`, { server: server.name, dl, ul, ping });
              } else {
                logActivity('speedtest', 'info', 'test_result', nick, `DL=${dl} UL=${ul} Ping=${ping}`, { server: server.name, dl, ul, ping });
              }
            } catch (e) {
              logger.error(`[Speedtest] Error testing ${nick}:`, e.message);
              logActivity('speedtest', 'error', 'test_error', nick, `Speedtest failed: ${e.message}`, { server: server.name });
              errorCount++;
            }

            await new Promise(r => setTimeout(r, 2000));
          }
        } catch (e) {
          logger.error(`[Speedtest] Error on server ${server.name}:`, e.message);
          errorCount++;
        }
      }
    } finally {
      speedtestRunning = false;
    }

    logger.info(`[Speedtest] Complete: ${testedCount} tested, ${errorCount} errors`);
    logActivity('speedtest', errorCount > 0 ? 'warn' : 'info', 'run_complete', null, `Speedtest complete: ${testedCount} tested, ${errorCount} errors`, { tested: testedCount, errors: errorCount });
  }

  return { checkProxyLatency, runNightlySpeedtests, parseSpeedtestResult };
}

module.exports = { create };
