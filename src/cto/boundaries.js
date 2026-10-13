'use strict';
//
// src/cto/boundaries.js — что ИИ-директор вправе ИСПОЛНЯТЬ (после «ок»).
// Видеть и предлагать он может всё, но исполнитель — только из этого реестра.
// Любое действие вне реестра превращается в совет (advice): владелец
// выполняет сам. Границы живут в коде, а не в промпте: модель не может их
// обойти формулировкой.
//
// Жёстко запрещено всегда (не обсуждается): биллинг и баланс клиентов,
// тарифы и цены, удаление портов/клиентов, секреты и доступы, правки на
// боксах кроме расписания ротации у модемов БЕЗ клиента.

const statScope = require('../modems/stat-scope');

const FORBIDDEN_KEY = /bill|price|tariff|balance|ledger|payment|refund|token|pass|secret|key|credential|email|smtp|tochka|invoice|act_|requisite/i;

// Настройки, которые можно менять: допустимый диапазон + тип.
const SETTINGS = {
  ping_loss_warn_pct:        { type: 'int', min: 5, max: 90 },
  ping_loss_dead_pct:        { type: 'int', min: 50, max: 100 },
  ping_latency_warn_ms:      { type: 'int', min: 200, max: 5000 },
  httpcheck_alert_threshold: { type: 'int', min: 1, max: 20 },
  httpcheck_timeout_ms:      { type: 'int', min: 3000, max: 60000 },
  httpcheck_concurrency:     { type: 'int', min: 1, max: 20 },
  stale_modem_hours:         { type: 'int', min: 1, max: 168 },
  rotation_sync_interval_min:{ type: 'int', min: 5, max: 240 },
  idle_modem_rotation_off:   { type: 'bool' },
  rotation_fail_norm:        { type: 'json_norm' },   // {"default":20,"exceptions":{"Vodafone RO":80}}
};

function _checkSetting(key, value) {
  if (FORBIDDEN_KEY.test(key)) return { ok: false, reason: 'ключ в запретном списке' };
  const rule = SETTINGS[key];
  if (!rule) return { ok: false, reason: 'настройка вне белого списка' };
  if (rule.type === 'int') {
    const n = Number(value);
    if (!Number.isInteger(n) || n < rule.min || n > rule.max) return { ok: false, reason: `допустимо ${rule.min}–${rule.max}` };
    return { ok: true, value: n };
  }
  if (rule.type === 'bool') {
    if (value === true || value === 'true' || value === 1) return { ok: true, value: true };
    if (value === false || value === 'false' || value === 0) return { ok: true, value: false };
    return { ok: false, reason: 'ожидается true/false' };
  }
  if (rule.type === 'json_norm') {
    let o = value;
    try { if (typeof o === 'string') o = JSON.parse(o); } catch (_) { return { ok: false, reason: 'невалидный JSON' }; }
    if (!o || typeof o !== 'object') return { ok: false, reason: 'ожидается объект' };
    const okNum = (x) => Number.isFinite(+x) && +x >= 1 && +x <= 100;
    if (o.default != null && !okNum(o.default)) return { ok: false, reason: 'default 1–100' };
    for (const v of Object.values(o.exceptions || {})) if (!okNum(v)) return { ok: false, reason: 'исключения 1–100' };
    return { ok: true, value: JSON.stringify(o) };
  }
  return { ok: false, reason: 'неизвестный тип' };
}

// Проверка действия предложения. Возвращает { ok, action?, reason? }.
// ctx.knownModems — ростер (для проверки «у модема нет клиента»).
function validateAction(actionType, params, ctx = {}) {
  params = params && typeof params === 'object' ? params : {};
  if (actionType === 'advice') return { ok: true, action: { type: 'advice', params: {} } };
  if (actionType === 'set_setting') {
    const c = _checkSetting(String(params.key || ''), params.value);
    if (!c.ok) return { ok: false, reason: `set_setting: ${c.reason}` };
    return { ok: true, action: { type: 'set_setting', params: { key: String(params.key), value: c.value } } };
  }
  if (actionType === 'set_modem_rotation') {
    const server = String(params.server || ''), nick = String(params.nick || '');
    const minutes = Number(params.minutes);
    if (!server || !nick) return { ok: false, reason: 'нужны server и nick' };
    if (!Number.isInteger(minutes) || minutes < 0 || minutes > 1440) return { ok: false, reason: 'minutes 0–1440' };
    if (/^random/i.test(nick)) return { ok: false, reason: 'служебный модем' };
    // Граница: ротацию меняем ТОЛЬКО у модема без клиента.
    if (!ctx.knownModems || !Object.keys(ctx.knownModems[server] || {}).length) return { ok: false, reason: 'ростер сервера не загружен' };
    if (statScope.modemHasClient(server, nick, ctx.knownModems)) return { ok: false, reason: 'у модема есть клиент — вне границ агента' };
    return { ok: true, action: { type: 'set_modem_rotation', params: { server, nick, minutes } } };
  }
  return { ok: false, reason: `действие «${actionType}» вне реестра — только совет` };
}

const ACTION_TYPES = ['advice', 'set_modem_rotation', 'set_setting'];
const MAX_APPLIES_PER_DAY = 5;

module.exports = { validateAction, SETTINGS, FORBIDDEN_KEY, ACTION_TYPES, MAX_APPLIES_PER_DAY };
