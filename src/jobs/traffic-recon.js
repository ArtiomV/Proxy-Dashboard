'use strict';
//
// src/jobs/traffic-recon.js — nightly traffic reconciliation (WP1).
//
// Independently verifies our billing source: for every sold port we ask the
// box's pmacct accounting (/apix/get_counters_port) for the exact traffic of
// the past billing day and compare it against what we stored in
// daily_traffic (which comes from ProxySmart's bandwidth_bytes_yesterday_*
// counters). A drift above the threshold means one of the two counters lies
// — and since daily_traffic feeds client charges, we alert instead of
// silently trusting either side.
//
// Timezone contract (the part that must not be "почти правильно"):
//   - daily_traffic rows are keyed by the MSK date label (getMoscowYesterday
//     at 00:45 UTC), but the NUMBER stored is ProxySmart's box-local-day
//     counter. So the honest comparison window is that same calendar date
//     interpreted as wall-clock time IN THE BOX'S OWN TIMEZONE — exactly the
//     day the yesterday_* counter measured. START/END are sent as wall-clock
//     strings and the box interprets them locally, so no offset conversion
//     is needed and DST is a non-issue by construction.
//   - This assumes box-local "yesterday" and MSK "yesterday" are the same
//     calendar date when the job runs (~06:40 MSK). True for every box we
//     run (UTC+0..+6). A far-west box would break the assumption — the
//     sanity check below logs and skips rather than writing a wrong row.
//
// Retry contract (user-specified): every failed request is retried up to
// RETRY_ATTEMPTS-1 more times with RETRY_COOLDOWN_MS between passes. Only
// after the final pass do we give up, and giving up always produces a
// telegram alert (traffic_recon_failed) — never a silent hole.

