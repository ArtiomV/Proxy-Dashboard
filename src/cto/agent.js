'use strict';
//
// src/cto/agent.js — ИИ-технический директор дашборда и серверов.
//
// Цикл: осмотр (observe) → предложения (Claude, forced tool-call) → проверка
// границ (boundaries) → дедуп с историей → Telegram-кнопки + колокольчик →
// решение владельца → исполнение (executor) → проверка эффекта.
//
// Агент видит всё и предлагает всё, но ИСПОЛНЯЕТ только действия из реестра
// boundaries.js и только после явного «ок». Остальное — советы (advice).
//
// Расписание: сам решает, когда прийти в следующий раз, но в коридоре
// cto_min_hours..cto_max_hours (по умолчанию 6–12 ч) — токены не жжём.

const crypto = require('crypto');
const boundaries = require('./boundaries');

const DEFAULT_MODEL = 'claude-opus-4-7';
const SUPPRESS_REJECTED_DAYS = 14;
const SUPPRESS_APPLIED_DAYS = 7;
const SNOOZE_HOURS = 24;
const EXPIRE_PENDING_DAYS = 7;
const MAX_NEW_PER_RUN = 5;
const VERIFY_AFTER_MIN = 45;

const SYSTEM_PROMPT = `Ты — технический директор сервиса мобильных прокси (дашборд + боксы ProxySmart S1/S3/S4/RO1, Молдова и Румыния). Ты работаешь на владельца: следишь за ротациями, нормами, пингами, HTTP-проверками, спидтестами, нагрузкой боксов, качеством учёта трафика и предлагаешь, как исправить или улучшить работу.

Принципы:
1. Данные, а не догадки. Каждое предложение опирается на факты из снимка. В evidence помечай kind="data" (видно в снимке) или kind="assumption" (гипотеза). Не выдумывай причины; если причина неизвестна — скажи, что нужно проверить, и предложи advice.
   Не выдумывай IP-адреса, имена хостов, версии и числа, которых нет в снимке: если нужного значения нет — так и скажи («в снимке этого нет, проверить: …»). Не путай серверы между собой — привязывай каждый факт к server из данных. База дашборда — SQLite (если даёшь SQL, то в диалекте SQLite).
2. Полезность вместо шума. Если всё в норме — верни пустой список proposals и честное резюме. Не предлагай то, что уже есть в recent_proposals со статусом pending/rejected/applied без новых данных. Максимум ${MAX_NEW_PER_RUN} предложений за осмотр, самые важные.
3. Границы исполнения. Ты можешь предложить ЛЮБОЕ, но исполняемыми (action.type != "advice") бывают только:
   - set_modem_rotation {server, nick, minutes} — интервал авторотации у модема БЕЗ клиента;
   - set_setting {key, value} — только ключи из tunable_settings, значения в разумных пределах.
   Всё остальное (код, расписания cron на боксах, биллинг, тарифы, клиенты, порты, SIM, железо) — только action.type="advice": объясни, что и как сделать владельцу. Биллинг и деньги клиентов не трогаешь никогда.
4. Результат важнее процесса. В expected пиши измеримый ожидаемый эффект и как ты это проверишь (метрика, срок).
5. operator_notes — заметки владельца: что уже исправлено (с датой) и что сделано намеренно. Не предлагай повторно пункты оттуда, пока события (last_event_utc, recent_events_newest_first) ПОЗЖЕ даты исправления не покажут рецидив; если рецидив есть — скажи об этом прямо.
6. Учись на истории: смотри статусы и verify у recent_proposals — что сработало, что нет.
7. Пиши по-русски, кратко, без воды. Модемы — по нику (MD_17), серверы — S1/S3/S4/RO1.

Нормы: доля неуспешных ротаций до 20% (Vodafone RO до 80%); сбой пинга — потери ≥ порога; модем без клиента в статистику не входит.

Расписание: в next_run_in_hours выбери, когда прийти снова, в пределах [MIN, MAX] часов из запроса. Раньше — если есть открытые проблемы, недавно применённые изменения требуют проверки или ситуация нестабильна; позже — если всё спокойно. Объясни выбор в next_run_reason одной фразой.

Верни результат ТОЛЬКО вызовом инструмента submit_review.`;

