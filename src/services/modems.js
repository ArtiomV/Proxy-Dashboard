'use strict';
//
// src/services/modems.js — roster-сервисы модемов: updateKnownModems
// (запоминает каждый увиденный модем/порт с client-атрибуцией) и
// injectOfflineModems (добавляет офлайн-плейсхолдеры в живой ответ, чтобы
// интерфейс видел отключённые модемы). Extracted from server.js (Stage 9) —
// перенос без изменения логики (Stage 18.x история сохранена в комментариях).

function create(deps) {
  const {
    db, logger, knownModems, saveKnownModems, deletedModemSet, appSettings, trackingDb,
  } = deps;

  /**
   * Update known modems from fresh (non-cached) server data.
   * Remembers each modem ever seen so we can inject them as offline later.
   */
  // Move-dedupe: тот же модем (imei) под тем же клиентом держит ОДИН порт в
  // ростере — при пере-энумерации с новым portID старый дубль вытесняется,
  // иначе total клиента раздувается (2026-08-02). В реальной раскладке у
  // клиентов один порт на модем (проверено по биндингам БА: 31 порт ↔ 31 imei),
  // поэтому совпадение imei+client = пере-энумерация, а не второй тариф.
  function _dedupeSameModemClient(km, imei, portName, keepPid, feedIds) {
    if (!imei || !portName) return;
    for (const pid of Object.keys(km)) {
      if (pid === keepPid) continue;
      const info = km[pid];
      if (info && info.imei === imei && info.portName === portName) delete km[pid];
    }
  }

  function updateKnownModems(data) {
    if (data._cached) return;
    const srvName = data.serverName;
    if (!knownModems[srvName]) knownModems[srvName] = {};
    const km = knownModems[srvName];
    const now = Date.now();

    // Build portId → imei map from ports data
    const portIdToImei = {};
    if (data.ports && typeof data.ports === 'object') {
      for (const [imei, portList] of Object.entries(data.ports)) {
        if (Array.isArray(portList)) {
          for (const p of portList) {
            if (p.portID) portIdToImei[p.portID] = imei;
          }
        }
      }
    }
    // Полный сет portId текущего фида (bw + binding list) — нужен дедупу,
    // чтобы не трогать вторые ЖИВЫЕ порты того же модема.
    const _feedPortIds = new Set(Object.keys(data.bw || {}));
    for (const pid of Object.keys(portIdToImei)) _feedPortIds.add(pid);

    // Update known modems with currently present data
    if (data.bw && typeof data.bw === 'object') {
      for (const [portId, bw] of Object.entries(data.bw)) {
        const imei = portIdToImei[portId] || '';
        let modemStatus = null;
        if (Array.isArray(data.status)) {
          modemStatus = data.status.find(m => m.modem_details && m.modem_details.IMEI === imei);
        }
        let portInfo = null;
        if (data.ports && data.ports[imei]) {
          const arr = Array.isArray(data.ports[imei]) ? data.ports[imei] : [];
          portInfo = arr.find(p => p.portID === portId) || null;
        }
        // ProxySmart auto-renames a port to "randomport*" when its modem falls off /
        // the port is reset. That is NOT a real client binding — but we must NOT wipe
        // the previous client either: otherwise a client's modem silently vanishes from
        // its count the moment it disconnects (instead of staying counted as offline).
        // So: keep the LAST real client portName, and track `lastClientSeen` which only
        // advances on a real (non-random) name. The roster (src/routes/ops-ext.js) ages
        // the binding out after its retention window, so a permanently-reset modem
        // eventually drops while a brief disconnect stays counted as the client's.
        const rawPortName = bw.portName || '';
        const isRealClient = rawPortName && !/^randomport\d+$/i.test(rawPortName);
        const prevKm = km[portId] || {};
        const keptPortName = isRealClient ? rawPortName : (prevKm.portName || '');
        const lastClientSeen = isRealClient
          ? now
          : (prevKm.lastClientSeen || (prevKm.portName ? (prevKm.lastSeen || now) : 0));
        // 041: PERMANENT soft-delete. A soft-deleted modem stays hidden FOREVER,
        // regardless of online status. The previous auto-restore (un-delete on a
        // poll where the modem reported IS_ONLINE='yes' with a real client port)
        // is removed entirely: an intermittently-online box4/S4 modem would blip
        // online for a SINGLE poll, clear the deleted flag, and re-appear — then
        // drop offline again, so a delete never "stuck" (gone → back → gone). Now a
        // deleted modem is always skipped here; the only way back is an explicit
        // admin un-delete (POST .../restore → metaUndelete + drop from the set).
        if (imei && deletedModemSet.has(srvName + '|' + imei)) {
          continue;
        }
        const nick = (modemStatus && modemStatus.modem_details && modemStatus.modem_details.NICK) || prevKm.nick || '';
        // A port with no identity (no IMEI in the port map, no NICK in the live
        // status) is kept ONLY while it has a real client binding right now —
        // then it's billing traffic and must count as the client's modem (БА
        // «30 vs 32» case). An identity-less placeholder with NO real binding
        // (random/empty portName) is a ProxySmart glitch — skipped.
        if (!imei && !nick && !isRealClient) continue;
        km[portId] = {
          portName: keptPortName,
          imei,
          nick,
          model: (modemStatus && modemStatus.modem_details && (modemStatus.modem_details.MODEL_SHOWN || modemStatus.modem_details.MODEL)) || prevKm.model || '',
          portInfo: portInfo ? (typeof structuredClone === 'function' ? structuredClone(portInfo) : JSON.parse(JSON.stringify(portInfo))) : (prevKm.portInfo ? prevKm.portInfo : null),
          lastSeen: now,
          lastClientSeen
        };
        _dedupeSameModemClient(km, imei, keptPortName, portId, _feedPortIds);
      }
    }

    // 2026-08-02 (БА «31 вместо 32»): ingest bound ports that are missing from
    // the bw feed. ProxySmart keeps a port's binding in list_ports_json even
    // when its modem is dark (no traffic counters → no bw row → the roster
    // used to LOSE the port and the client's total dropped). The binding list
    // is authoritative: a port present there with a real portName belongs to
    // that client whether or not its modem is alive right now.
    const _seenPortIds = new Set(Object.keys(data.bw || {}));
    const _portsLoaded = data.ports && typeof data.ports === 'object' && Object.keys(data.ports).length > 0;
    if (_portsLoaded) {
      for (const [imei, portList] of Object.entries(data.ports)) {
        if (!Array.isArray(portList)) continue;
        for (const p of portList) {
          if (!p || !p.portID || _seenPortIds.has(p.portID)) continue;
          const rawPortName = p.portName || '';
          const isRealClient = rawPortName && !/^randomport\d+$/i.test(rawPortName);
          const prevKm = km[p.portID] || {};
          const keptPortName = isRealClient ? rawPortName : (prevKm.portName || '');
          if (!keptPortName) continue;                       // никогда не был за клиентом
          if (imei && deletedModemSet.has(srvName + '|' + imei)) continue;   // 041: soft-delete вечный
          km[p.portID] = {
            portName: keptPortName,
            imei: imei || prevKm.imei || '',
            nick: prevKm.nick || '',
            model: prevKm.model || '',
            portInfo: (typeof structuredClone === 'function' ? structuredClone(p) : JSON.parse(JSON.stringify(p))),
            lastSeen: now,
            lastClientSeen: isRealClient ? now : (prevKm.lastClientSeen || now),
          };
          _seenPortIds.add(p.portID);
          _dedupeSameModemClient(km, imei, keptPortName, p.portID, _feedPortIds);
        }
      }
      // Реконсиляция с боксом (2026-08-04): липкий ростер ≠ вечный. Реквизит,
      // которого нет в list_ports_json и bw НЕПРЕРЫВНО дольше RECONCILE_MS
      // (7 дней), считается удалённым на боксе и выбывает — так админка
      // сходится с фактом, а короткие флапы (ребут, хаб, API) не влияют.
      // Метка ставится только по СВЕЖИМ данным бокса (не кэш).
      const RECONCILE_MS = 7 * 24 * 3600 * 1000;
      for (const pid of Object.keys(km)) {
        if (_seenPortIds.has(pid)) {
          if (km[pid] && km[pid]._missingSince) delete km[pid]._missingSince;
          continue;
        }
        if (!km[pid]._missingSince) { km[pid]._missingSince = now; continue; }
        if (now - km[pid]._missingSince > RECONCILE_MS) delete km[pid];
      }
    }

    saveKnownModems();
  }

  /**
   * Inject offline modems: for modems that the live ProxySmart response does NOT
   * contain, add them back as offline placeholders so the admin still sees them.
   *
   * Stage 18 — DUAL SOURCE:
   *   1. `known_modems[srv]`  — primary, port-id keyed (gives us a real port_id
   *                              and any cached portInfo so the row links to a
   *                              working proxy config).
   *   2. `modem_meta` (SQLite) — fallback for modems that vanished from
   *                              known_modems. Only a synthetic port
   *                              id of the form `meta_<imei>`. The `updateKnownModems()` polling loop will
   *                              replace it with the real port_id the moment ProxySmart sees the modem again.
   */
  function injectOfflineModems(data) {
    const srvName = data.serverName;
    const km = knownModems[srvName] || {};

    const currentPortIds = new Set(Object.keys(data.bw || {}));
    // Track IMEIs we've already accounted for (live OR injected) so the modem_meta
    // pass doesn't double-add a modem that's already on the page.
    const seenImeis = new Set(
      (Array.isArray(data.status) ? data.status : [])
        .map(m => m.modem_details ? m.modem_details.IMEI : null)
        .filter(Boolean)
    );

    // Stage 18.4: stable operator-count fix. Pre-fix, offline modems had
    // CELLOP='' in net_details — so the frontend tooltip's "(N)" badge for
    // operators only counted ONLINE modems. The number jumped around as
    // modems went on/off. Now we look up the last-known operator from
    // modem_meta and stamp it on the injected placeholder. The frontend
    // logic (which counts via CELLOP) stays untouched and the badge becomes
    // stable — it reflects "how many modems with operator X belong to this
    // client/country" regardless of who's online right now.
    //
    // Cached per-call to avoid N+1: ONE query upfront for all relevant IMEIs
    // (gets the most recent operator per server+imei).
    let _metaOpByImei = null;
    function _loadMetaOperators() {
      if (_metaOpByImei) return _metaOpByImei;
      _metaOpByImei = {};
      try {
        const rows = db.prepare(
          "SELECT imei, operator FROM modem_meta WHERE server_name = ? AND operator IS NOT NULL AND TRIM(operator) != ''"
        ).all(srvName);
        for (const r of rows) _metaOpByImei[r.imei] = r.operator;
      } catch (e) { /* best-effort */ }
      return _metaOpByImei;
    }

    function _injectPlaceholder(portId, imei, nick, model, portInfo) {
      const opMap = _loadMetaOperators();
      const lastKnownOp = opMap[imei] || '';
      if (!data.bw) data.bw = {};
      data.bw[portId] = {
        portName: '',
        bandwidth_bytes_day_in: '0 B',
        bandwidth_bytes_day_out: '0 B',
        bandwidth_bytes_yesterday_in: '0 B',
        bandwidth_bytes_yesterday_out: '0 B',
        bandwidth_bytes_month_in: '0 B',
        bandwidth_bytes_month_out: '0 B',
        bandwidth_bytes_prevmonth_in: '0 B',
        bandwidth_bytes_prevmonth_out: '0 B',
        bandwidth_bytes_lifetime_in: '0 B',
        bandwidth_bytes_lifetime_out: '0 B',
        _offline: true
      };
      if (!Array.isArray(data.status)) data.status = [];
      data.status.push({
        modem_details: {
          IMEI: imei,
          NICK: nick || '',
          MODEL_SHOWN: model || '',
          MODEL: model || ''
        },
        net_details: {
          IS_ONLINE: 'no',
          EXT_IP: '',
          CELLOP: lastKnownOp,         // Stage 18.4 — last-known operator, not blank
          CurrentNetworkType: ''
        },
        _server: srvName,
        _offline: true
      });
      if (!data.ports) data.ports = {};
      if (portInfo) {
        if (!data.ports[imei]) data.ports[imei] = [];
        const exists = data.ports[imei].find(p => p.portID === portId);
        if (!exists) data.ports[imei].push({ ...portInfo, _offline: true });
      }
      seenImeis.add(imei);
    }

    // ── Pass 1 — known_modems (primary)
    // Stage 18.19: previous gate `if (currentPortIds.has(portId)) continue`
    // skipped the modem outright if its bw entry was present — even when
    // its status row was MISSING from /status. ProxySmart serves /bw and
    // /status from different caches and can briefly drop a modem from one
    // but not the other, which made client-cards flap «LIVE 10 → 9 → 10»
    // tick-to-tick (frontend _modemMap is keyed off status).
    //
    // Contract:
    //   * Modem PRESENT in status (live)   → leave everything alone, even
    //     if some ports from known_modems aren't in current /bw (operator
    //     probably deleted that port — trust the live snapshot).
    //   * Modem MISSING from status         → inject status + bw + ports
    //     so every consumer (frontend map, count widget, etc.) sees a
    //     consistent picture.
    //
    // Multi-port modems (S4 ports = Brandanalytics + WildBox) are handled
    // by gating status injection on a per-imei flag and bw/ports on
    // per-portId checks.
    if (!data.ports) data.ports = {};
    if (!data.bw)    data.bw    = {};

    // Snapshot the imeis that need offline-injection BEFORE we start
    // mutating status — so the per-port loop below gates on "missing at
    // the start of this call", not on whatever we've pushed mid-loop.
    const imeisToInject = new Set();
    for (const info of Object.values(km)) {
      // 041b: never re-inject a soft-deleted modem (markModemDeleted purges the
      // known_modems entry too, but this guarantees consistency even if one lingers).
      if (info.imei && !seenImeis.has(info.imei) && !deletedModemSet.has(srvName + '|' + info.imei)) imeisToInject.add(info.imei);
    }

    // Pass 1a — one status row per to-inject imei.
    const injectedStatus = new Set();
    for (const info of Object.values(km)) {
      if (!info.imei || !imeisToInject.has(info.imei) || injectedStatus.has(info.imei)) continue;
      const opMap = _loadMetaOperators();
      if (!Array.isArray(data.status)) data.status = [];
      data.status.push({
        modem_details: { IMEI: info.imei, NICK: info.nick || '', MODEL_SHOWN: info.model || '', MODEL: info.model || '' },
        net_details:   { IS_ONLINE: 'no', EXT_IP: '', CELLOP: opMap[info.imei] || '', CurrentNetworkType: '' },
        _server: srvName,
        _offline: true
      });
      injectedStatus.add(info.imei);
      seenImeis.add(info.imei);
    }

    // Pass 1b — backfill bw + ports per portId for imeis we just marked
    // offline. Live modems' km entries are left alone.
    for (const [portId, info] of Object.entries(km)) {
      if (!info.imei) {
        // Legacy no-imei: just inject the bw slot if it's missing.
        if (!currentPortIds.has(portId)) {
          data.bw[portId] = {
            portName: info.portName || '',
            bandwidth_bytes_day_in: '0 B', bandwidth_bytes_day_out: '0 B',
            bandwidth_bytes_yesterday_in: '0 B', bandwidth_bytes_yesterday_out: '0 B',
            bandwidth_bytes_month_in: '0 B', bandwidth_bytes_month_out: '0 B',
            bandwidth_bytes_prevmonth_in: '0 B', bandwidth_bytes_prevmonth_out: '0 B',
            bandwidth_bytes_lifetime_in: '0 B', bandwidth_bytes_lifetime_out: '0 B',
            _offline: true
          };
        }
        continue;
      }
      if (!imeisToInject.has(info.imei)) continue;   // modem is LIVE — trust /bw and /ports

      if (!currentPortIds.has(portId)) {
        data.bw[portId] = {
          portName: info.portName || '',
          bandwidth_bytes_day_in: '0 B', bandwidth_bytes_day_out: '0 B',
          bandwidth_bytes_yesterday_in: '0 B', bandwidth_bytes_yesterday_out: '0 B',
          bandwidth_bytes_month_in: '0 B', bandwidth_bytes_month_out: '0 B',
          bandwidth_bytes_prevmonth_in: '0 B', bandwidth_bytes_prevmonth_out: '0 B',
          bandwidth_bytes_lifetime_in: '0 B', bandwidth_bytes_lifetime_out: '0 B',
          _offline: true
        };
        currentPortIds.add(portId);
      }
      if (info.portInfo) {
        if (!data.ports[info.imei]) data.ports[info.imei] = [];
        if (!data.ports[info.imei].some(p => p.portID === portId)) {
          data.ports[info.imei].push({ ...info.portInfo, _offline: true });
        }
      }
    }

    // ── Pass 2 — modem_meta fallback (Stage 18)
    // Modems that vanished from known_modems but are still recently-known.
    // Synthetic port_id `meta_<imei>` is replaced by updateKnownModems() once
    // the modem reappears in a live response.
    try {
      const retentionDays = Number(appSettings.modem_meta_retention_days) > 0
        ? Number(appSettings.modem_meta_retention_days)
        : 60;
      const sinceArg = '-' + retentionDays + ' days';
      const metaRows = trackingDb.metaListRecentForServerStmt().all(srvName, sinceArg);
      for (const row of metaRows) {
        if (!row.imei || seenImeis.has(row.imei)) continue;
        const portId = 'meta_' + row.imei;
        // If the same synthetic id was already created (shouldn't happen but be defensive)
        if (currentPortIds.has(portId)) continue;
        _injectPlaceholder(portId, row.imei, row.nick, row.model, null);
      }
    } catch (e) {
      logger.warn('[injectOfflineModems] modem_meta pass failed for ' + srvName + ': ' + e.message);
    }
  }

  return { updateKnownModems, injectOfflineModems };
}

module.exports = { create };
