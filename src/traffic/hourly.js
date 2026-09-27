'use strict';

const { parseBwToBytes, normalizeOperator } = require('../utils/traffic');

let db, logger, fetchAllServersDataCached, refreshPortKeyMapping, portKeyToPortNameRef;
let _htUpsert, _htCleanup, _metaOpGet, _pcOpGet, _snapUpsert, _snapUpsertPreserve, _snapGet, _snapGetAll;
let SERVER_COUNTRIES = {};
let logActivity = () => {};   // Stage 18.3: optional dep — writes spike-protection events to system_log

// In-memory cache of hourly_snapshots table (port_id → row)
const snapCache = new Map();

function init(deps) {
  db = deps.db;
  logger = deps.logger;
  fetchAllServersDataCached = deps.fetchAllServersDataCached;
  refreshPortKeyMapping = deps.refreshPortKeyMapping;
  portKeyToPortNameRef = deps.getPortKeyToPortName;
  _htUpsert = deps._htUpsert;
  _htCleanup = deps._htCleanup;
  _metaOpGet = deps._metaOpGet;
  _pcOpGet = deps._pcOpGet;   // proxy_checks latest-operator fallback (optional dep)
  _snapUpsert = deps._snapUpsert;
  _snapUpsertPreserve = deps._snapUpsertPreserve || deps._snapUpsert;   // DEEP-28: refresh без «омоложения» измерения
  _snapGet = deps._snapGet;
  _snapGetAll = deps._snapGetAll;
  SERVER_COUNTRIES = deps.SERVER_COUNTRIES || {};
  if (typeof deps.logActivity === 'function') logActivity = deps.logActivity;   // Stage 18.3

  // Migrate old kv_store snapshots → hourly_snapshots table (one-time)
  migrateSnapshotsToTable();

  // Load all snapshots into memory
  loadSnapCache();
}

function loadSnapCache() {
  try {
    const rows = _snapGetAll.all();
    snapCache.clear();
    for (const r of rows) snapCache.set(r.port_id, r);
    logger.info(`[HourlyAgg] Loaded ${snapCache.size} snapshots from hourly_snapshots table`);
  } catch (e) {
    logger.error('[HourlyAgg] Failed to load snap cache:', e.message);
  }
}

function migrateSnapshotsToTable() {
  try {
    const existing = db.prepare('SELECT COUNT(*) as c FROM hourly_snapshots').get();
    if (existing.c > 0) return; // already migrated

    const row = db.prepare("SELECT value FROM kv_store WHERE key = 'hourly_day_snapshots'").get();
    if (!row) return;

    const old = JSON.parse(row.value);
    const stmt = db.prepare(`INSERT OR IGNORE INTO hourly_snapshots
      (port_id, day_in, day_out, month_in, month_out, pending, captured_at)
      VALUES (?, ?, ?, ?, ?, 0, datetime('now'))`);

    const tx = db.transaction(() => {
      for (const [portId, snap] of Object.entries(old)) {
        // Old snapshots stored month counters in 'in'/'out' fields
        // Use them as both day and month initial values
        stmt.run(portId, snap.in || 0, snap.out || 0, snap.in || 0, snap.out || 0);
      }
    });
    tx();
    logger.info(`[HourlyAgg] Migrated ${Object.keys(old).length} snapshots to hourly_snapshots table`);
  } catch (e) {
    logger.error('[HourlyAgg] Migration error:', e.message);
  }
}

function _utcNowStr() {
  // Формат SQLite datetime('now') — last_updated_at в кэше совпадает с БД.
  return new Date().toISOString().slice(0, 19).replace('T', ' ');
}

function upsertSnap(portId, fields, opts) {
  const preserveTs = !!(opts && opts.preserveTs);
  (preserveTs ? _snapUpsertPreserve : _snapUpsert).run(
    portId,
    fields.day_in || 0, fields.day_out || 0,
    fields.month_in || 0, fields.month_out || 0,
    fields.yesterday_in || 0, fields.yesterday_out || 0,
    fields.prev_month_in || 0, fields.prev_month_out || 0,
    fields.day_at_last_hour_start_in || 0, fields.day_at_last_hour_start_out || 0,
    fields.mon_at_last_hour_start_in || 0, fields.mon_at_last_hour_start_out || 0,
    fields.pending || 0
  );
  // DEEP-28: кэш обязан отражать то, что реально лежит в БД. Раньше поля
  // captured_at/last_updated_at в память не писались — snapRecent и
  // gap-detection (missedHours) после записи работали по устаревшей дате.
  const prev = snapCache.get(portId);
  snapCache.set(portId, {
    port_id: portId, ...fields,
    last_updated_at: preserveTs
      ? (prev && prev.last_updated_at) || _utcNowStr()
      : _utcNowStr(),
  });
}

