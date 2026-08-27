'use strict';
//
// src/routes/proxies-ports.js — port CRUD + bulk operations (WP6.5 carve-out from proxies.js, VERBATIM move).
//
const express = require('express');
const { stripServerPrefix } = require('../utils/imei');

function validPortName(value) {
  const name = String(value || '').trim();
  if (name.length < 4 || name.length > 64) return { ok: false, name, error: 'Имя порта: от 4 до 64 символов.' };
  if (!/^[A-Za-z0-9._-]+$/.test(name)) return { ok: false, name, error: 'Имя порта: только латиница, цифры, точка, _ и - (без @, пробелов и спецсимволов).' };
  return { ok: true, name };
}

function portPersisted(list, portId, imei) {
  const wanted = String(portId || '');
  const wantedImei = String(imei || '');
  if (!wanted) return false;
  const entries = wantedImei && list && Array.isArray(list[wantedImei])
    ? list[wantedImei]
    : Object.values(list && typeof list === 'object' ? list : {}).flatMap(value => Array.isArray(value) ? value : []);
  return entries.some(port => port && String(port.portID || port.PORT_ID || '') === wanted);
}

module.exports = function createRouter(deps) {
  const {
    logger, authMiddleware, adminMiddleware,
    fetchApi, fetchApiRaw, postApi, postFormApi, findServer,
    parseHtmlInputFields,
    auditLog, logActivity, getClientIp,
    proxySmart,
    proxyConf,
    modemRotationCache, saveRotationCache,
  } = deps;
  const r = express.Router();
r.post('/api/admin/store_port', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { serverName, ...portData } = req.body;
    if (!serverName || !portData.IMEI) return res.status(400).json({ error: 'serverName and IMEI required' });
    const server = findServer(serverName);
    if (!server) return res.status(400).json({ error: 'Server not found' });
    // Срезаем серверный префикс по ИМЕНИ сервера (RO1-MF289_…), не только /^S\d+_/.
    const rawImei = stripServerPrefix(portData.IMEI, server.name);
    const checkedName = validPortName(portData.portName);
    if (!checkedName.ok) return res.status(400).json({ error: checkedName.error });
    portData.portName = checkedName.name;
    // ProxySmart silently rejects port names with characters outside a conservative
    // set — notably '@' (Telegram handles like @yakovlevArtm): the add_port POST
    // 302-redirects back to the form, the port is never written, yet the redirect
    // looks identical to success. Reject upfront with a clear message instead of
    // letting it fail invisibly.
    // Reject an accidental duplicate: the SAME portName already on THIS modem. A
    // modem may legitimately host several ports with DIFFERENT names (e.g. WildBox
    // + yakovlevArtm), and the same client name may live on different modems — so
    // only an exact portName+IMEI match is a dup. That is precisely what a
    // lost-response retry produces (the operator re-submits, thinking it failed).
    if (portData.portName) {
      try {
        const existing = await fetchApi(server, '/apix/list_ports_json');
        const onModem = (existing && existing[rawImei]) || [];
        if (Array.isArray(onModem) && onModem.some(p => p && p.portName === portData.portName)) {
          return res.status(409).json({ error: `Порт «${portData.portName}» уже существует на этом модеме — дубль не создан.` });
        }
      } catch (e) {
        logger.warn(`[store_port] dup-check failed for ${rawImei}: ${e.message}`);   // best-effort, don't block a real create
      }
    }
    // GET pre-filled form values from ProxySmart (portID, http_port, login, password)
    // — через proxyConf (обход логин-стены /conf/* на S2).
    const addForm = await proxyConf.getConfForm(server, `/conf/add_port?imei=${rawImei}`);
    if (!addForm.ok) {
      return res.status(502).json({ error: `ProxySmart не отдал форму add_port (${addForm.reason})` });
    }
    const html = addForm.html;
    const prefilled = parseHtmlInputFields(html);

    // Sanity check — without portID and http_port the form will fail server-side
    if (!prefilled.portID) {
      return res.status(502).json({ error: 'add_port form returned no portID', html_snippet: html.slice(0, 300) });
    }

    // Все технические поля — portID, пары HTTP/SOCKS и логин/пароль — оставляем
    // ровно такими, какими их выдал ЭТОТ ProxySmart. Раньше UI подменял логин и
    // пароль случайными значениями: на части боксов (в частности RO) серверная
    // валидация молча отклоняла всю форму с тем же 302, что и при успехе.
    const formData = { ...prefilled };
    formData.portName = portData.portName;
    // IMPORTANT: do NOT override http_port/socks_port with the caller's values.
    // ProxySmart prefills a MATCHED pair from two distinct pools (e.g. http=8029,
    // socks=5029). The frontend used to pass http+socks as two CONSECUTIVE entries
    // from /api/admin/free_ports (e.g. 8029 + 8030) — a socks port in the HTTP
    // range. ProxySmart silently REJECTS that (the add_port POST 302-redirects back
    // to the form, the port is never written to its DB), so the port "создавался,
    // но не появлялся". Always trust ProxySmart's prefilled http/socks pair.
    const actualPortId = formData.portID;

    // Submit the form (через proxyConf — обход логин-стены S2).
    const addPosted = await proxyConf.postConfForm(server, `/conf/add_port?imei=${rawImei}`, formData);
    if (!addPosted.ok) {
      return res.status(502).json({ error: `ProxySmart не сохранил порт (${addPosted.reason})` });
    }

    proxySmart.invalidateCache();
    // ProxySmart returns a 302 on BOTH a successful add AND a silent validation
    // reject (see the portName note above), and postFormApi can't tell them apart.
    // Confirm the port actually landed in the live port list before reporting
    // success — otherwise we'd log a phantom "port_created" and the operator would
    // retry, stacking duplicates (which then collide on the same port-pair).
    let persisted = false, verifyError = null;
    for (let attempt = 0; attempt < 3 && !persisted; attempt++) {
      if (attempt) await new Promise(resolve => setTimeout(resolve, 250));
      try {
        const listRaw = await fetchApi(server, '/apix/list_ports_json');
        persisted = portPersisted(listRaw, actualPortId, rawImei);
      } catch (e) {
        verifyError = e;
      }
    }
    if (!persisted) {
      logger.warn(`[store_port] port ${actualPortId} did NOT persist on ${serverName} — ProxySmart rejected the authoritative form (imei=${rawImei}, portName=${JSON.stringify(portData.portName)}, form=${JSON.stringify({ http_port: formData.http_port, socks_port: formData.socks_port, proxy_login: formData.proxy_login })}, verify=${verifyError ? verifyError.message : 'not_found'})`);
      return res.status(422).json({ ok: false, error: 'ProxySmart отклонил порт. Имя уже проверено, а ID, порты и реквизиты были назначены самим ProxySmart. Порт не создан; повторять запрос не нужно.' });
    }

    // Применяем только уже подтверждённый порт — прежний порядок мог вызвать
    // apply_port для фантомного ID после молчаливого отказа формы.
    let applied = false;
    try {
      await fetchApi(server, `/apix/apply_port?arg=${encodeURIComponent(actualPortId)}`);
      applied = true;
    } catch (e) {
      logger.warn(`[store_port] apply_port failed for ${actualPortId}: ${e.message}`);
    }

    auditLog(req.user.login, 'store_port', { serverName, IMEI: rawImei, portName: portData.portName, portId: actualPortId, applied, ip: getClientIp(req) });
    logActivity('modem', 'info', 'port_created', portData.portName || actualPortId, `Port created on ${serverName}/${rawImei} (id=${actualPortId})`, { applied });
    res.json({ ok: true, portId: actualPortId, applied,
      http_port: formData.http_port, socks_port: formData.socks_port, proxy_login: formData.proxy_login });
  } catch (err) {
    logger.error('[store_port] ' + err.message);
    res.status(502).json({ error: 'Store port failed', details: err.message });
  }
});

