'use strict';
//
// src/jobs/idle-modem-rotation.js — у модема без клиента ротация по таймеру
// выключается автоматически.
//
// 13.10.2026: свободные MD_17/18/19 на S4 ротировались по расписанию каждые
// ~10 минут (140 раз в сутки), и каждая ротация кончалась пустым IP — SIM без
// сети. Бокс считал это сбоем (REBOOT_SCORE 150–220) и при каждом прогоне
// reset_gently пытался перезагрузить модемы (93% безуспешно, по ~25–30 с на
// каждый), панель S4 блокировалась до 161 с и дашборд ловил таймауты.
//
// Правило: нет клиентского порта (stat-scope.boundModemKeys) → AUTO_IP_ROTATION=0.
// Прежний интервал хранится в kv_store['idle_rotation_prev'] и возвращается,
// когда на модем снова посажен клиент, а ротация так и осталась выключенной
// (если за это время её включили вручную — не трогаем).
//
// Защиты: пустой ростер или ростер сервера → прогон по серверу пропускается;
// модем должен быть без клиента два прогона подряд; не больше MAX_CHANGES
// записей за прогон; запись — /conf/edit + verify-after-write (как в админке).

const statScope = require('../modems/stat-scope');

const KEY_PREV = 'idle_rotation_prev';
const MAX_CHANGES = 10;
const CONFIRM_RUNS = 2;