function _schema(minH, maxH) {
  return {
    type: 'object',
    properties: {
      summary: { type: 'string', description: 'Итог осмотра: 1–3 предложения, что в целом происходит.' },
      proposals: {
        type: 'array', maxItems: MAX_NEW_PER_RUN,
        items: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'Короткий заголовок до 90 символов.' },
            category: { type: 'string', enum: ['rotations', 'monitoring', 'servers', 'traffic', 'speedtest', 'norms', 'billing', 'other'] },
            severity: { type: 'string', enum: ['info', 'warn', 'critical'] },
            summary: { type: 'string', description: 'Что вижу и почему предлагаю, 2–5 предложений.' },
            evidence: {
              type: 'array', maxItems: 6,
              items: { type: 'object', properties: { fact: { type: 'string' }, kind: { type: 'string', enum: ['data', 'assumption'] } }, required: ['fact', 'kind'] },
            },
            expected: { type: 'string', description: 'Ожидаемый эффект и как проверю.' },
            action: {
              type: 'object',
              properties: {
                type: { type: 'string', enum: boundaries.ACTION_TYPES },
                params: { type: 'object', description: 'Для advice — {steps:"что сделать владельцу"}.' },
              },
              required: ['type'],
            },
          },
          required: ['title', 'category', 'severity', 'summary', 'evidence', 'expected', 'action'],
        },
      },
      next_run_in_hours: { type: 'number', minimum: minH, maximum: maxH },
      next_run_reason: { type: 'string' },
    },
    required: ['summary', 'proposals', 'next_run_in_hours', 'next_run_reason'],
  };
}

const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const SEV = { critical: { emoji: '🔴', prio: 'critical' }, warn: { emoji: '🟠', prio: 'important' }, info: { emoji: '🔵', prio: 'info' } };