r.post('/api/admin/move_port', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { serverName, portID, newIMEI } = req.body;
    if (!serverName || !portID || !newIMEI) return res.status(400).json({ error: 'serverName, portID, newIMEI required' });
    const server = findServer(serverName);
    if (!server) return res.status(400).json({ error: 'Server not found' });
    // Read full current port form (через proxyConf — обход логин-стены S2)
    const mvForm = await proxyConf.getConfForm(server, `/conf/edit_port/${portID}`);
    if (!mvForm.ok) return res.status(502).json({ error: `ProxySmart не отдал форму порта (${mvForm.reason})` });
    const formData = parseHtmlInputFields(mvForm.html);
    // Get proxy_password from port API
    if (!formData.proxy_password) {
      try {
        const portsData = await fetchApi(server, '/apix/list_ports_json');
        for (const [, plist] of Object.entries(portsData)) {
          for (const port of plist) {
            if (port.portID === portID && port.PASSWORD) { formData.proxy_password = port.PASSWORD; break; }
          }
          if (formData.proxy_password) break;
        }
      } catch (e) { /* ignore */ }
    }
    // Change IMEI to move port to new modem
    formData.IMEI = newIMEI;
    const mvPosted = await proxyConf.postConfForm(server, `/conf/edit_port/${portID}`, formData);
    if (!mvPosted.ok) return res.status(502).json({ error: `ProxySmart не сохранил перенос (${mvPosted.reason})` });
    // Re-apply so ProxySmart picks up the new IMEI binding
    try { await fetchApi(server, `/apix/apply_port?arg=${encodeURIComponent(portID)}`); }
    catch (e) { logger.warn(`[move_port] apply_port failed for ${portID}: ${e.message}`); }
    auditLog(req.user.login, 'move_port', { serverName, portID, newIMEI, ip: getClientIp(req) });
    proxySmart.invalidateCache();
    res.json({ ok: true });
  } catch (err) { res.status(502).json({ error: 'Move port failed', details: err.message }); }
});