function create(deps) {
  const {
    logger, logActivity, fetchAllServersDataCached, findServer, proxyConf,
    kvGet, kvSet, getSetting, knownModems, modemRotationCache, invalidateCache, db,
  } = deps;
  const _idleSeen = new Map();   // 'srv|imei' → подряд прогонов без клиента

  function _loadPrev() {
    try { const r = kvGet(KEY_PREV); return r && r.value ? JSON.parse(r.value) : {}; } catch (_) { return {}; }
  }
  function _savePrev(o) { try { kvSet(KEY_PREV, JSON.stringify(o)); } catch (_) { /* best-effort */ } }

  function _isTestPool(server, nick) {
    try {
      const r = db.prepare('SELECT is_test_pool, deleted FROM modem_meta WHERE server_name = ? AND nick = ? LIMIT 1').get(server, nick);
      return !!(r && (r.is_test_pool || r.deleted));
    } catch (_) { return false; }
  }

  async function _setRotation(serverName, rawImei, mins) {
    const server = findServer(serverName);
    if (!server) return { ok: false, reason: 'no_server' };
    const form = await proxyConf.getConfForm(server, `/conf/edit/${rawImei}`);
    if (!form.ok) return { ok: false, reason: form.reason || 'form' };
    const cur = proxyConf.parseRotation(form.html);
    if (cur === mins) return { ok: true, unchanged: true, before: cur };
    const posted = await proxyConf.postConfForm(server, `/conf/edit/${rawImei}`, { ...form.fields, IMEI: rawImei, AUTO_IP_ROTATION: String(mins) });
    if (!posted.ok) return { ok: false, reason: posted.reason || 'post', before: cur };
    const back = await proxyConf.verifyRotation(server, `/conf/edit/${rawImei}`, mins);
    if (!back.ok) return { ok: false, reason: 'verify_failed', before: cur };
    if (modemRotationCache) modemRotationCache[serverName + ':' + rawImei] = mins;
    return { ok: true, before: cur };
  }

  async function _currentRotation(serverName, rawImei, modemDetails) {
    const cached = modemRotationCache && modemRotationCache[serverName + ':' + rawImei];
    if (cached !== undefined && cached !== null) return Number(cached);
    const fromFeed = modemDetails && modemDetails.AUTO_IP_ROTATION;
    if (fromFeed !== undefined && fromFeed !== '') return parseInt(fromFeed, 10) || 0;
    return null;
  }

  async function runOnce() {
    if (!getSetting('idle_modem_rotation_off', true)) return { status: 'skipped', reason: 'disabled' };
    const results = await fetchAllServersDataCached();
    if (!Array.isArray(results) || !results.length) return { status: 'skipped', reason: 'empty_feed' };
    const bound = statScope.boundModemKeys(knownModems);
    if (!bound.size) return { status: 'skipped', reason: 'empty_roster' };

    const prev = _loadPrev();
    let changed = 0, restored = 0, failed = 0;
    const seenNow = new Set();

    for (const data of results) {
      const srv = data && data.serverName;
      const status = data && data.status;
      if (!srv || !Array.isArray(status) || !status.length) continue;
      if (!knownModems[srv] || !Object.keys(knownModems[srv]).length) continue;   // ростер сервера не загружен
      for (const m of status) {
        const md = m && m.modem_details;
        if (!md || !md.IMEI) continue;
        const nick = md.NICK || md.IMEI;
        if (/^random/i.test(String(nick))) continue;
        const rawImei = String(md.IMEI).replace(/^S\d+_/, '');
        const key = srv + ':' + rawImei;
        const hasClient = bound.has(srv + '|' + nick) || bound.has(srv + '|' + md.IMEI) || bound.has(srv + '|' + rawImei);

        if (hasClient) {
          _idleSeen.delete(key);
          if (prev[key] > 0 && changed + restored < MAX_CHANGES) {
            const r = await _setRotationIfStillOff(srv, rawImei, prev[key]);
            if (r === 'restored') {
              restored++;
              logActivity('rotation', 'info', 'idle_rotation_restored', nick, `${nick} (${srv}): на модем снова посажен клиент — авторотация возвращена (${prev[key]} мин)`, { server: srv, nick, minutes: prev[key] });
              delete prev[key];
            }
            else if (r === 'manual') { delete prev[key]; }
          }
          continue;
        }

        seenNow.add(key);
        if (_isTestPool(srv, nick)) continue;
        const cur = await _currentRotation(srv, rawImei, md);
        if (cur === 0) { _idleSeen.delete(key); continue; }
        const n = (_idleSeen.get(key) || 0) + 1;
        _idleSeen.set(key, n);
        if (n < CONFIRM_RUNS || changed >= MAX_CHANGES) continue;
        const r = await _setRotation(srv, rawImei, 0);
        if (r.ok) {
          if (!r.unchanged && r.before > 0) prev[key] = r.before;
          changed += r.unchanged ? 0 : 1;
          if (!r.unchanged) {
            logger.info(`[IdleRotation] ${nick} (${srv}): нет клиента — ротация ${r.before} мин → выключена`);
            logActivity('rotation', 'info', 'idle_rotation_off', nick, `${nick} (${srv}): нет клиента — авторотация ${r.before} мин выключена`, { server: srv, nick, before: r.before });
          }
        } else {
          failed++;
          logger.warn(`[IdleRotation] ${nick} (${srv}): не удалось выключить ротацию (${r.reason})`);
        }
      }
    }
    for (const k of [..._idleSeen.keys()]) if (!seenNow.has(k)) _idleSeen.delete(k);
    _savePrev(prev);
    if (changed || restored) { try { if (invalidateCache) invalidateCache(); } catch (_) { /* best-effort */ } }
    return { status: 'completed', changed, restored, failed };
  }

  // Возврат ротации — только если она всё ещё выключена нашим правилом.
  async function _setRotationIfStillOff(srv, rawImei, mins) {
    const server = findServer(srv);
    if (!server) return 'error';
    const form = await proxyConf.getConfForm(server, `/conf/edit/${rawImei}`);
    if (!form.ok) return 'error';
    if (proxyConf.parseRotation(form.html) !== 0) return 'manual';
    const r = await _setRotation(srv, rawImei, mins);
    return r.ok ? 'restored' : 'error';
  }

  return { runOnce, _idleSeen };
}

module.exports = { create, KEY_PREV };