// Startup: refresh snapshots from live data WITHOUT writing to traffic_hourly
async function refreshSnapshotsOnly() {
  try {
    const results = await fetchAllServersDataCached();
    let updated = 0;
    const tx = db.transaction(() => {
      for (const data of results) {
        const srv = data.serverName || '';
        if (typeof data.bw !== 'object') continue;
        for (const [portId, b] of Object.entries(data.bw)) {
          const fullPortId = srv + '_' + portId;
          const dayIn  = parseBwToBytes(b.bandwidth_bytes_day_in);
          const dayOut = parseBwToBytes(b.bandwidth_bytes_day_out);
          const monIn  = parseBwToBytes(b.bandwidth_bytes_month_in);
          const monOut = parseBwToBytes(b.bandwidth_bytes_month_out);
          const yesIn  = parseBwToBytes(b.bandwidth_bytes_yesterday_in);
          const yesOut = parseBwToBytes(b.bandwidth_bytes_yesterday_out);
          const pmIn   = parseBwToBytes(b.bandwidth_bytes_prev_month_in);
          const pmOut  = parseBwToBytes(b.bandwidth_bytes_prev_month_out);

          const snap = snapCache.get(fullPortId);

          if (dayIn > 0 || dayOut > 0 || monIn > 0 || monOut > 0) {
            // BUG-FIX: preserve day_in/month_in baseline from previous snapshot
            // so the next aggregation computes delta from where it left off.
            // Previously day_in was overwritten with live counter, losing traffic
            // between last aggregation and restart.
            // DEEP-28 (2026-09-24): preserveTs — refresh НЕ передвигает
            // last_updated_at: это не новое измерение, а подтягивание счётчиков
            // при старте; иначе рестарт «омолаживал» baseline и ломал
            // gap-detection на первые часы после перезапуска.
            upsertSnap(fullPortId, {
              day_in: snap ? snap.day_in : dayIn,
              day_out: snap ? snap.day_out : dayOut,
              month_in: snap ? snap.month_in : monIn,
              month_out: snap ? snap.month_out : monOut,
              yesterday_in: yesIn, yesterday_out: yesOut,
              prev_month_in: pmIn, prev_month_out: pmOut,
              day_at_last_hour_start_in: snap ? snap.day_at_last_hour_start_in : dayIn,
              day_at_last_hour_start_out: snap ? snap.day_at_last_hour_start_out : dayOut,
              mon_at_last_hour_start_in: snap ? snap.mon_at_last_hour_start_in : monIn,
              mon_at_last_hour_start_out: snap ? snap.mon_at_last_hour_start_out : monOut,
              pending: 0,
            }, { preserveTs: true });
            updated++;
          } else if (!snap) {
            upsertSnap(fullPortId, {
              day_in: 0, day_out: 0, month_in: 0, month_out: 0,
              yesterday_in: 0, yesterday_out: 0, prev_month_in: 0, prev_month_out: 0,
              day_at_last_hour_start_in: 0, day_at_last_hour_start_out: 0,
              mon_at_last_hour_start_in: 0, mon_at_last_hour_start_out: 0,
              pending: 1,
            });
          }
          // If snap exists and all counters = 0 → keep old snap (offline modem)
        }
      }
    });
    tx();
    logger.info(`[HourlyAgg] Snapshots refreshed (no traffic_hourly write): ${updated} ports`);
  } catch (e) {
    logger.error('[HourlyAgg] refreshSnapshotsOnly error:', e.message);
  }
}

