'use strict';
//
// src/cto/executor.js — исполнение одобренных действий из реестра границ
// (boundaries.js): применить с записью состояния «до», проверить факт записи,
// откатить. Каждый шаг — verify-after-write; при расхождении действие
// считается неудачным и (если что-то успели записать) откатывается.

const boundaries = require('./boundaries');

function create(deps) {
  const {
    logger, getSetting, setSetting, findServer, proxyConf, fetchAllServersDataCached,
    modemRotationCache, invalidateCache, knownModems,
  } = deps;

  async function _resolveImei(server, nick) {
    const results = await fetchAllServersDataCached();
    for (const d of results || []) {
      if (d.serverName !== server) continue;
      for (const m of (Array.isArray(d.status) ? d.status : [])) {
        const md = m.modem_details || {};
        if (md.NICK === nick) return String(md.IMEI).replace(/^S\d+_/, '');
      }
    }
    return null;
  }

  async function _readRotation(srv, imei) {
    const form = await proxyConf.getConfForm(srv, `/conf/edit/${imei}`);
    if (!form.ok) return { ok: false, reason: form.reason || 'form' };
    return { ok: true, value: proxyConf.parseRotation(form.html), form };
  }

  // → { ok, before, after, error }
  async function apply(action) {
    const v = boundaries.validateAction(action.type, action.params, { knownModems });
    if (!v.ok) return { ok: false, error: v.reason };
    const p = v.action.params;

    if (v.action.type === 'set_setting') {
      const before = getSetting(p.key, null);
      try { setSetting(p.key, p.value); } catch (e) { return { ok: false, error: 'setSetting: ' + e.message }; }
      const after = getSetting(p.key, null);
      if (String(after) !== String(p.value)) {
        try { setSetting(p.key, before); } catch (_) { /* best-effort rollback */ }
        return { ok: false, error: 'значение не применилось', before };
      }
      return { ok: true, before: { key: p.key, value: before === undefined ? null : before }, after: { key: p.key, value: after } };
    }

    if (v.action.type === 'set_modem_rotation') {
      const srv = findServer(p.server);
      if (!srv) return { ok: false, error: 'сервер не найден' };
      const imei = await _resolveImei(p.server, p.nick);
      if (!imei) return { ok: false, error: 'модем не найден в фиде' };
      const cur = await _readRotation(srv, imei);
      if (!cur.ok) return { ok: false, error: 'форма модема недоступна: ' + cur.reason };
      const before = { server: p.server, nick: p.nick, imei, minutes: cur.value };
      if (cur.value === p.minutes) return { ok: true, before, after: { ...before }, unchanged: true };
      const posted = await proxyConf.postConfForm(srv, `/conf/edit/${imei}`, { ...cur.form.fields, IMEI: imei, AUTO_IP_ROTATION: String(p.minutes) });
      if (!posted.ok) return { ok: false, error: 'ProxySmart не сохранил: ' + (posted.reason || ''), before };
      const back = await proxyConf.verifyRotation(srv, `/conf/edit/${imei}`, p.minutes);
      if (!back.ok) return { ok: false, error: `ProxySmart не применил: запрошено ${p.minutes}, в форме ${back.gotRot}`, before };
      if (modemRotationCache) modemRotationCache[p.server + ':' + imei] = p.minutes;
      try { if (invalidateCache) invalidateCache(); } catch (_) { /* best-effort */ }
      return { ok: true, before, after: { ...before, minutes: p.minutes } };
    }
    return { ok: false, error: 'нечего исполнять' };
  }

  // Откат по сохранённому before.
  async function rollback(actionType, before) {
    if (!before) return { ok: false, error: 'нет состояния «до»' };
    if (actionType === 'set_setting') {
      try { setSetting(before.key, before.value); return { ok: true }; }
      catch (e) { return { ok: false, error: e.message }; }
    }
    if (actionType === 'set_modem_rotation') {
      const srv = findServer(before.server);
      if (!srv || !before.imei) return { ok: false, error: 'сервер/модем не найден' };
      const cur = await _readRotation(srv, before.imei);
      if (!cur.ok) return { ok: false, error: cur.reason };
      if (cur.value === before.minutes) return { ok: true, unchanged: true };
      const posted = await proxyConf.postConfForm(srv, `/conf/edit/${before.imei}`, { ...cur.form.fields, IMEI: before.imei, AUTO_IP_ROTATION: String(before.minutes || 0) });
      if (!posted.ok) return { ok: false, error: posted.reason };
      const back = await proxyConf.verifyRotation(srv, `/conf/edit/${before.imei}`, before.minutes || 0);
      if (modemRotationCache) modemRotationCache[before.server + ':' + before.imei] = before.minutes || 0;
      try { if (invalidateCache) invalidateCache(); } catch (_) { /* best-effort */ }
      return { ok: back.ok, error: back.ok ? undefined : 'откат не подтвердился' };
    }
    return { ok: false, error: 'откат не предусмотрен' };
  }

  // Проверка «значение всё ещё стоит» через verify_after-срок.
  async function check(actionType, action, afterState) {
    try {
      if (actionType === 'set_setting') {
        const cur = getSetting(afterState.key, null);
        return { ok: String(cur) === String(afterState.value), now: cur };
      }
      if (actionType === 'set_modem_rotation') {
        const srv = findServer(afterState.server);
        const cur = srv ? await _readRotation(srv, afterState.imei) : { ok: false };
        return { ok: cur.ok && cur.value === afterState.minutes, now: cur.ok ? cur.value : null };
      }
    } catch (e) { return { ok: false, error: e.message }; }
    return { ok: true };
  }

  return { apply, rollback, check };
}

module.exports = { create };