r.post('/api/admin/update_port_creds', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { serverName, IMEI, portID, proxy_login, proxy_password } = req.body;
    if (!serverName || !IMEI || !portID) return res.status(400).json({ error: 'serverName, IMEI, portID required' });
    if (!proxy_login && !proxy_password) return res.status(400).json({ error: 'proxy_login or proxy_password required' });
    const server = findServer(serverName);
    if (!server) return res.status(400).json({ error: 'Server not found' });
    // Send to ProxySmart store_port (updates existing port)
    const portData = { IMEI, portID };
    if (proxy_login) portData.proxy_login = proxy_login;
    if (proxy_password) portData.proxy_password = proxy_password;
    const storeResult = await postApi(server, '/crud/store_port', portData);
    // Apply changes
    const applyResult = await fetchApi(server, `/apix/apply_port?arg=${encodeURIComponent(portID)}`);
    res.json({ ok: true, storeResult, applyResult });
  } catch (err) { res.status(502).json({ error: 'Update credentials failed', details: err.message }); }
});

r.get('/api/admin/get_port_config', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { serverName, portId } = req.query;
    if (!serverName || !portId) return res.status(400).json({ error: 'serverName and portId required' });
    const server = findServer(serverName);
    if (!server) return res.status(400).json({ error: 'Server not found' });
    const cfgForm = await proxyConf.getConfForm(server, `/conf/edit_port/${portId}`);
    if (!cfgForm.ok) return res.status(502).json({ error: `ProxySmart не отдал форму порта (${cfgForm.reason})` });
    const html = cfgForm.html;
    const extract = (name) => {
      const m = html.match(new RegExp(`name="${name}"[^>]*value="([^"]*)"`));
      if (m) return m[1];
      const m2 = html.match(new RegExp(`value="([^"]*)"[^>]*name="${name}"`));
      return m2 ? m2[1] : '';
    };
    const extractSelected = (name) => {
      const re = new RegExp(`<select[^>]*name="${name}"[\\s\\S]*?</select>`);
      const blockM = html.match(re);
      if (!blockM) return '';
      const block = blockM[0];
      const sel = block.match(/<option[^>]*selected[^>]*value\s*=\s*"([^"]*)"/);
      if (sel) return sel[1];
      const sel2 = block.match(/<option[^>]*value\s*=\s*"([^"]*)"[^>]*selected/);
      return sel2 ? sel2[1] : '';
    };
    res.json({
      portID: extract('portID') || portId,
      portName: extract('portName'),
      http_port: extract('http_port'),
      socks_port: extract('socks_port'),
      proxy_login: extract('proxy_login'),
      proxy_password: extract('proxy_password'),
      MAXCONN: extract('MAXCONN'),
      CONNLIM: extract('CONNLIM'),
      bandlimin: extract('bandlimin'),
      bandlimout: extract('bandlimout'),
      bw_quota: extract('bw_quota'),
      QUOTA_TYPE: extractSelected('QUOTA_TYPE'),
      QUOTA_DIRECTION: extractSelected('QUOTA_DIRECTION'),
      PROXY_VALID_BEFORE: extract('PROXY_VALID_BEFORE'),
      CREATED_AT: extract('CREATED_AT'),
      OS: extractSelected('OS'),
      IP_MODE: extractSelected('IP_MODE'),
    });
  } catch (err) {
    logger.error('[GetPortConfig]', err.message);
    res.status(502).json({ error: 'Get port config failed', details: err.message });
  }
});