async function aggregateHourlyTraffic() {
  try {
    const results = await fetchAllServersDataCached();
    const pnMap = portKeyToPortNameRef();
    if (Object.keys(pnMap).length === 0) refreshPortKeyMapping(results);
    const now = new Date();
    const nowMs = now.getTime();
    const prevHourStart = nowMs - (nowMs % 3600000) - 3600000;
    const hourStart = new Date(prevHourStart).toISOString().slice(0, 13).replace('T', ' ') + ':00';

    let count = 0;
    let uncertainCount = 0;
    let smoothedCount = 0;       // rows where uncertain=2 was replaced by median of clean neighbours
    let unsmoothableCount = 0;   // uncertain=2 rows we couldn't smooth (not enough neighbours)
    let clampedSpikes = 0;
    let wireScaledCount = 0;     // 2026-09-27: строки, масштабированные к проводу (uncertain=6)
    const MAX_HOURLY_BYTES = 20 * 1e9; // 20 GB sanity cap per port (decimal GB)
    const UNCERTAIN_THRESHOLD = 150 * 1e6; // 150 MB minimum for uncertain flag (above month counter granularity)
    const MONTH_COUNTER_STEP = 1e8; // 100 MB — ProxySmart month counter granularity (decimal)
    // Smoothing of uncertain=2 rows: when day/month counters disagree (counter
    // reset, mid-hour rollover, post-outage catch-up), the raw bytes for the
    // affected hour are unreliable. Replace with median of clean neighbours.
    // Catches the class of bugs the Brandanalytics 2026-05-20 incident exposed.
    const SMOOTH_WINDOW_HOURS = 12;
    const SMOOTH_MIN_NEIGHBOURS = 3;
    const _smoothNeighboursStmt = db.prepare(`
      SELECT bytes_in, bytes_out
      FROM traffic_hourly
      WHERE nick = ? AND client_name = ? AND server_name = ? AND uncertain = 0
        AND hour_start >= datetime(?, '-' || ? || ' hours')
        AND hour_start <  datetime(?, '+' || ? || ' hours')
        AND hour_start != ?
    `);
    // 2026-09-27: фолбэк №3 при записи — последний реальный оператор порта
    // (или ника) из истории. См. комментарий у места использования.
    const _lastKnownOpStmt = db.prepare(`
      SELECT operator FROM traffic_hourly
      WHERE (port_id = ? OR (server_name = ? AND nick = ?))
        AND operator IS NOT NULL AND TRIM(operator) != '' AND LOWER(TRIM(operator)) != 'unknown'
      ORDER BY hour_start DESC LIMIT 1
    `);
    const _median = arr => {
      if (!arr.length) return 0;
      const s = arr.slice().sort((a, b) => a - b);
      return s[Math.floor(s.length / 2)];
    };
    // DEEP-31 (2026-09-24): сверхпороговый час — карантин (uncertain=4):
    // расчётные байты 0 (в суммы и биллинг не попадают), raw-наблюдение
    // сохранено в raw_bytes_* для пересчёта — не бесследный пропуск с
    // передвинутым baseline, как раньше.
    function quarantineHour(srv, fullPortId, nick, operator, clientName, hourStart, rawIn, rawOut) {
      _htUpsert.run(srv, fullPortId, nick, operator, clientName, hourStart,
        0, 0, 4, Math.round(rawIn), Math.round(rawOut));
      logger.warn(`[HourlyAgg] quarantined: ${nick} raw=${((rawIn + rawOut) / 1e9).toFixed(2)}GB >= cap — bytes=0, uncertain=4`);
      try {
        logActivity('billing', 'warn', 'traffic_quarantined', nick,
          `${nick} (${clientName || 'no-client'}): raw=${((rawIn + rawOut) / 1e9).toFixed(2)}GB >= 20GB cap — час в карантине (uncertain=4, bytes=0)`,
          {
            nick, server: srv, port_id: fullPortId, client: clientName, operator,
            hour_start: hourStart,
            raw_bytes_in: Math.round(rawIn), raw_bytes_out: Math.round(rawOut),
            raw_total_gb: +((rawIn + rawOut) / 1e9).toFixed(3),
            reason: 'max_hourly_bytes_exceeded',
          });
      } catch (_) { /* best-effort */ }
    }
    // Spike protection: per-port average over the last 24 clean hours.
    // Used at TZ-reset detection — see section 3.
    const SPIKE_TRIGGER_MULT = 3;
    const SPIKE_CLAMP_MULT   = 1.5;
    const SPIKE_FLOOR = 500 * 1e6;   // 500 MB — don't trigger on tiny ports
    const portAvgBytes = {};
    try {
      const rows = db.prepare(`
        SELECT port_id, AVG(bytes_in + bytes_out) AS avg_b
        FROM traffic_hourly
        WHERE hour_start >= datetime('now','-24 hours') AND uncertain = 0
        GROUP BY port_id
      `).all();
      for (const r of rows) portAvgBytes[r.port_id] = r.avg_b || 0;
    } catch (e) {
      logger.warn('[HourlyAgg] portAvg precompute failed: ' + e.message + ' — clamping disabled this run');
    }

    // 2026-09-27 (миграция 105): проводной учёт. Per-port счётчики ProxySmart
    // на задушенных/перегруженных модемах завышены в 24–48× (считают спрос
    // клиента, а не трафик через модем). Проводная правда — семплы
    // /proc/net/dev интерфейса модема (modem_wire_counters, пишет
    // server-metrics каждые ~10 мин). Строки текущего часа сначала
    // буферизуются (queueRow), в конце обработки сервера для каждого ника с
    // известным iface (net_details.DEV живого фида) считаем проводную дельту
    // за час: последний семпл ≤ конца часа минус последний семпл ≤ начала
    // часа (без интерполяции). Если сумма заявленного по портам модема >
    // wireDelta × 1.3 — масштабируем все порты модема к wireDelta × 1.0
    // (итог = провод), uncertain=6, заявленное — в raw_bytes_* (как кламп
    // фантомов). Нет iface или семплов — записываем как заявлено.
    const WIRE_TOLERANCE = 1.3;
    const hourEnd = new Date(prevHourStart + 3600000).toISOString().slice(0, 13).replace('T', ' ') + ':00';
    const hourRows = [];
    function queueRow(srv, fullPortId, nick, operator, clientName, bytesIn, bytesOut, uncertain, rawIn, rawOut) {
      hourRows.push({ srv, fullPortId, nick, operator, clientName, bytesIn, bytesOut, uncertain, rawIn, rawOut });
    }
    let _wireStmt = null, _wireChecked = false;
    function _wireSampleStmt() {
      if (_wireChecked) return _wireStmt;
      _wireChecked = true;
      try {
        const t = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='modem_wire_counters'").get();
        if (t) {
          _wireStmt = db.prepare(`SELECT rx_bytes, tx_bytes, ts FROM modem_wire_counters
            WHERE server_name = ? AND iface = ? AND ts <= ? ORDER BY ts DESC LIMIT 1`);
        }
      } catch (_) { _wireStmt = null; }
      return _wireStmt;
    }
    // Проводная дельта (rx+tx) за час; null — семплов нет/мало (границы часа
    // обязаны быть РАЗНЫМИ семплами, иначе дельта фиктивно нулевая) или
    // счётчик интерфейса сбросился (reboot модема) → масштабирование пропускаем.
    function wireDeltaForHour(srv, iface) {
      const st = _wireSampleStmt();
      if (!st) return null;
      const a = st.get(srv, iface, hourStart);
      const b = st.get(srv, iface, hourEnd);
      if (!a || !b || b.ts <= a.ts) return null;
      const d = (Number(b.rx_bytes) + Number(b.tx_bytes)) - (Number(a.rx_bytes) + Number(a.tx_bytes));
      return d >= 0 ? d : null;
    }
    function flushHourRows(srv, ifaceByNick) {
      if (!hourRows.length) return;
      const byNick = new Map();
      for (const r of hourRows) {
        const arr = byNick.get(r.nick) || [];
        arr.push(r);
        byNick.set(r.nick, arr);
      }
      for (const [nick, rows] of byNick) {
        const claimed = rows.reduce((s, r) => s + r.bytesIn + r.bytesOut, 0);
        const iface = (ifaceByNick && ifaceByNick[nick]) || '';
        const wireDelta = (iface && claimed > 0) ? wireDeltaForHour(srv, iface) : null;
        const doScale = wireDelta != null && claimed > wireDelta * WIRE_TOLERANCE;
        const k = doScale ? wireDelta / claimed : 1;
        for (const r of rows) {
          if (doScale) {
            const preIn = r.bytesIn, preOut = r.bytesOut;
            r.bytesIn = Math.round(r.bytesIn * k);
            r.bytesOut = Math.round(r.bytesOut * k);
            // raw — самое раннее наблюдение: если фантом-кламп уже сохранил
            // своё raw, не перезаписываем.
            if (r.rawIn == null) r.rawIn = Math.round(preIn);
            if (r.rawOut == null) r.rawOut = Math.round(preOut);
            r.uncertain = 6;
            wireScaledCount++;
            uncertainCount++;
          }
          _htUpsert.run(srv, r.fullPortId, r.nick, r.operator, r.clientName, hourStart,
            r.bytesIn, r.bytesOut, r.uncertain, r.rawIn, r.rawOut);
        }
        if (doScale) {
          logger.warn(`[HourlyAgg] wire-scale: ${nick}@${srv} (${iface}): порты заявили ${(claimed / 1e9).toFixed(2)}GB vs провод ${(wireDelta / 1e9).toFixed(2)}GB → ×${k.toFixed(3)} (uncertain=6)`);
          try {
            logActivity('billing', 'warn', 'traffic_wire_scale', nick,
              `${nick} (${rows[0].clientName || 'no-client'}): порты заявили ${(claimed / 1e9).toFixed(2)}GB, провод ${(wireDelta / 1e9).toFixed(2)}GB — масштабировано к проводу (uncertain=6)`,
              {
                nick, server: srv, iface, hour_start: hourStart,
                ports: rows.length,
                claimed_total_gb: +(claimed / 1e9).toFixed(3),
                wire_delta_gb: +(wireDelta / 1e9).toFixed(3),
                scale: +k.toFixed(4),
                reason: 'port_counters_exceed_wire',
              });
          } catch (_) { /* best-effort */ }
        }
      }
      hourRows.length = 0;
    }

    const batch = db.transaction(() => {
      for (const data of results) {
        const srv = data.serverName || '';
        const srvCountry = (SERVER_COUNTRIES[srv] || {}).country || '';
        const isRO = srvCountry === 'RO';

        // Build portId → modem info map
        const statusArr = Array.isArray(data.status) ? data.status : [];
        const portsMap = data.ports || {};
        const portIdInfo = {};
        const ifaceByNick = {};   // 2026-09-27: ник → интерфейс /proc/net/dev (net_details.DEV)
        for (const m of statusArr) {
          const md = m.modem_details || {};
          const imei = md.IMEI || '';
          const nick = md.NICK || imei;
          const nd = m.net_details || {};
          const operator = nd.CELLOP || md.OPERATOR || '';
          const devIface = String(nd.DEV || '').trim();
          if (devIface && nick) ifaceByNick[nick] = devIface;
          if (!imei) continue;
          const modemPorts = portsMap[imei] || [];
          for (const p of modemPorts) {
            // DEEP-33 (2026-09-24): клонированный IMEI встречается у двух
            // ников — НЕ перезаписываем атрибуцию порта последним модемом
            // (first wins), иначе трафик порта приписывался чужому нику.
            if (!portIdInfo[p.portID]) {
              portIdInfo[p.portID] = { nick, operator, clientName: p.portName || '' };
            }
          }
          if (modemPorts.length === 0) {
            portIdInfo['_imei_' + imei] = { nick, operator, clientName: '' };
          }
        }

        if (typeof data.bw !== 'object') continue;
        for (const [portId, b] of Object.entries(data.bw)) {
          const info = portIdInfo[portId] || {};
          const nick = info.nick || pnMap[srv + '_' + portId] || portId;
          let rawOp = (info.operator || '').toLowerCase().trim();
          // "unknown" is ProxySmart's placeholder for an unresolved carrier name,
          // not a real operator — treat it as missing so we fall back to a
          // persisted source rather than freezing "Unknown" into the row.
          if (rawOp === 'unknown') rawOp = '';
          if (!rawOp && nick) {
            // 1) authoritative per-modem operator (modem_meta)
            const meta = _metaOpGet.get(srv, nick);
            if (meta && meta.operator && meta.operator.toLowerCase().trim() !== 'unknown') {
              rawOp = meta.operator.toLowerCase().trim();
            }
            // 2) last-known operator observed by the proxy-check job. Covers
            //    modems that never landed a modem_meta row (e.g. RO2_3) but
            //    whose carrier was seen during latency checks.
            if (!rawOp && _pcOpGet) {
              const pc = _pcOpGet.get(srv, nick);
              if (pc && pc.operator) rawOp = pc.operator.toLowerCase().trim();
            }
            // 3) 2026-09-27: последний известный оператор ЭТОГО порта (или
            //    ника) из истории traffic_hourly. Покрывает окно после
            //    переезда SIM / рестарта панели, когда CELLOP ещё «unknown»,
            //    а modem_meta/proxy_checks пусты: раньше такие часы навсегда
            //    уходили в БД с operator='' и выпадали из разбивок по
            //    операторам. Берутся только реальные значения (не '' и не
            //    'unknown'); если у порта ещё нет истории — остаётся ''.
            if (!rawOp) {
              try {
                const last = _lastKnownOpStmt.get(srv + '_' + portId, srv, nick);
                if (last && last.operator) rawOp = last.operator.toLowerCase().trim();
              } catch (_) { /* best-effort: фолбэк не должен ронять агрегацию */ }
            }
          }
          const operator = normalizeOperator(rawOp, isRO);
          const clientName = info.clientName || b.portName || '';
          const fullPortId = srv + '_' + portId;

          // Read all 8 counters
          const dayIn   = parseBwToBytes(b.bandwidth_bytes_day_in);
          const dayOut  = parseBwToBytes(b.bandwidth_bytes_day_out);
          const monIn   = parseBwToBytes(b.bandwidth_bytes_month_in);
          const monOut  = parseBwToBytes(b.bandwidth_bytes_month_out);
          const yesIn   = parseBwToBytes(b.bandwidth_bytes_yesterday_in);
          const yesOut  = parseBwToBytes(b.bandwidth_bytes_yesterday_out);
          const pmIn    = parseBwToBytes(b.bandwidth_bytes_prev_month_in);
          const pmOut   = parseBwToBytes(b.bandwidth_bytes_prev_month_out);

          const snap = snapCache.get(fullPortId);

          // --- 1. No snapshot → baseline ---
          if (!snap) {
            upsertSnap(fullPortId, {
              day_in: dayIn, day_out: dayOut,
              month_in: monIn, month_out: monOut,
              yesterday_in: yesIn, yesterday_out: yesOut,
              prev_month_in: pmIn, prev_month_out: pmOut,
              day_at_last_hour_start_in: dayIn, day_at_last_hour_start_out: dayOut,
              mon_at_last_hour_start_in: monIn, mon_at_last_hour_start_out: monOut,
              pending: (dayIn > 0 || monIn > 0) ? 0 : 1,
            });
            continue;
          }

          // --- 2. Pending baseline → wait for real data ---
          if (snap.pending) {
            if (dayIn > 0 || dayOut > 0 || monIn > 0 || monOut > 0) {
              upsertSnap(fullPortId, {
                ...snap,
                day_in: dayIn, day_out: dayOut,
                month_in: monIn, month_out: monOut,
                yesterday_in: yesIn, yesterday_out: yesOut,
                prev_month_in: pmIn, prev_month_out: pmOut,
                day_at_last_hour_start_in: dayIn, day_at_last_hour_start_out: dayOut,
                mon_at_last_hour_start_in: monIn, mon_at_last_hour_start_out: monOut,
                pending: 0,
              });
            }
            continue;
          }

          // --- 3. Day reset detection ---
          // Day counter dropped significantly since last poll — this is the
          // nightly UTC-midnight rollover that ProxySmart applies to day_*
          // counters. The old detector also required `yesIn > 0`, but
          // ProxySmart often hasn't propagated the yesterday counter at the
          // exact 00:00 UTC poll → detector silently missed the reset →
          // fall-through to "Normal hour" wrote uncertain=2 every single
          // night. We instead guard against false positives by requiring a
          // RECENT snap (≤2h old) — that means yesterday was a normal day,
          // not a multi-day outage masquerading as a reset.
          const snapLastMs = snap.last_updated_at
            ? Date.parse(snap.last_updated_at.replace(' ', 'T') + 'Z')
            : 0;
          const snapRecent = snapLastMs > 0 && (nowMs - snapLastMs) < 2 * 3600000;
          const dayDropped = snapRecent
                          && snap.day_at_last_hour_start_in > 0
                          && dayIn < snap.day_at_last_hour_start_in * 0.5;
          // Same >50% day-counter drop but WITHOUT the snapRecent guard. Catches
          // ports whose snapshot went stale (briefly unpolled) across the reset
          // hour: those previously matched neither dayDropped (snap not recent)
          // nor yesterdayChanged, fell through to "Normal hour" where
          // delta=max(0, small−huge)=0, and so the 00:00 MSK hour was dropped
          // ENTIRELY (both the pre-reset tail AND the post-reset accumulation).
          // A >50% drop is unambiguously the midnight rollover — counters only
          // fall at reset — so detecting it here is safe; the spike-clamp below
          // still guards the tail increment against stale-baseline blowups.
          const dayCounterDropped = snap.day_in > 0 && dayIn < snap.day_in * 0.5;
          const yesterdayChanged = yesIn > snap.day_in
                                && yesIn !== snap.yesterday_in;
          const dayReset = dayDropped || yesterdayChanged || dayCounterDropped;

          if (dayReset) {
            // Last hour of the day delta. Prefer the yesterday counter when
            // it's populated (precise — single-byte granularity). Fall back
            // to month-counter delta when ProxySmart hasn't propagated
            // yesterday yet — the month counter is the only one that doesn't
            // reset at day boundary, so it gives us a usable estimate.
            let incIn, incOut;
            if (yesIn > 0) {
              incIn  = Math.max(0, yesIn  - snap.day_at_last_hour_start_in);
              incOut = Math.max(0, yesOut - snap.day_at_last_hour_start_out);
            } else {
              incIn  = Math.max(0, monIn  - snap.mon_at_last_hour_start_in);
              incOut = Math.max(0, monOut - snap.mon_at_last_hour_start_out);
            }
            // Spike protection: when day_at_last_hour_start is stale (modem
            // briefly offline and snap missed a few hours), `yesIn - baseline`
            // captures many hours of traffic in one bucket → heatmap spike.
            // If the increment is far above this port's recent average, clamp
            // it and mark uncertain so the UI doesn't show a misleading peak.
            let resetUnc = 0;
            let clampRawIn = null, clampRawOut = null;   // DEEP-31: raw до clamp
            const portAvg = portAvgBytes[fullPortId] || 0;
            const incTotal = incIn + incOut;
            if (portAvg > SPIKE_FLOOR && incTotal > portAvg * SPIKE_TRIGGER_MULT) {
              const cap = portAvg * SPIKE_CLAMP_MULT;
              const ratio = cap / incTotal;
              clampRawIn = incIn; clampRawOut = incOut;
              incIn  = Math.floor(incIn  * ratio);
              incOut = Math.floor(incOut * ratio);
              resetUnc = 2;
              clampedSpikes++;
              logger.warn(`[HourlyAgg] reset spike clamped: ${nick} ${(incTotal/1e9).toFixed(2)}GB→${(cap/1e9).toFixed(2)}GB (avg=${(portAvg/1e9).toFixed(2)}GB)`);
              // Stage 18.3: persist to system_log so the admin can audit later.
              // We record BOTH the raw (suspected wrong) inc and the corrected
              // (clamped) inc so a human can decide whether the clamp was
              // justified — and adjust SPIKE_TRIGGER_MULT / SPIKE_CLAMP_MULT
              // if pattern emerges.
              try {
                logActivity('billing', 'warn', 'traffic_spike_clamp', nick,
                  `${nick} (${clientName||'no-client'}): raw=${(incTotal/1e9).toFixed(2)}GB → clamp=${(cap/1e9).toFixed(2)}GB (24h avg ${(portAvg/1e9).toFixed(2)}GB)`,
                  {
                    nick, server: srv, port_id: fullPortId, client: clientName, operator,
                    hour_start: hourStart,
                    raw_bytes_in: clampRawIn, raw_bytes_out: clampRawOut, raw_total_gb: +(incTotal/1e9).toFixed(3),
                    corrected_bytes_in: incIn, corrected_bytes_out: incOut, corrected_total_gb: +((incIn+incOut)/1e9).toFixed(3),
                    port_avg_gb: +(portAvg/1e9).toFixed(3),
                    reason: 'day_reset_spike',
                  });
              } catch (_) { /* logActivity must never throw — best-effort */ }
            }
            // When the DAY counter actually reset (dayDropped — not just the
            // yesterday counter flipping early), the current dayIn is the
            // post-reset accumulation: traffic that already happened in THIS hour
            // since local midnight. The old code parked it via baseline=0, so it
            // landed in the NEXT bucket and left the 00:00–01:00 hour empty for
            // every modem whose reset was detected one poll late (~2/3 of the
            // fleet — hour 0 showed ~32/100 modems). Fold it into this hour and
            // carry it as the new baseline: total conserved, no double-count.
            let storeIn = incIn, storeOut = incOut, baseIn = 0, baseOut = 0;
            if (dayDropped || dayCounterDropped) {
              // Fold the post-reset accumulation (current dayIn) into THIS hour
              // and carry it forward as the new baseline. Safe whenever the day
              // counter actually fell: the "Normal hour" path would have written
              // max(0, dayIn − snap.day_in) = 0 for this port, so there is nothing
              // to double-count, and baseIn=dayIn makes the next hour subtract it.
              // (Pure yesterdayChanged — counter still rising — keeps baseIn=0 so
              // the still-growing dayIn lands in the next bucket as before.)
              storeIn  = incIn  + Math.max(0, dayIn);
              storeOut = incOut + Math.max(0, dayOut);
              baseIn   = Math.max(0, dayIn);
              baseOut  = Math.max(0, dayOut);
            }
            if (storeIn + storeOut > 0) {
              if (storeIn + storeOut >= MAX_HOURLY_BYTES) {
                quarantineHour(srv, fullPortId, nick, operator, clientName, hourStart, storeIn, storeOut);
              } else {
                queueRow(srv, fullPortId, nick, operator, clientName, storeIn, storeOut, resetUnc, clampRawIn, clampRawOut);
              }
              count++;
            }
            upsertSnap(fullPortId, {
              day_in: baseIn, day_out: baseOut,
              month_in: monIn, month_out: monOut,
              yesterday_in: yesIn, yesterday_out: yesOut,
              prev_month_in: pmIn, prev_month_out: pmOut,
              day_at_last_hour_start_in: baseIn, day_at_last_hour_start_out: baseOut,
              mon_at_last_hour_start_in: monIn, mon_at_last_hour_start_out: monOut,
              pending: 0,
            });
            continue;
          }

          // --- 4. Month reset detection ---
          const monthReset = pmIn > snap.month_in
                          && monIn < snap.month_in * 0.1;

          if (monthReset) {
            const incIn  = Math.max(0, pmIn  - snap.mon_at_last_hour_start_in);
            const incOut = Math.max(0, pmOut - snap.mon_at_last_hour_start_out);
            if (incIn + incOut > 0) {
              if (incIn + incOut >= MAX_HOURLY_BYTES) {
                quarantineHour(srv, fullPortId, nick, operator, clientName, hourStart, incIn, incOut);
              } else {
                queueRow(srv, fullPortId, nick, operator, clientName, incIn, incOut, 0, null, null);
              }
              count++;
            }
            // BUG-FIX: set month baseline to 0 so next cross-validation
            // captures all post-reset month traffic
            upsertSnap(fullPortId, {
              day_in: dayIn, day_out: dayOut,
              month_in: 0, month_out: 0,
              yesterday_in: yesIn, yesterday_out: yesOut,
              prev_month_in: pmIn, prev_month_out: pmOut,
              day_at_last_hour_start_in: dayIn, day_at_last_hour_start_out: dayOut,
              mon_at_last_hour_start_in: 0, mon_at_last_hour_start_out: 0,
              pending: 0,
            });
            continue;
          }

          // --- 5. Normal hour: day-delta with month cross-validation ---
          const incInDay  = Math.max(0, dayIn  - snap.day_in);
          const incOutDay = Math.max(0, dayOut - snap.day_out);
          const deltaDay  = incInDay + incOutDay;

          const incInMon  = Math.max(0, monIn  - snap.month_in);
          const incOutMon = Math.max(0, monOut - snap.month_out);
          const deltaMon  = incInMon + incOutMon;

          // Cross-validation
          let uncertain = 0;
          let finalIncIn  = incInDay;
          let finalIncOut = incOutDay;

          if (deltaDay > 0 && deltaMon > 0) {
            const absDiff = Math.abs(deltaDay - deltaMon);
            // Tolerance must scale with traffic volume:
            //   - Floor: 2× month counter step (~214 MB) for low-traffic hours
            //   - Proportional: 25% of deltaDay for high-traffic hours
            // Pure 214 MB floor was too tight for 1-3 GB hours where 0.1 GB
            // counter quantization can produce >300 MB absolute drift.
            const tolerance = Math.max(2 * MONTH_COUNTER_STEP, deltaDay * 0.25);
            if (absDiff > tolerance && deltaDay > UNCERTAIN_THRESHOLD) {
              uncertain = 2;
              uncertainCount++;
              logger.warn(`[HourlyAgg] uncertain: nick=${nick} day_delta=${(deltaDay/1e6).toFixed(1)}MB month_delta=${(deltaMon/1e6).toFixed(1)}MB diff=${(absDiff/1e6).toFixed(1)}MB tolerance=${(tolerance/1e6).toFixed(1)}MB`);
              try {
                logActivity('billing', 'warn', 'traffic_counter_disagree', nick,
                  `${nick} (${clientName||'no-client'}): day=${(deltaDay/1e6).toFixed(1)}MB vs month=${(deltaMon/1e6).toFixed(1)}MB, diff=${(absDiff/1e6).toFixed(1)}MB > tol=${(tolerance/1e6).toFixed(1)}MB`,
                  {
                    nick, server: srv, port_id: fullPortId, client: clientName, operator,
                    hour_start: hourStart,
                    day_delta_mb: +(deltaDay/1e6).toFixed(1),
                    month_delta_mb: +(deltaMon/1e6).toFixed(1),
                    abs_diff_mb: +(absDiff/1e6).toFixed(1),
                    tolerance_mb: +(tolerance/1e6).toFixed(1),
                    reason: 'day_month_counter_disagree',
                  });
              } catch (_) { /* best-effort */ }
            }
          } else if (deltaMon > UNCERTAIN_THRESHOLD && deltaDay === 0) {
            // Month counter grew significantly but day counter shows zero — counter anomaly.
            // 2026-09-17: раньше такая дельта ТЕРЯЛась (finalInc оставался по дневному
            // счётчику = 0) — трафик не попадал в traffic_hourly и биллинг
            // (кейс MD_19/MD3_*: day=0, month растёт). Теперь доверяем месячной
            // дельте и пишем её (с пометкой uncertain=2).
            finalIncIn = incInMon;
            finalIncOut = incOutMon;
            uncertain = 2;
            uncertainCount++;
            logger.warn(`[HourlyAgg] uncertain (month>0, day=0): nick=${nick} day_delta=${(deltaDay/1e6).toFixed(1)}MB month_delta=${(deltaMon/1e6).toFixed(1)}MB`);
            try {
              logActivity('billing', 'warn', 'traffic_counter_disagree', nick,
                `${nick} (${clientName||'no-client'}): day=0 but month=${(deltaMon/1e6).toFixed(1)}MB`,
                {
                  nick, server: srv, port_id: fullPortId, client: clientName, operator,
                  hour_start: hourStart,
                  day_delta_mb: 0,
                  month_delta_mb: +(deltaMon/1e6).toFixed(1),
                  reason: 'month_grew_day_zero',
                });
            } catch (_) { /* best-effort */ }
          }
          // NOTE: deltaDay > 0 && deltaMon === 0 is NORMAL — month counter has 0.1GB quantization
          // and won't increment for small traffic bursts. Don't flag this as uncertain.

          // --- Gap detection: split delta across missed hours ---
          // If last_updated_at is more than ~1.5h in the past, the ProxySmart
          // server was likely offline. Spread the accumulated delta evenly
          // across the missed hours (marked uncertain=1 to distinguish from
          // counter anomalies which use uncertain=2).
          let missedHours = 0;
          if (snap.last_updated_at) {
            const lastMs = Date.parse(snap.last_updated_at.replace(' ', 'T') + 'Z');
            if (!isNaN(lastMs)) {
              const gapMs = nowMs - lastMs;
              // More than 1 hour 30 minutes → gap
              if (gapMs > 5400000) {
                missedHours = Math.min(Math.floor(gapMs / 3600000), 48);
              }
            }
          }

          const totalInc = finalIncIn + finalIncOut;
          if (totalInc >= MAX_HOURLY_BYTES) {
            // DEEP-31: сверхпороговый час — карантин вместо бесследного
            // пропуска (baseline при этом передвигается штатно ниже, но
            // наблюдение сохранено в raw_*, в суммы не попадает).
            quarantineHour(srv, fullPortId, nick, operator, clientName, hourStart, finalIncIn, finalIncOut);
            count++;
            uncertainCount++;
          } else if (totalInc > 0) {
            if (missedHours > 1) {
              // Split delta evenly across missed hours, keep the current hour row as uncertain=1
              const splitCount = missedHours;
              const perHourIn  = Math.floor(finalIncIn  / splitCount);
              const perHourOut = Math.floor(finalIncOut / splitCount);
              let remIn  = finalIncIn  - perHourIn  * splitCount;
              let remOut = finalIncOut - perHourOut * splitCount;
              for (let k = splitCount - 1; k >= 0; k--) {
                const bucketMs = prevHourStart - k * 3600000;
                const bucketHourStart = new Date(bucketMs).toISOString().slice(0,13).replace('T',' ') + ':00';
                const bin  = perHourIn  + (remIn  > 0 ? 1 : 0);  if (remIn  > 0) remIn--;
                const bout = perHourOut + (remOut > 0 ? 1 : 0);  if (remOut > 0) remOut--;
                if (bin + bout > 0) {
                  _htUpsert.run(srv, fullPortId, nick, operator, clientName, bucketHourStart, bin, bout, 1, null, null);
                }
              }
              count++;
              uncertainCount++;
              logger.warn(`[HourlyAgg] gap filled: nick=${nick} missed ${missedHours}h, total=${(totalInc/1e6).toFixed(1)}MB split evenly`);
            } else {
              // Auto-smooth uncertain=2 (counter disagreement) — replace bytes
              // with median of clean neighbours so a counter glitch doesn't
              // inflate the heatmap or billing. Fallback: write as-is when
              // there aren't enough clean neighbours (sparse history).
              let smoothRawIn = null, smoothRawOut = null;   // DEEP-31: raw до сглаживания
              if (uncertain === 2) {
                const neigh = _smoothNeighboursStmt.all(
                  nick, clientName, srv,
                  hourStart, SMOOTH_WINDOW_HOURS,
                  hourStart, SMOOTH_WINDOW_HOURS,
                  hourStart
                );
                if (neigh.length >= SMOOTH_MIN_NEIGHBOURS) {
                  const newIn  = _median(neigh.map(n => n.bytes_in  || 0));
                  const newOut = _median(neigh.map(n => n.bytes_out || 0));
                  smoothRawIn = finalIncIn; smoothRawOut = finalIncOut;
                  logger.info(`[HourlyAgg] smoothed uncertain=2: nick=${nick} client=${clientName} ${(finalIncIn/1e6).toFixed(0)}+${(finalIncOut/1e6).toFixed(0)}MB → ${(newIn/1e6).toFixed(0)}+${(newOut/1e6).toFixed(0)}MB (median of ${neigh.length})`);
                  finalIncIn = newIn;
                  finalIncOut = newOut;
                  uncertain = 3;  // mark as auto-corrected (heatmap still shows the stripe)
                  smoothedCount++;
                  try {
                    logActivity('billing', 'info', 'traffic_smoothed', nick,
                      `${nick} (${clientName||'no-client'}): raw=${((smoothRawIn+smoothRawOut)/1e6).toFixed(1)}MB → median=${((newIn+newOut)/1e6).toFixed(1)}MB (${neigh.length} neighbours)`,
                      {
                        nick, server: srv, port_id: fullPortId, client: clientName, operator,
                        hour_start: hourStart,
                        raw_bytes_in: smoothRawIn, raw_bytes_out: smoothRawOut, raw_total_mb: +((smoothRawIn+smoothRawOut)/1e6).toFixed(1),
                        corrected_bytes_in: newIn, corrected_bytes_out: newOut, corrected_total_mb: +((newIn+newOut)/1e6).toFixed(1),
                        neighbours_used: neigh.length,
                        reason: 'median_smoothing',
                      });
                  } catch (_) { /* best-effort */ }
                } else {
                  unsmoothableCount++;
                  logger.warn(`[HourlyAgg] uncertain=2 kept (no clean neighbours): nick=${nick} client=${clientName} bytes=${((finalIncIn+finalIncOut)/1e6).toFixed(0)}MB`);
                  try {
                    logActivity('billing', 'warn', 'traffic_uncertain_kept', nick,
                      `${nick} (${clientName||'no-client'}): uncertain=2 kept, raw=${((finalIncIn+finalIncOut)/1e6).toFixed(1)}MB, no clean neighbours`,
                      {
                        nick, server: srv, port_id: fullPortId, client: clientName, operator,
                        hour_start: hourStart,
                        raw_bytes_in: finalIncIn, raw_bytes_out: finalIncOut, raw_total_mb: +((finalIncIn+finalIncOut)/1e6).toFixed(1),
                        neighbours_found: neigh.length,
                        reason: 'insufficient_neighbours_for_smoothing',
                      });
                  } catch (_) { /* best-effort */ }
                }
              }
              queueRow(srv, fullPortId, nick, operator, clientName, finalIncIn, finalIncOut, uncertain, smoothRawIn, smoothRawOut);
              count++;
            }
          }

          // Update snap. We ALWAYS update day_at_last_hour_start so the
          // baseline never goes stale — that's what was creating spikes at
          // TZ-reset hour for ports whose modems were briefly offline.
          // For totally idle ports (all counters = 0) we still write the
          // baseline so the next reset uses a fresh reference.
          upsertSnap(fullPortId, {
            day_in: dayIn, day_out: dayOut,
            month_in: monIn, month_out: monOut,
            yesterday_in: yesIn, yesterday_out: yesOut,
            prev_month_in: pmIn, prev_month_out: pmOut,
            day_at_last_hour_start_in: dayIn, day_at_last_hour_start_out: dayOut,
            mon_at_last_hour_start_in: monIn, mon_at_last_hour_start_out: monOut,
            pending: 0,
          });
        }

        // Проводное масштабирование (миграция 105): все порты сервера за час
        // посчитаны — сравниваем суммы по модемам с проводной дельтой и пишем.
        flushHourRows(srv, ifaceByNick);
      }
      _htCleanup();
    });
    try {
      batch();
    } catch (e) {
      // The SQLite transaction rolled back, but snapCache was mutated by
      // upsertSnap() calls inside the batch (it's a plain in-memory Map).
      // Reload from DB so cache mirrors persisted truth.
      loadSnapCache();
      throw e;
    }
    const extra1 = uncertainCount > 0 ? `, ${uncertainCount} uncertain` : '';
    const extra2 = clampedSpikes > 0 ? `, ${clampedSpikes} reset-spikes clamped` : '';
    const extra3 = smoothedCount > 0 ? `, ${smoothedCount} auto-smoothed` : '';
    const extra4 = unsmoothableCount > 0 ? `, ${unsmoothableCount} uncertain-kept` : '';
    const extra5 = wireScaledCount > 0 ? `, ${wireScaledCount} wire-scaled` : '';
    logger.info(`[HourlyAgg] Stored ${hourStart}, ${count} port entries, ${snapCache.size} tracked${extra1}${extra2}${extra3}${extra4}${extra5}`);
    // Stage 18.13 — too many spike-clamps in one hour is suspicious
    // (could mean genuine traffic surge, OR aggregator-corruption pattern).
    if (clampedSpikes >= 5) {
      try { require('../telegram/alerts').trigger('traffic_spike_burst', { count: clampedSpikes }); } catch (_) {}
    }
    // 2026-09-24 · DEEP-35/round14: структурированный результат. Достоверный
    // нулевой объём (весь флот офлайн) — completed с rows=0, а не ошибка.
    return { status: 'completed', rows: count, hour: hourStart };
  } catch (e) {
    logger.error('[HourlyAgg] Error: ' + (e.stack || e.message));
    // Ошибка источника (fetch/SQLite) — failed, а не «успех с 0 строк»:
    // планировщик обязан отличать провал данных и планировать retry.
    return { status: 'failed', error: e.message };
  }
}

function getSnapshotCount() { return snapCache.size; }

module.exports = { init, aggregateHourlyTraffic, refreshSnapshotsOnly, getSnapshotCount };