function create(deps) {
  const {
    db, logger, getSetting, kvGet, kvSet, observe, executor, tgBot, recordBellEvent, logActivity, auditLog,
    knownModems, callModel,
  } = deps;
  let _running = false;

  // ── настройки ────────────────────────────────────────────────────────────
  const enabled = () => !!getSetting('cto_enabled', true);
  const hoursRange = () => {
    let lo = Number(getSetting('cto_min_hours', 6)) || 6;
    let hi = Number(getSetting('cto_max_hours', 12)) || 12;
    lo = Math.max(1, Math.min(lo, 48)); hi = Math.max(lo, Math.min(hi, 72));
    return [lo, hi];
  };
  const model = () => String(getSetting('cto_model', DEFAULT_MODEL) || DEFAULT_MODEL);

  function _kv(key) { try { const r = kvGet(key); return r ? r.value : null; } catch (_) { return null; } }
  function _nextRunAt() { const v = Number(_kv('cto_next_run_at')); return Number.isFinite(v) && v > 0 ? v : 0; }

  // ── дедуп ────────────────────────────────────────────────────────────────
  function fingerprint(p) {
    const a = p.action || {};
    const core = [p.category, String(p.title || '').toLowerCase().replace(/\d+/g, '#').slice(0, 60),
      a.type, a.params && a.params.server, a.params && a.params.nick, a.params && a.params.key].join('|');
    return crypto.createHash('sha1').update(core).digest('hex').slice(0, 16);
  }
  function _suppressed(fp) {
    const row = db.prepare(`
      SELECT status, created_at, snooze_until FROM cto_proposals WHERE fingerprint = ? ORDER BY id DESC LIMIT 1`).get(fp);
    if (!row) return null;
    const ageDays = (Date.now() - Date.parse(row.created_at.replace(' ', 'T') + 'Z')) / 86400000;
    if (row.status === 'pending') return 'уже ожидает решения';
    if (row.status === 'rejected' && ageDays < SUPPRESS_REJECTED_DAYS) return 'отклонено ранее';
    if ((row.status === 'applied' || row.status === 'verified' || row.status === 'acknowledged') && ageDays < SUPPRESS_APPLIED_DAYS) return 'уже обработано';
    if (row.status === 'snoozed' && row.snooze_until && Date.parse(row.snooze_until.replace(' ', 'T') + 'Z') > Date.now()) return 'отложено';
    return null;
  }

  // ── уведомления ─────────────────────────────────────────────────────────
  function _text(row, extra) {
    const ev = JSON.parse(row.evidence_json || '[]');
    const act = JSON.parse(row.action_json || '{}');
    const sev = SEV[row.severity] || SEV.info;
    const L = [`${sev.emoji} <b>ИИ-директор: ${esc(row.title)}</b>`, '', esc(row.summary)];
    if (ev.length) {
      L.push('', '<b>Что вижу:</b>');
      for (const e of ev) L.push(`${e.kind === 'assumption' ? '❓' : '•'} ${esc(e.fact)}${e.kind === 'assumption' ? ' <i>(гипотеза)</i>' : ''}`);
    }
    if (row.expected) L.push('', `<b>Ожидаю:</b> ${esc(row.expected)}`);
    if (row.action_type === 'advice') {
      const steps = act.params && act.params.steps;
      L.push('', `<b>Что сделать:</b> ${esc(steps || 'см. описание выше')}`, '<i>Это совет — выполнить нужно вам.</i>');
    } else if (row.action_type === 'set_modem_rotation') {
      L.push('', `<b>Могу выполнить:</b> ротация ${esc(act.params.nick)} (${esc(act.params.server)}) → ${act.params.minutes ? act.params.minutes + ' мин' : 'выключена'}`);
    } else if (row.action_type === 'set_setting') {
      L.push('', `<b>Могу выполнить:</b> настройка <code>${esc(act.params.key)}</code> → <code>${esc(act.params.value)}</code>`);
    }
    if (extra) L.push('', extra);
    return L.join('\n');
  }
  function _keyboard(row) {
    const ok = row.action_type === 'advice' ? '✅ Принято' : '✅ Одобрить';
    return { inline_keyboard: [[
      { text: ok, callback_data: `c:ok:${row.id}` },
      { text: '❌ Отклонить', callback_data: `c:no:${row.id}` },
      { text: '⏰ Позже', callback_data: `c:later:${row.id}` },
    ]] };
  }
  async function _tgSend(text, opts) {
    const token = getSetting('telegram_bot_token', ''), chatId = getSetting('telegram_chat_id', '');
    if (!token || !chatId) return null;
    try { return { chatId, res: await tgBot.sendMessage(token, chatId, text, opts) }; }
    catch (e) { logger.warn('[CTO] telegram: ' + e.message); return null; }
  }
  async function _tgEdit(row, text) {
    const token = getSetting('telegram_bot_token', '');
    if (!token || !row.tg_chat_id || !row.tg_message_id) return;
    try {
      await tgBot.tgRequest(token, 'editMessageText', { chat_id: row.tg_chat_id, message_id: row.tg_message_id, text, parse_mode: 'HTML', reply_markup: { inline_keyboard: [] } });
    } catch (e) { logger.warn('[CTO] editMessageText: ' + e.message); }
  }
  async function _notify(row) {
    try {
      const sev = SEV[row.severity] || SEV.info;
      recordBellEvent({
        dedup_key: 'cto:' + row.id, dedup_window_sec: 30 * 86400, rule_id: 'cto_proposal', priority: sev.prio,
        entity_kind: 'cto', entity_id: row.id, title: 'ИИ-директор: ' + row.title,
        message: row.summary + (row.expected ? `\nОжидаю: ${row.expected}` : ''),
        payload: { proposal_id: row.id, executable: row.action_type !== 'advice', action_type: row.action_type },
      });
    } catch (e) { logger.warn('[CTO] bell: ' + e.message); }
    const sent = await _tgSend(_text(row), { reply_markup: _keyboard(row) });
    const mid = sent && sent.res && sent.res.result && sent.res.result.message_id;
    if (mid) db.prepare('UPDATE cto_proposals SET tg_chat_id = ?, tg_message_id = ? WHERE id = ?').run(String(sent.chatId), mid, row.id);
  }

  // ── осмотр ──────────────────────────────────────────────────────────────
  async function runCycle(trigger = 'schedule') {
    if (_running) return { status: 'skipped', reason: 'already_running' };
    if (!enabled() && trigger === 'schedule') return { status: 'skipped', reason: 'disabled' };
    _running = true;
    const [minH, maxH] = hoursRange();
    const runId = db.prepare(`INSERT INTO cto_runs (trigger, model) VALUES (?, ?)`).run(trigger, model()).lastInsertRowid;
    try {
      const snap = await observe.snapshot();
      const user = `Окно осмотра: ${snap.generated_at}. next_run_in_hours допустим в диапазоне [${minH}, ${maxH}].\n\nСнимок состояния:\n${JSON.stringify(snap)}`;
      const r = await callModel({ model: model(), system: SYSTEM_PROMPT, user, schema: _schema(minH, maxH) });
      const out = r.input || {};
      const created = [];
      const skipped = [];
      for (const p of (Array.isArray(out.proposals) ? out.proposals : []).slice(0, MAX_NEW_PER_RUN)) {
        if (!p || !p.title) continue;
        // Границы: невалидное исполняемое действие → совет.
        let aType = p.action && p.action.type || 'advice';
        let aParams = p.action && p.action.params || {};
        const v = boundaries.validateAction(aType, aParams, { knownModems });
        let downgraded = '';
        if (!v.ok) { downgraded = v.reason; aType = 'advice'; aParams = { steps: (aParams.steps || '') + (downgraded ? ` (агент не вправе исполнять сам: ${downgraded})` : '') }; }
        else { aType = v.action.type; aParams = v.action.params; }
        const fp = fingerprint({ ...p, action: { type: aType, params: aParams } });
        const why = _suppressed(fp);
        if (why) { skipped.push({ title: p.title, why }); continue; }
        const info = db.prepare(`
          INSERT INTO cto_proposals (run_id, fingerprint, category, severity, title, summary, evidence_json, expected, action_type, action_json)
          VALUES (?,?,?,?,?,?,?,?,?,?)`).run(runId, fp, p.category || 'other', p.severity || 'info', String(p.title).slice(0, 140),
          String(p.summary || '').slice(0, 1500), JSON.stringify((p.evidence || []).slice(0, 6)), String(p.expected || '').slice(0, 500),
          aType, JSON.stringify({ params: aParams }));
        const row = db.prepare('SELECT * FROM cto_proposals WHERE id = ?').get(info.lastInsertRowid);
        created.push(row);
        await _notify(row);
      }
      let hours = Number(out.next_run_in_hours);
      if (!Number.isFinite(hours)) hours = maxH;
      hours = Math.max(minH, Math.min(maxH, hours));
      kvSet('cto_next_run_at', String(Date.now() + hours * 3600000));
      const usage = r.usage || {};
      db.prepare(`UPDATE cto_runs SET finished_at = datetime('now'), status = 'ok', tokens_in = ?, tokens_out = ?, proposals = ?, summary = ?, next_run_in_h = ?, next_run_why = ? WHERE id = ?`)
        .run(usage.input_tokens || null, usage.output_tokens || null, created.length, String(out.summary || '').slice(0, 600), hours, String(out.next_run_reason || '').slice(0, 300), runId);
      logger.info(`[CTO] осмотр #${runId}: предложений ${created.length}, пропущено ${skipped.length}, следующий через ${hours} ч (${out.next_run_reason || ''})`);
      return { status: 'ok', runId, created: created.length, skipped, summary: out.summary, nextInHours: hours };
    } catch (e) {
      logger.error('[CTO] осмотр не удался: ' + (e.message || e));
      db.prepare(`UPDATE cto_runs SET finished_at = datetime('now'), status = 'failed', error = ? WHERE id = ?`).run(String(e.message || e).slice(0, 400), runId);
      // повтор не раньше чем через min-коридор/2, но не чаще раза в 2 часа — сбои API не должны жечь токены
      kvSet('cto_next_run_at', String(Date.now() + Math.max(2, minH / 2) * 3600000));
      return { status: 'failed', error: e.message };
    } finally { _running = false; }
  }

  // ── решение владельца ───────────────────────────────────────────────────
  // decision: 'approve' | 'reject' | 'later'. → { ok, status, text, error }
  async function decide(id, decision, by) {
    const row = db.prepare('SELECT * FROM cto_proposals WHERE id = ?').get(id);
    if (!row) return { ok: false, error: 'not_found' };
    if (row.status !== 'pending') return { ok: false, error: 'already_decided', status: row.status };
    const who = String(by || 'admin');
    const now = `datetime('now')`;

    if (decision === 'reject') {
      db.prepare(`UPDATE cto_proposals SET status='rejected', decided_at=${now}, decided_by=? WHERE id=?`).run(who, id);
      await _tgEdit(row, _text(row, `❌ <b>Отклонено</b> (${esc(who)}). Не буду предлагать то же ${SUPPRESS_REJECTED_DAYS} дней без новых данных.`));
      return { ok: true, status: 'rejected', text: 'Отклонено' };
    }
    if (decision === 'later') {
      const until = new Date(Date.now() + SNOOZE_HOURS * 3600000).toISOString().slice(0, 19).replace('T', ' ');
      db.prepare(`UPDATE cto_proposals SET status='snoozed', decided_at=${now}, decided_by=?, snooze_until=? WHERE id=?`).run(who, until, id);
      await _tgEdit(row, _text(row, `⏰ <b>Отложено</b> на ${SNOOZE_HOURS} ч (${esc(who)}).`));
      return { ok: true, status: 'snoozed', text: 'Отложено на сутки' };
    }
    if (decision !== 'approve') return { ok: false, error: 'bad_decision' };

    if (row.action_type === 'advice') {
      db.prepare(`UPDATE cto_proposals SET status='acknowledged', decided_at=${now}, decided_by=? WHERE id=?`).run(who, id);
      await _tgEdit(row, _text(row, `✅ <b>Принято</b> (${esc(who)}). Это совет — выполнение за вами; проверю эффект при следующем осмотре.`));
      return { ok: true, status: 'acknowledged', text: 'Принято' };
    }
    const applied24h = db.prepare(`SELECT COUNT(*) n FROM cto_proposals WHERE applied_at >= datetime('now','-1 day')`).get().n;
    if (applied24h >= boundaries.MAX_APPLIES_PER_DAY) {
      return { ok: false, error: 'daily_limit', text: `Лимит ${boundaries.MAX_APPLIES_PER_DAY} применённых изменений в сутки исчерпан` };
    }
    const action = { type: row.action_type, params: (JSON.parse(row.action_json || '{}')).params || {} };
    db.prepare(`UPDATE cto_proposals SET status='approved', decided_at=${now}, decided_by=? WHERE id=?`).run(who, id);
    let res;
    try { res = await executor.apply(action); } catch (e) { res = { ok: false, error: e.message }; }
    if (!res.ok) {
      db.prepare(`UPDATE cto_proposals SET status='failed', result_json=?, before_json=? WHERE id=?`).run(JSON.stringify({ error: res.error }), JSON.stringify(res.before || null), id);
      await _tgEdit(row, _text(row, `⚠️ <b>Не применено:</b> ${esc(res.error)}`));
      if (auditLog) try { auditLog(who, 'cto_apply_failed', { id, action, error: res.error }); } catch (_) { /* best-effort */ }
      return { ok: false, status: 'failed', error: res.error, text: 'Не применено: ' + res.error };
    }
    const verifyAfter = new Date(Date.now() + VERIFY_AFTER_MIN * 60000).toISOString().slice(0, 19).replace('T', ' ');
    db.prepare(`UPDATE cto_proposals SET status='applied', applied_at=datetime('now'), before_json=?, result_json=?, verify_after=? WHERE id=?`)
      .run(JSON.stringify(res.before), JSON.stringify({ after: res.after, unchanged: !!res.unchanged }), verifyAfter, id);
    try { logActivity('system', 'info', 'cto_applied', String(id), `ИИ-директор применил #${id}: ${row.title}`, { id, action, before: res.before, after: res.after }); } catch (_) { /* best-effort */ }
    if (auditLog) try { auditLog(who, 'cto_applied', { id, action, before: res.before, after: res.after }); } catch (_) { /* best-effort */ }
    await _tgEdit(row, _text(row, `✅ <b>Применено</b> (${esc(who)}), запись подтверждена. Проверю результат через ${VERIFY_AFTER_MIN} мин.`));
    return { ok: true, status: 'applied', text: 'Применено' };
  }

  // Откат применённого изменения по кнопке/API.
  async function rollback(id, by) {
    const row = db.prepare('SELECT * FROM cto_proposals WHERE id = ?').get(id);
    if (!row || !['applied', 'verified'].includes(row.status)) return { ok: false, error: 'not_applied' };
    const r = await executor.rollback(row.action_type, JSON.parse(row.before_json || 'null'));
    if (!r.ok) return { ok: false, error: r.error };
    db.prepare(`UPDATE cto_proposals SET status='rolled_back', verify_json=? WHERE id=?`).run(JSON.stringify({ rolled_back_by: by || 'admin' }), id);
    try { logActivity('system', 'info', 'cto_rolled_back', String(id), `Откат #${id}: ${row.title}`, { id }); } catch (_) { /* best-effort */ }
    return { ok: true };
  }

  // ── тик: проверка эффекта, протухание, запуск осмотра по сроку ────────────
  async function tick() {
    try {
      const due = db.prepare(`SELECT * FROM cto_proposals WHERE status='applied' AND verified_at IS NULL AND verify_after <= datetime('now')`).all();
      for (const row of due) {
        const after = (JSON.parse(row.result_json || '{}')).after;
        const c = await executor.check(row.action_type, null, after);
        db.prepare(`UPDATE cto_proposals SET status=?, verified_at=datetime('now'), verify_json=? WHERE id=?`)
          .run(c.ok ? 'verified' : 'applied', JSON.stringify(c), row.id);
        await _tgSend(c.ok
          ? `🔎 ИИ-директор: проверил #${row.id} «${esc(row.title)}» — изменение на месте, эффект оценю при следующем осмотре.`
          : `⚠️ ИИ-директор: #${row.id} «${esc(row.title)}» — значение изменилось после применения (сейчас: ${esc(JSON.stringify(c.now))}). Возможно, кто-то поменял вручную.`);
      }
      db.prepare(`UPDATE cto_proposals SET status='expired' WHERE status='pending' AND created_at < datetime('now', ?)`).run(`-${EXPIRE_PENDING_DAYS} days`);
      if (enabled() && Date.now() >= (_nextRunAt() || Date.now())) await runCycle('schedule');
    } catch (e) { logger.error('[CTO] tick: ' + e.message); }
  }

  return { runCycle, decide, rollback, tick, fingerprint, SYSTEM_PROMPT, _schema };
}

module.exports = { create, SYSTEM_PROMPT, DEFAULT_MODEL };