r.post('/api/admin/save_port_config', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { serverName, portId, ...fields } = req.body;
    if (!serverName || !portId) return res.status(400).json({ error: 'serverName and portId required' });
    const server = findServer(serverName);
    if (!server) return res.status(400).json({ error: 'Server not found' });
    // Batch 2: validate numeric limit fields BEFORE they reach ProxySmart.
    // ProxySmart silently rejects malformed input (302-redirects back to the
    // form, change lost, no error) — same trap as the portName gotcha. Catch
    // it here with a clear 400 instead of a phantom "сохранено".
    const _numLimitFields = ['MAXCONN', 'CONNLIM', 'bandlimin', 'bandlimout', 'bw_quota'];
    for (const f of _numLimitFields) {
      const v = fields[f];
      if (v === undefined || v === null || String(v).trim() === '') continue;
      const n = Number(v);
      if (!Number.isInteger(n) || n < 0) {
        return res.status(400).json({ error: `Поле ${f}: ожидается целое число ≥ 0 (0 = без лимита).` });
      }
      fields[f] = String(n);
    }
    // Read full current form to preserve ALL required fields (через proxyConf — обход логин-стены S2)
    const spForm = await proxyConf.getConfForm(server, `/conf/edit_port/${portId}`);
    if (!spForm.ok) return res.status(502).json({ error: `ProxySmart не отдал форму порта (${spForm.reason})` });
    const formData = parseHtmlInputFields(spForm.html);
    // Get proxy_password from port API data (not in HTML form)
    if (!formData.proxy_password) {
      try {
        const portsData = await fetchApi(server, '/apix/list_ports_json');
        for (const [, plist] of Object.entries(portsData)) {
          for (const port of plist) {
            if (port.portID === portId && port.PASSWORD) { formData.proxy_password = port.PASSWORD; break; }
          }
          if (formData.proxy_password) break;
        }
      } catch (e) { /* ignore — password may already be in fields */ }
    }
    // Merge user changes on top of current values
    for (const [k, v] of Object.entries(fields)) {
      if (k === 'OS_SPOOF') formData.OS = v; // Map dashboard → ProxySmart field names
      else if (k === 'IP_VERSION') formData.IP_MODE = v;
      else formData[k] = v;
    }
    // Remove internal fields not needed by ProxySmart form
    delete formData.serverName; delete formData.OS_SPOOF; delete formData.IP_VERSION;
    const result = await proxyConf.postConfForm(server, `/conf/edit_port/${portId}`, formData);
    if (!result.ok) return res.status(502).json({ error: `ProxySmart не сохранил настройки порта (${result.reason})` });
    // Apply the port changes
    await fetchApi(server, `/apix/apply_port?arg=${encodeURIComponent(portId)}`);
    proxySmart.invalidateCache();
    auditLog(req.user.login, 'save_port_config', { serverName, portId, fields: Object.keys(fields), ip: getClientIp(req) });
    res.json({ ok: true, status: result.status });
  } catch (err) {
    logger.error('[SavePortConfig]', err.message);
    res.status(502).json({ error: 'Save port config failed', details: err.message });
  }
});