const RETRY_ATTEMPTS = 3;                  // 1 initial + 2 retries
const RETRY_COOLDOWN_MS = 3 * 60 * 1000;   // 3 min between passes (спека: 2–5)
const PORT_CALL_GAP_MS = 150;              // gentle pacing between port calls
const PORT_CALL_TIMEOUT_MS = 20000;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function create(deps) {
  const {
    db, logger,
    apiServers, SERVER_COUNTRIES,
    fetchApi,
    getMoscowYesterday,
    getSetting,
    alerts,
    logActivity,
    kvSet, kvGet,
  } = deps;

  const _reconUpsert = db.prepare(`INSERT INTO traffic_recon
    (date, server_name, port_key, client_name, ps_in, ps_out, our_in, our_out, diff_pct)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(port_key, date) DO UPDATE SET
      client_name = excluded.client_name,
      ps_in = excluded.ps_in, ps_out = excluded.ps_out,
      our_in = excluded.our_in, our_out = excluded.our_out,
      diff_pct = excluded.diff_pct,
      created_at = datetime('now')`);
  const _dtGet = db.prepare('SELECT bytes_in, bytes_out FROM daily_traffic WHERE port_name = ? AND date = ?');

  // Today's calendar date in a given IANA timezone ("YYYY-MM-DD").
  function todayInTz(tz) {
    return new Date().toLocaleDateString('en-CA', { timeZone: tz });
  }

  function parseBytes(v) {
    const n = parseFloat(v);
    return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
  }

  // One reconciliation query with the box's own day window for `date`.
  async function fetchPortCounters(server, portId, date) {
    const qs = `PORTID=${encodeURIComponent(portId)}`
      + `&START=${encodeURIComponent(date + ' 00:00:00')}`
      + `&END=${encodeURIComponent(date + ' 23:59:59')}`;
    const res = await fetchApi(server, `/apix/get_counters_port?${qs}`, PORT_CALL_TIMEOUT_MS);
    if (!res || typeof res !== 'object') throw new Error('empty counters response');
    return { in: parseBytes(res.in), out: parseBytes(res.out) };
  }

  // Multi-pass runner: work(item) for each item; failed items are retried in
  // later passes with a cooldown in between. Returns { ok: Map, failed: Map }.
  async function runWithRetries(label, items, work) {
    const ok = new Map();
    let pending = [...items];
    const lastErr = new Map();
    for (let pass = 1; pass <= RETRY_ATTEMPTS && pending.length; pass++) {
      if (pass > 1) {
        logger.info(`[TrafficRecon] ${label}: pass ${pass}/${RETRY_ATTEMPTS} for ${pending.length} failed item(s) after cooldown`);
        await sleep(RETRY_COOLDOWN_MS);
      }
      const stillFailing = [];
      for (const item of pending) {
        try {
          ok.set(item, await work(item));
        } catch (e) {
          lastErr.set(item, e.message);
          stillFailing.push(item);
        }
        if (PORT_CALL_GAP_MS) await sleep(PORT_CALL_GAP_MS);
      }
      pending = stillFailing;
    }
    const failed = new Map();
    for (const item of pending) failed.set(item, lastErr.get(item) || 'unknown');
    return { ok, failed };
  }

  async function runTrafficRecon() {
    const date = getMoscowYesterday();
    const alertPct = Number(getSetting('traffic_recon_alert_pct', 10)) || 10;
    const minGb = Number(getSetting('traffic_recon_min_gb', 0.5)) || 0.5;
    const minBytes = minGb * 1e9;
    logger.info(`[TrafficRecon] Starting reconciliation for ${date} (alert ≥${alertPct}%, floor ${minGb} GB)`);

    const status = {};      // per-server status for the UI badge
    const offenders = [];   // rows above threshold, across all servers
    let totalPorts = 0, totalRows = 0;

    for (const server of apiServers) {
      const tz = (SERVER_COUNTRIES[server.name] || {}).tz || 'Europe/Moscow';

      // Sanity: the box's local calendar must have moved past `date` — i.e.
      // `date` is a finished day there. If not (far-west box), a same-date
      // window would be a partial day → wrong data, so skip loudly.
      if (todayInTz(tz) <= date) {
        const msg = `box-local date not past ${date} (tz ${tz}) — window would be a partial day`;
        logger.error(`[TrafficRecon] ${server.name}: ${msg}`);
        status[server.name] = { ok: false, date, error: msg };
        alerts.trigger('traffic_recon_failed', { server: server.name, error: msg, date });
        continue;
      }

      // Port list (sold ports only — same filter as daily_traffic writes).
      // The list call follows the same retry contract as the port calls.
      const listAttempt = await runWithRetries(`${server.name} port list`, ['bandwidth_report_all'],
        () => fetchApi(server, '/apix/bandwidth_report_all', PORT_CALL_TIMEOUT_MS));
      if (listAttempt.failed.size) {
        const err = listAttempt.failed.get('bandwidth_report_all');
        logger.error(`[TrafficRecon] ${server.name}: port list failed after ${RETRY_ATTEMPTS} attempts: ${err}`);
        status[server.name] = { ok: false, date, error: `port list: ${err}` };
        alerts.trigger('traffic_recon_failed', { server: server.name, error: `не получен список портов: ${err}`, date });
        continue;
      }
      const bw = listAttempt.ok.get('bandwidth_report_all') || {};
      const ports = Object.entries(bw)
        .filter(([, b]) => b && typeof b === 'object' && b.portName)
        .map(([portId, b]) => ({ portId, portName: b.portName }));
      totalPorts += ports.length;
      logger.info(`[TrafficRecon] ${server.name}: reconciling ${ports.length} sold port(s), window ${date} in ${tz}`);

      const nameByPort = new Map(ports.map(p => [p.portId, p.portName]));
      const { ok, failed } = await runWithRetries(`${server.name} counters`, ports.map(p => p.portId),
        (portId) => fetchPortCounters(server, portId, date));

      let rows = 0;
      const writeRows = db.transaction(() => {
        for (const [portId, ps] of ok) {
          const portKey = server.name + '_' + portId;
          const our = _dtGet.get(portKey, date) || { bytes_in: 0, bytes_out: 0 };
          const psTotal = ps.in + ps.out;
          const ourTotal = (our.bytes_in || 0) + (our.bytes_out || 0);
          const base = Math.max(psTotal, ourTotal);
          const diffPct = base > 0 ? Math.abs(psTotal - ourTotal) / base * 100 : 0;
          _reconUpsert.run(date, server.name, portKey, nameByPort.get(portId) || '',
            ps.in, ps.out, our.bytes_in || 0, our.bytes_out || 0, Math.round(diffPct * 10) / 10);
          rows++;
          if (base >= minBytes && diffPct >= alertPct) {
            offenders.push({
              client: nameByPort.get(portId) || portKey, server: server.name,
              psGb: (psTotal / 1e9).toFixed(1), ourGb: (ourTotal / 1e9).toFixed(1),
              diffPct: diffPct.toFixed(0),
            });
          }
        }
      });
      writeRows();
      totalRows += rows;

      if (failed.size) {
        const err = [...failed.values()][0];
        logger.error(`[TrafficRecon] ${server.name}: ${failed.size}/${ports.length} port(s) failed after ${RETRY_ATTEMPTS} attempts (e.g. ${err})`);
        status[server.name] = { ok: false, date, error: `${failed.size} из ${ports.length} портов без данных (${err})`, rows };
        alerts.trigger('traffic_recon_failed', {
          server: server.name, date,
          error: `${failed.size} из ${ports.length} портов не отдали счётчики после ${RETRY_ATTEMPTS} попыток (${err})`,
        });
      } else {
        status[server.name] = { ok: true, date, rows };
      }
    }

    // Persist per-server status for the UI ("фича скрыта" badge on failures).
    try { kvSet.run('traffic_recon_status', JSON.stringify({ date, at: new Date().toISOString(), servers: status })); } catch (_) { /* best-effort */ }

    if (offenders.length) {
      offenders.sort((a, b) => Number(b.diffPct) - Number(a.diffPct));
      alerts.trigger('traffic_recon_mismatch', { date, count: offenders.length, top: offenders.slice(0, 5) });
    }
    logger.info(`[TrafficRecon] Done: ${totalRows}/${totalPorts} ports reconciled, ${offenders.length} above threshold`);
    logActivity('traffic', offenders.length ? 'warning' : 'info', 'traffic_recon',
      null, `Сверка трафика за ${date}: ${totalRows}/${totalPorts} портов, расхождений ≥${alertPct}%: ${offenders.length}`,
      { date, rows: totalRows, ports: totalPorts, offenders: offenders.length });
    return { date, rows: totalRows, ports: totalPorts, offenders: offenders.length, status };
  }

  return { runTrafficRecon };
}

module.exports = { create };
