'use strict';
//
// src/services/proxy-data.js — mergeServerData: склейка per-server ответов
// ProxySmart (bw/status/ports) в единый снапшот с префиксацией ключей
// (S<n>_) и бэкфиллом оператора из modem_meta. Extracted from server.js
// (Stage 9) — без изменения логики.

function create(deps) {
  const { db, knownModems, filterByPortName, isAutoRandomPort, modemLogins, getServerApiHealth } = deps;

  function mergeServerData(allData, portNameFilter) {
    const mergedBw = {}, mergedStatus = [], mergedPorts = {};
    const cachedServers = [];
    const apiHealth = typeof getServerApiHealth === 'function' ? getServerApiHealth() : {};
    for (const data of allData) {
      const filtered = portNameFilter === '*' ? data : filterByPortName(data, portNameFilter);
      const prefix = data.serverName + '_';
      const isCached = !!data._cached;
      if (isCached) {
        const h = apiHealth[data.serverName] || {};
        cachedServers.push({
          name: data.serverName, cachedAt: data._cachedAt,
          // 25.08: 401 — сломалась авторизация, а не сеть; фронт покажет это явно
          authError: !!h.authError,
          lastError: h.lastError || '',
        });
      }
      for (const [portId, b] of Object.entries(filtered.bw)) {
        const bwOverride = process.env[`PORTNAME_OVERRIDE_${data.serverName}`];
        const cleanName = isAutoRandomPort(b.portName) ? '' : b.portName;
        mergedBw[prefix + portId] = { ...b, portName: cleanName, _server: data.serverName, _cached: isCached, ...(bwOverride ? { portName: bwOverride } : {}) };
      }
      const statusArr = Array.isArray(filtered.status) ? filtered.status : [];
      // Stage 18.12: per-server lookup of stored operators from modem_meta so we
      // can backfill empty CELLOP in the live response. ProxySmart occasionally
      // returns CELLOP='' for online modems (signal hiccup) — without this
      // backfill the frontend would render «—» in the «Оператор» column even
      // though we have a perfectly good last-known value in the database.
      // Single batch query per server, then in-memory lookup per modem.
      let _opByImei = null;
      function _opLookup(imei) {
        if (_opByImei) return _opByImei[imei] || '';
        _opByImei = {};
        try {
          const rows = db.prepare(
            "SELECT imei, operator FROM modem_meta WHERE server_name = ? AND operator IS NOT NULL AND TRIM(operator) != ''"
          ).all(data.serverName);
          for (const r of rows) _opByImei[r.imei] = r.operator;
        } catch (_) { /* best-effort */ }
        return _opByImei[imei] || '';
      }
      for (const m of statusArr) {
        // Skip ghost entries from deleted ports (no STATE, no proxy_creds)
        // But allow rebooting modems and offline-injected modems through
        if (!m.STATE || m.STATE === '?') {
          if (m.IS_REBOOTING !== 'true' && !m._offline) continue;
        }
        const entry = { ...m, _server: data.serverName };
        if (isCached) entry._cached = true;
        // Stage 18.12: backfill empty CELLOP from modem_meta. Done BEFORE the
        // IMEI gets prefixed below so the lookup uses the raw IMEI.
        const rawImei = entry.modem_details && entry.modem_details.IMEI;
        if (rawImei) {
          const nd = entry.net_details || {};
          const liveOp = (nd.CELLOP || '').trim();
          if (!liveOp) {
            const stored = _opLookup(rawImei);
            if (stored) entry.net_details = { ...nd, CELLOP: stored };
          }
        }
        if (entry.modem_details && entry.modem_details.IMEI) {
          entry.modem_details = { ...entry.modem_details, IMEI: prefix + entry.modem_details.IMEI };
        }
        mergedStatus.push(entry);
      }
      const portsObj = typeof filtered.ports === 'object' ? filtered.ports : {};
      for (const [imei, portList] of Object.entries(portsObj)) {
        const prefixedImei = prefix + imei;
        const filteredPortList = portList;
        // Apply portName override for servers where ProxySmart doesn't support port renaming
        const portNameOverride = process.env[`PORTNAME_OVERRIDE_${data.serverName}`];
        const prefixedPorts = filteredPortList.map(p => ({
          ...p,
          portName: portNameOverride || (isAutoRandomPort(p.portName) ? '' : p.portName),
          portID: p.portID ? prefix + p.portID : p.portID,
          _server: data.serverName,
          _cached: isCached
        }));
        if (prefixedPorts.length > 0) mergedPorts[prefixedImei] = (mergedPorts[prefixedImei] || []).concat(prefixedPorts);
      }
    }

    // Ensure every modem in ports has a status entry (handles modems present in bw/ports but missing from status during reboot)
    const statusImeis = new Set(mergedStatus.map(m => m.modem_details ? m.modem_details.IMEI : null).filter(Boolean));
    for (const [imei, portList] of Object.entries(mergedPorts)) {
      if (statusImeis.has(imei)) continue;
      // Find server name and nick from port data or knownModems
      const srv = (portList[0] && portList[0]._server) || '';
      const rawImei = imei.replace(/^S\d+_/, '');
      let nick = '', model = '';
      const km = knownModems[srv];
      if (km) {
        for (const info of Object.values(km)) {
          if (info.imei === rawImei) { nick = info.nick || ''; model = info.model || ''; break; }
        }
      }
      mergedStatus.push({
        modem_details: { IMEI: imei, NICK: nick, MODEL_SHOWN: model, MODEL: model },
        net_details: { IS_ONLINE: 'no', EXT_IP: '', CELLOP: '', CurrentNetworkType: '' },
        _server: srv,
        _offline: true
      });
    }

    return { bandwidth: mergedBw, status: mergedStatus, ports: mergedPorts, modemLogins, cachedServers };
  }

  return { mergeServerData };
}

module.exports = { create };