r.post('/api/admin/bulk_os_spoof', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { ports, os } = req.body;
    if (!Array.isArray(ports) || !ports.length) return res.status(400).json({ error: 'ports array required' });
    // Pre-fetch passwords per server (cache list_ports_json once per server)
    const pwCache = {};
    const serverNames = [...new Set(ports.map(p => p.serverName))];
    for (const sn of serverNames) {
      const server = findServer(sn);
      if (!server) continue;
      try {
        const portsData = await fetchApi(server, '/apix/list_ports_json');
        pwCache[sn] = {};
        for (const [, plist] of Object.entries(portsData)) {
          for (const port of plist) {
            if (port.portID && port.PASSWORD) pwCache[sn][port.portID] = port.PASSWORD;
          }
        }
      } catch (e) { logger.warn(`[BulkOS] Failed to fetch ports for ${sn}: ${e.message}`); }
    }
    let ok = 0, failed = 0;
    for (const p of ports) {
      try {
        const server = findServer(p.serverName);
        if (!server) { failed++; continue; }
        // GET/POST формы порта через proxyConf (обход логин-стены S2)
        const osForm = await proxyConf.getConfForm(server, `/conf/edit_port/${p.portId}`);
        if (!osForm.ok) { failed++; continue; }
        const fields = parseHtmlInputFields(osForm.html);
        // Password from pre-fetched cache
        const pw = (pwCache[p.serverName] || {})[p.portId];
        if (pw) fields.proxy_password = pw;
        fields.OS = os || '';
        const result = await proxyConf.postConfForm(server, `/conf/edit_port/${p.portId}`, fields);
        if (result.ok) ok++;
        else failed++;
      } catch (e) { failed++; }
    }
    proxySmart.invalidateCache();
    auditLog(req.user.login, 'bulk_os_spoof', { os, count: ports.length, ok, failed, ip: getClientIp(req) });
    res.json({ ok: true, updated: ok, failed });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

r.post('/api/admin/bulk_rotation', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { modems, rotation } = req.body;
    if (!Array.isArray(modems) || !modems.length) return res.status(400).json({ error: 'modems array required' });
    const rotVal = String(rotation != null ? rotation : 10);
    const wantRot = parseInt(rotVal) || 0;
    let ok = 0, failed = 0;
    const failures = [];
    for (const m of modems) {
      const server = findServer(m.serverName);
      const rawImei = stripServerPrefix(m.imei, server && server.name);
      try {
        if (!server) { failed++; failures.push({ imei: rawImei, reason: 'server not found' }); continue; }
        // proxyConf обходит логин-стену /conf/* (S2) — раньше POST уходил в
        // /modem/login, а модем считался ok: «выключил, но ротируется».
        const form = await proxyConf.getConfForm(server, `/conf/edit/${rawImei}`);
        if (!form.ok) { failed++; failures.push({ imei: rawImei, reason: 'form: ' + form.reason }); continue; }
        form.fields.AUTO_IP_ROTATION = rotVal;
        const posted = await proxyConf.postConfForm(server, `/conf/edit/${rawImei}`, form.fields);
        if (!posted.ok) { failed++; failures.push({ imei: rawImei, reason: 'post: ' + posted.reason }); continue; }
        // Verify-after-write: считаем ok только подтверждённое значение.
        const back = await proxyConf.getConfForm(server, `/conf/edit/${rawImei}`);
        const got = back.ok ? proxyConf.parseRotation(back.html) : null;
        if (got !== wantRot) {
          // Verify не прошёл — НЕ оставляем в кэше старое значение: до 30 минут
          // UI бы показывал его как актуальное («выключил, а показывает 10м»).
          // Без записи фронт покажет «нет данных» до ближайшего честного рефреша.
          delete modemRotationCache[m.serverName + ':' + rawImei];
          failed++; failures.push({ imei: rawImei, reason: `verify: в форме ${got == null ? 'нет данных' : got}` });
          continue;
        }
        modemRotationCache[m.serverName + ':' + rawImei] = wantRot;
        ok++;
      } catch (e) { failed++; failures.push({ imei: rawImei, reason: String(e.message || e).slice(0, 80) }); }
    }
    proxySmart.invalidateCache();
    auditLog(req.user.login, 'bulk_rotation', { rotation: rotVal, count: modems.length, ok, failed, ip: getClientIp(req) });
    res.json({
      ok: failed === 0,
      updated: ok,
      failed,
      failures: failures.slice(0, 20),
      error: failed ? `Не применено для ${failed} из ${modems.length}: ` + failures.slice(0, 3).map(f => `${f.imei} (${f.reason})`).join(', ') : undefined,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

r.post('/api/admin/apply_port', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { portId, serverName } = req.body;
    if (!portId || !serverName) return res.status(400).json({ error: 'portId and serverName required' });
    const server = findServer(serverName);
    if (!server) return res.status(400).json({ error: 'Server not found' });
    const result = await fetchApi(server, `/apix/apply_port?arg=${encodeURIComponent(portId)}`);
    res.json({ ok: true, result });
  } catch (err) { res.status(502).json({ error: 'Apply port failed', details: err.message }); }
});

r.post('/api/admin/purge_port', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { portId, serverName } = req.body;
    if (!portId || !serverName) return res.status(400).json({ error: 'portId and serverName required' });
    const server = findServer(serverName);
    if (!server) return res.status(400).json({ error: 'Server not found' });
    // /conf/delete_port — GET-действие через proxyConf (обход логин-стены S2).
    // Раньше шло через fetchApi: на S2 302-страница логина отклонялась как
    // «HTML вместо JSON» → 502 «Delete port failed».
    const del = await proxyConf.getConfAction(server, `/conf/delete_port/${encodeURIComponent(portId)}`);
    if (!del.ok) {
      logger.warn(`[Admin] Delete port ${portId} on ${serverName} failed: ${del.reason}`);
      return res.status(502).json({ error: `Delete port failed: ${del.reason}` });
    }
    logger.info(`[Admin] Deleted port ${portId} from ${serverName}`);
    auditLog(req.user.login, 'purge_port', { serverName, portId, ip: getClientIp(req) });
    proxySmart.invalidateCache();
    res.json({ ok: true, status: del.status });
  } catch (err) { res.status(502).json({ error: 'Delete port failed', details: err.message }); }
});

r.get('/api/admin/free_ports', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { serverName } = req.query;
    if (!serverName) return res.status(400).json({ error: 'serverName required' });
    const server = findServer(serverName);
    if (!server) return res.status(400).json({ error: 'Server not found' });
    const result = await fetchApi(server, '/apix/get_free_tcp_ports');
    res.json(result);
  } catch (err) { res.status(502).json({ error: 'Failed', details: err.message }); }
});

  return r;
};

module.exports.validPortName = validPortName;
module.exports.portPersisted = portPersisted;
