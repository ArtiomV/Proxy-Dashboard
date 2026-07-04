'use strict';

/**
 * Telegram alert framework (Stage 18.13).
 *
 * Centralizes all "should we ping the admin?" decisions in one module. Each
 * rule has:
 *   - id          — unique slug, also the appSettings key for enable/disable
 *   - title       — human label for the Settings UI
 *   - priority    — 'critical' | 'important' | 'early'  (UI grouping)
 *   - defaultOn   — whether enabled by default
 *   - cooldownSec — per-key cooldown so the same trigger doesn't spam
 *   - dedupeKey   — fn(payload) → string used to key the cooldown
 *                   (e.g. modem nick, or 'global' for system-wide rules)
 *   - render      — fn(payload) → text  (HTML, telegram parse_mode)
 *
 * Callers do `alerts.trigger(ruleId, payload)` from anywhere in the codebase.
 * The module respects:
 *   - global enable (appSettings.telegram_chat_id present + bot token)
 *   - per-rule enable (appSettings.alert_<ruleId>_enabled, default true)
 *   - per-key cooldown (in-memory; persists across restarts via kv_store)
 *   - boot grace window (no alerts in the first 5 minutes after process start
 *     so backlog from before-restart doesn't flood the channel)
 *
 * Why a framework and not inline `tgSend()` calls everywhere:
 *   - one place to add/remove/tune rules
 *   - one place to wire cooldown so we don't accidentally spam
 *   - one place to render messages with a consistent style
 *   - admin can toggle rules from UI without redeploy
 */

const COOLDOWN_KV_KEY = 'telegram_alert_cooldowns';
let logger, getSetting, appSettings, kvSetCritical, kvGet, db, tgBot;
let _insertNotif = null;   // prepared statement, lazy-init on first trigger

const _bootAt = Date.now();
const BOOT_GRACE_MS = 5 * 60 * 1000;   // 5 min — quiet right after restart
const cooldownState = new Map();       // key: ruleId|dedupeKey → unix ms last sent
let _persistTimer = null;

function init(deps) {
  logger        = deps.logger;
  getSetting    = deps.getSetting;
  appSettings   = deps.appSettings;
  kvSetCritical = deps.kvSetCritical;
  kvGet         = deps.kvGet;
  db            = deps.db;
  tgBot         = deps.tgBot;

  // Restore cooldowns persisted from the previous process so a quick restart
  // doesn't reset all rate-limits.
  try {
    const row = kvGet.get(COOLDOWN_KV_KEY);
    if (row && row.value) {
      const obj = JSON.parse(row.value);
      for (const [k, v] of Object.entries(obj)) cooldownState.set(k, Number(v) || 0);
    }
  } catch (_) { /* best-effort */ }
}

function _persistCooldowns() {
  // Debounced persist — don't write on every send, batch within 5s.
  if (_persistTimer) return;
  _persistTimer = setTimeout(() => {
    _persistTimer = null;
    try {
      const obj = {};
      // Drop entries older than 7 days to keep the blob small.
      const cutoff = Date.now() - 7 * 86400 * 1000;
      for (const [k, v] of cooldownState) {
        if (v >= cutoff) obj[k] = v;
        else cooldownState.delete(k);
      }
      kvSetCritical(COOLDOWN_KV_KEY, JSON.stringify(obj), { source: 'alerts' });
    } catch (e) { logger.warn('[Alerts] persist cooldowns: ' + e.message); }
  }, 5000);
}

// ────────────────────────────────────────────────────────────────
//  Rule registry — add new rules here. UI reads from this list.
// ────────────────────────────────────────────────────────────────
const RULES = {

  // ── 🔴 CRITICAL ──────────────────────────────────────────────
  server_unreachable: {
    title: 'Сервер недоступен',
    priority: 'critical',
    defaultOn: true,
    cooldownSec: 3600,   // повтор раз в час, если не вернулся
    dedupeKey: p => 'srv_' + (p.server || 'unknown'),
    render: p => `🔴 <b>Сервер недоступен</b>\n\nСервер <b>${esc(p.server)}</b> не отвечает (${p.error || 'timeout'}).\nВсе модемы этого сервера в downtime.`,
  },
  server_recovered: {
    title: 'Сервер вернулся в строй',
    priority: 'important',
    defaultOn: true,
    cooldownSec: 60,
    dedupeKey: p => 'srvrec_' + (p.server || 'unknown'),
    render: p => `🟢 <b>Сервер на связи</b>\n\nСервер <b>${esc(p.server)}</b> снова отвечает после ${formatDuration(p.downSec)} простоя.`,
  },
  tochka_webhook_failed: {
    title: 'Webhook от Точки сбоит подряд',
    priority: 'critical',
    defaultOn: true,
    cooldownSec: 3600,
    dedupeKey: () => 'global',
    render: p => `🔴 <b>Точка: webhook сбой ${p.streak} раз подряд</b>\n\nПоследняя ошибка: <code>${esc(p.error || '')}</code>\nЕсли не починим, платежи будут падать только через 4-часовой sync.`,
  },
  db_backup_failed: {
    title: 'Резервная копия БД не создана',
    priority: 'critical',
    defaultOn: true,
    cooldownSec: 86400,
    dedupeKey: () => 'global',
    render: p => `🔴 <b>Backup БД упал</b>\n\nПричина: <code>${esc(p.error || 'unknown')}</code>\nНужно срочно проверить — без бэкапа БД уязвима.`,
  },
  duplicate_credit_blocked: {
    title: 'Защита: дубль-кредит заблокирован',
    priority: 'critical',
    defaultOn: true,
    cooldownSec: 300,
    dedupeKey: p => 'dup_' + (p.natural_key || ''),
    render: p => `🛡 <b>Защита: дубль платежа не прошёл</b>\n\nКлиент: <b>${esc(p.client || '?')}</b>, сумма ${p.amount} ₽\nКлюч: <code>${esc((p.natural_key || '').slice(0, 80))}</code>\n\nЭто хорошая новость — защита работает. Сообщение редкое, проверь причину.`,
  },
  heap_high: {
    title: 'Память процесса близка к лимиту',
    priority: 'critical',
    defaultOn: true,
    cooldownSec: 1800,
    dedupeKey: () => 'global',
    render: p => `⚠️ <b>Heap ${p.pct}%</b>\n\nИспользуется <b>${p.usedMB} MB</b> / ${p.totalMB} MB.\nЕсли скоро не упадёт — pm2 уронит процесс. Возможно утечка.`,
  },
  disk_low_critical: {
    title: 'Свободно <10% на диске',
    priority: 'critical',
    defaultOn: true,
    cooldownSec: 3600,
    dedupeKey: () => 'global',
    render: p => `🔴 <b>На диске мало места: ${p.freeGB} GB (${p.pct}%)</b>\n\nСкоро БД перестанет писаться. Срочно: чистка логов / архив бэкапов.`,
  },
  client_charge_failed: {
    title: 'Списание у клиента: недостаточно баланса',
    priority: 'critical',
    defaultOn: true,
    cooldownSec: 86400,
    dedupeKey: p => 'chrgfail_' + (p.client_id || ''),
    render: p => `🔴 <b>Списание не прошло</b>\n\nКлиент <b>${esc(p.client || '?')}</b>: попытка списать ${p.amount} ₽, баланс был ${p.balance_before} ₽.\nСервис под угрозой отключения.`,
  },

  // ── 🟡 IMPORTANT ────────────────────────────────────────────
  modem_offline_20m: {
    title: 'Модем оффлайн >10 минут',
    priority: 'important',
    defaultOn: true,
    cooldownSec: 86400,   // один alert на streak — реально сбрасывается из tracking при online
    dedupeKey: p => 'mof_' + (p.server || '') + '_' + (p.imei || ''),
    render: p => `🔴 <b>Модем оффлайн</b>\n\n<b>${esc(p.nick || p.imei)}</b> (${p.server}) — не отвечает <b>${p.mins} мин</b>.\nПоследний раз был онлайн: ${p.lastOnline} МСК`,
  },
  // Stage 18.17 — symmetric pair to modem_offline_20m. Fires when a modem
  // that previously triggered the offline alert comes back online.
  modem_recovered: {
    title: 'Модем вернулся в строй',
    priority: 'important',
    defaultOn: true,
    cooldownSec: 60,
    dedupeKey: p => 'mrec_' + (p.server || '') + '_' + (p.imei || ''),
    render: p => `🟢 <b>Модем на связи</b>\n\n<b>${esc(p.nick || p.imei)}</b> (${esc(p.server || '?')}) — снова отвечает после ${formatDuration(p.downSec || 0)} простоя.`,
  },
  recovery_exhausted: {
    title: 'Auto-recovery исчерпал попытки',
    priority: 'important',
    defaultOn: true,
    cooldownSec: 21600,   // 6h
    dedupeKey: p => 'rec_' + (p.server || '') + '_' + (p.nick || ''),
    render: p => `🛑 <b>Recovery исчерпан</b>\n\n<b>${esc(p.nick)}</b> (${p.server}) не оживает после ${p.attempts} USB-resets. Нужен ручной hard-reset.`,
  },
  // ── Stage 19 — failover ──────────────────────────────────────
  failover_done: {
    title: 'Failover: клиент перенесён на спейр',
    priority: 'important',
    defaultOn: true,
    cooldownSec: 30,
    dedupeKey: p => 'fdone_' + (p.server || '') + '_' + (p.client || '') + '_' + (p.spareNick || ''),
    render: p => `🔀 <b>Failover выполнен</b>\n\nКлиент <b>${esc(p.client || '?')}</b> перенесён с модема <b>${esc(p.deadNick || '?')}</b> на <b>${esc(p.spareNick || '?')}</b> (${esc(p.server || '?')}).\nПричина: ${esc(p.reason || '?')}. Строка подключения сохранена, внешний IP сменился.`,
  },
  failover_no_spare: {
    title: 'Failover: нет здорового спейра',
    priority: 'critical',
    defaultOn: true,
    cooldownSec: 3600,
    dedupeKey: p => 'fnospare_' + (p.server || '') + '_' + (p.client || ''),
    render: p => `🔴 <b>Failover невозможен — нет спейра</b>\n\nМодем <b>${esc(p.nick || '?')}</b> (${esc(p.server || '?')}) умер, клиент <b>${esc(p.client || '?')}</b> остался без рабочего прокси. На сервере нет здорового свободного модема для замены.`,
  },
  failover_failed: {
    title: 'Failover: ошибка переноса',
    priority: 'critical',
    defaultOn: true,
    cooldownSec: 600,
    dedupeKey: p => 'ffail_' + (p.server || '') + '_' + (p.client || ''),
    render: p => `🔴 <b>Failover не удался</b>\n\nКлиент <b>${esc(p.client || '?')}</b> (${esc(p.server || '?')}): ${esc(p.error || 'неизвестная ошибка')}.\nНужно вмешаться вручную.`,
  },
  // ── ProxySmart SIM / health signals (Batch 1) ────────────────
  // Fed by the notify-collect pass from the persisted modem_meta signal
  // columns. tg+bell (not bell-only) — these are actionable, the operator
  // wants a Telegram ping too. cooldownSec suppresses re-fire across scans.
  sim_redirect_imposed: {
    title: 'SIM: оператор навязал редирект (нет денег / блок)',
    priority: 'important',
    defaultOn: true,
    cooldownSec: 3600,
    dedupeKey: p => 'simred_' + (p.server || '') + '_' + (p.imei || ''),
    render: p => `⚠️ <b>Проблема с SIM</b>\n\n<b>${esc(p.nick || p.imei)}</b> (${esc(p.server || '?')}) — оператор навязал HTTP-редирект.\nОбычно это значит: на SIM кончились деньги или она заблокирована.`,
  },
  sim_status_bad: {
    title: 'SIM: статус не OK',
    priority: 'important',
    defaultOn: true,
    cooldownSec: 3600,
    dedupeKey: p => 'simstat_' + (p.server || '') + '_' + (p.imei || ''),
    render: p => `📵 <b>Проблема с SIM</b>\n\n<b>${esc(p.nick || p.imei)}</b> (${esc(p.server || '?')}) — статус SIM: <b>${esc(p.simStatus || '?')}</b> (ожидается OK).`,
  },
  reboot_score_high: {
    title: 'Модему может потребоваться ребут (reboot score)',
    priority: 'early',
    defaultOn: true,
    cooldownSec: 86400,
    dedupeKey: p => 'reboot_' + (p.server || '') + '_' + (p.imei || ''),
    render: p => `♻️ <b>Модему может потребоваться ребут</b>\n\n<b>${esc(p.nick || p.imei)}</b> (${esc(p.server || '?')}) — reboot score <b>${p.score}</b>. Возможно нужен USB-reset.`,
  },

  payment_received: {
    title: 'Новый платёж от клиента',
    priority: 'important',
    defaultOn: true,
    cooldownSec: 10,      // защита от двойных webhook-ов в течение секунд
    dedupeKey: p => 'pay_' + (p.natural_key || (p.client_id + '_' + p.amount + '_' + p.date)),
    render: p => `💰 <b>Платёж: ${formatRub(p.amount)}</b>\n\nКлиент: <b>${esc(p.client || '? (ИНН ' + (p.inn || '?') + ')')}</b>\nИсточник: ${p.source || 'банк'}\n${p.balanceAfter != null ? '\nБаланс клиента теперь: <b>' + formatRub(p.balanceAfter) + '</b>' : ''}`,
  },
  client_balance_negative: {
    title: 'Клиент ушёл в минус',
    priority: 'important',
    defaultOn: true,
    cooldownSec: 86400,
    dedupeKey: p => 'neg_' + (p.client_id || ''),
    render: p => `⚠️ <b>Клиент в минусе</b>\n\n<b>${esc(p.client || '?')}</b>: баланс <b>${formatRub(p.balance)}</b>.\nЕсли в ближайший день не пополнит — сервис будет отключён по списанию.`,
  },
  proxy_expiring_3d: {
    title: 'Истекает срок прокси <3 дней',
    priority: 'important',
    defaultOn: true,
    cooldownSec: 86400,
    dedupeKey: p => 'expire_' + (p.server + '_' + (p.portId || '')),
    render: p => `⏰ <b>Прокси истекает через ${p.daysLeft} д.</b>\n\nКлиент: <b>${esc(p.client || '?')}</b>, порт: <code>${esc(p.portName || p.portId)}</code>\nДата истечения: ${p.validBefore}`,
  },
  traffic_spike_burst: {
    title: 'Spike-protection сработал слишком часто',
    priority: 'important',
    defaultOn: true,
    cooldownSec: 7200,
    dedupeKey: () => 'global',
    render: p => `📈 <b>Спайки трафика: ${p.count} штук за час</b>\n\nЛибо у клиента реальный взлёт нагрузки, либо порча данных в hourly-агрегации. Проверь системный лог по action=traffic_spike_clamp.`,
  },
  dashboard_restarted: {
    title: 'Дашборд перезапущен',
    priority: 'important',
    defaultOn: true,
    cooldownSec: 60,
    dedupeKey: () => 'global',
    render: p => `🔄 <b>Дашборд стартовал</b>\n\npm2 restart ${p.restartCount ? '#' + p.restartCount : ''}\nuptime perd: ${p.prevUptime || '?'}\n${p.reason ? 'Причина: ' + esc(p.reason) : ''}`,
  },

  // ── 🔵 EARLY WARNING ────────────────────────────────────────
  heap_warn: {
    title: 'Heap >85% (превентивно)',
    priority: 'early',
    defaultOn: true,
    cooldownSec: 21600,
    dedupeKey: () => 'global',
    render: p => `🟡 <b>Heap ${p.pct}%</b>\n\n<b>${p.usedMB} MB</b> / ${p.totalMB} MB. Близко к лимиту, стоит присмотреться.`,
  },
  disk_low_warn: {
    title: 'Свободно <20% на диске (превентивно)',
    priority: 'early',
    defaultOn: true,
    cooldownSec: 21600,
    dedupeKey: () => 'global',
    render: p => `🟡 <b>На диске <20%: ${p.freeGB} GB (${p.pct}%)</b>\n\nПора подумать про чистку (бэкапы / логи).`,
  },
  cron_stuck: {
    title: 'Cron job не запускался долго',
    priority: 'early',
    defaultOn: true,
    cooldownSec: 21600,
    dedupeKey: p => 'cron_' + (p.job || ''),
    render: p => `⏱ <b>Cron «${esc(p.job)}» молчит</b>\n\nПоследний запуск: ${p.lastRunAgo} назад (ожидался каждые ${p.intervalLabel}).\nВозможно, заклинило.`,
  },

  // ── 🔔 BELL-ONLY (Stage 18.15) ──────────────────────────────
  // Populated by the periodic collector job, not the Telegram framework.
  // channel:'bell' tells trigger() to skip the TG send — these only land
  // in the in-app notifications panel. They still appear in the Settings
  // page and respect the per-rule enable toggle.
  modem_offline: {
    title: 'Модем оффлайн (в колокольчике)',
    priority: 'important',
    defaultOn: true,
    cooldownSec: 86400,
    channel: 'bell',
    dedupeKey: p => 'mof_bell_' + (p.nick || p.imei || ''),
    render: p => `📴 <b>${esc(p.nick || p.imei)}</b> (${esc(p.server || '?')}) — не отвечает ${p.mins || '?'} мин.`,
  },
  client_debt: {
    title: 'Клиент в долгу',
    priority: 'important',
    defaultOn: true,
    cooldownSec: 86400,
    channel: 'bell',
    dedupeKey: p => 'debt_bell_' + (p.client_id || ''),
    render: p => `💸 <b>${esc(p.client || '?')}</b> — баланс ${formatRub(p.balance)}.`,
  },
  crm_reminder: {
    title: 'Напоминание CRM',
    priority: 'important',
    defaultOn: true,
    cooldownSec: 3600,
    channel: 'bell',
    dedupeKey: p => 'crm_bell_' + (p.id || ''),
    render: p => `🔔 <b>${esc(p.name || 'Сделка')}</b>`,
  },
};

// Bell-only metadata: how to navigate to the source when a card in the
// notification panel is clicked. Keyed by rule id; missing entries default
// to entity_kind='system'. Frontend `_notifNavigate` reads (kind, id) and
// decides which tab + drawer to open.
const _entityFor = {
  server_unreachable:        p => ({ kind: 'system', id: p.server || null }),
  server_recovered:          p => ({ kind: 'system', id: p.server || null }),
  tochka_webhook_failed:     () => ({ kind: 'system', id: 'tochka' }),
  db_backup_failed:          () => ({ kind: 'system', id: 'backup' }),
  duplicate_credit_blocked:  p => ({ kind: 'payment', id: p.natural_key || null }),
  heap_high:                 () => ({ kind: 'system', id: 'heap' }),
  disk_low_critical:         () => ({ kind: 'system', id: 'disk' }),
  client_charge_failed:      p => ({ kind: 'client',  id: p.client_id || null }),
  modem_offline_20m:         p => ({ kind: 'modem',   id: p.nick || p.imei || null }),
  modem_recovered:           p => ({ kind: 'modem',   id: p.nick || p.imei || null }),
  recovery_exhausted:        p => ({ kind: 'modem',   id: p.nick || null }),
  failover_done:             p => ({ kind: 'modem',   id: p.spareNick || p.deadNick || null }),
  failover_no_spare:         p => ({ kind: 'modem',   id: p.nick || null }),
  failover_failed:           p => ({ kind: 'system',  id: 'failover' }),
  payment_received:          p => ({ kind: 'payment', id: p.natural_key || null }),
  client_balance_negative:   p => ({ kind: 'client',  id: p.client_id || null }),
  proxy_expiring_3d:         p => ({ kind: 'modem',   id: p.nick || p.portName || null }),
  sim_redirect_imposed:      p => ({ kind: 'modem',   id: p.nick || p.imei || null }),
  sim_status_bad:            p => ({ kind: 'modem',   id: p.nick || p.imei || null }),
  reboot_score_high:         p => ({ kind: 'modem',   id: p.nick || p.imei || null }),
  traffic_spike_burst:       () => ({ kind: 'system', id: 'traffic' }),
  dashboard_restarted:       () => ({ kind: 'system', id: 'pm2' }),
  heap_warn:                 () => ({ kind: 'system', id: 'heap' }),
  disk_low_warn:             () => ({ kind: 'system', id: 'disk' }),
  cron_stuck:                p => ({ kind: 'system', id: 'cron:' + (p.job || '') }),
  // Stage 18.15 — bell-only sources
  modem_offline:             p => ({ kind: 'modem',  id: p.nick || p.imei || null }),
  client_debt:               p => ({ kind: 'client', id: p.client_id || null }),
  crm_reminder:              p => ({ kind: 'crm',    id: p.id || null }),
};

// ────────────────────────────────────────────────────────────────
//  Public API
// ────────────────────────────────────────────────────────────────
function isRuleEnabled(ruleId) {
  const rule = RULES[ruleId];
  if (!rule) return false;
  // appSettings.alert_<ruleId>_enabled — null/undefined = use default
  const key = 'alert_' + ruleId + '_enabled';
  const v = appSettings[key];
  if (v === undefined || v === null) return !!rule.defaultOn;
  return !!v;
}

// Persist one event to the in-app notifications table.
// Telegram + bell are wired through the same code path: a `trigger()` that
// passes both the cooldown check AND the rule-enabled check writes a row
// here, regardless of whether Telegram is configured. That way the bell
// stays a complete history even on installs without a chat_id. Returns
// the inserted row id, or null on failure.
function _persistToBell(rule, ruleId, payload, dedup, renderedHtml) {
  try {
    if (!_insertNotif) {
      _insertNotif = db.prepare(`INSERT INTO notifications
        (dedup_key, rule_id, priority, entity_kind, entity_id, title, message, payload_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`);
    }
    const entFn = _entityFor[ruleId];
    const ent = entFn ? entFn(payload || {}) : { kind: 'system', id: null };
    const info = _insertNotif.run(
      ruleId + '|' + dedup,
      ruleId,
      rule.priority || 'info',
      ent.kind || 'system',
      ent.id != null ? String(ent.id) : null,
      rule.title || ruleId,
      renderedHtml,
      JSON.stringify(payload || {})
    );
    return info.lastInsertRowid || null;
  } catch (e) {
    // notifications table missing on first deploy → migration hasn't run yet.
    // Don't crash trigger() — alerts still go to TG, bell just won't show
    // this event in its history.
    logger.warn('[Alerts] persist bell: ' + e.message);
    return null;
  }
}

function trigger(ruleId, payload) {
  try {
    const rule = RULES[ruleId];
    if (!rule) { logger.warn('[Alerts] unknown rule: ' + ruleId); return false; }
    if (!isRuleEnabled(ruleId)) return false;
    if (Date.now() - _bootAt < BOOT_GRACE_MS) return false;

    const dedup = (typeof rule.dedupeKey === 'function') ? rule.dedupeKey(payload || {}) : 'global';
    const cooldownKey = ruleId + '|' + dedup;
    const lastSentAt = cooldownState.get(cooldownKey) || 0;
    if (Date.now() - lastSentAt < (rule.cooldownSec || 0) * 1000) return false;

    let text;
    try { text = rule.render(payload || {}); }
    catch (e) { logger.warn('[Alerts] render failed for ' + ruleId + ': ' + e.message); return false; }

    cooldownState.set(cooldownKey, Date.now());
    _persistCooldowns();

    // Bell first — independent of Telegram. Even if chat_id is unset or TG is
    // down, admins still see the event in the in-app panel.
    _persistToBell(rule, ruleId, payload, dedup, text);

    // channel:'bell' rules (Stage 18.15) stop here — they're populated by
    // the collector job and shouldn't ping Telegram even if the chat is
    // configured. The «Test» button in Settings still calls through here,
    // so the operator can preview how the card renders in the panel.
    if (rule.channel === 'bell') return true;

    const token = appSettings.telegram_bot_token;
    const chatId = appSettings.telegram_chat_id;
    if (!token || !chatId) return true;   // bell saved, just no TG configured

    tgBot.sendMessage(token, chatId, text).catch(e => {
      // Roll back the cooldown if Telegram actually rejected (so we retry next time).
      // Don't roll back on transient network — Telegram could have sent it.
      const msg = e && e.message || '';
      if (/40\d/.test(msg)) cooldownState.delete(cooldownKey);
      logger.warn('[Alerts] tg send (' + ruleId + '): ' + msg);
    });
    return true;
  } catch (e) {
    logger.warn('[Alerts] trigger error: ' + e.message);
    return false;
  }
}

// Bell-only event recorder for sources that DON'T flow through the
// Telegram framework (the collector job for offline modems, client debts,
// CRM reminders). Same dedup model — caller passes a stable dedup_key
// (typically embedding a daily bucket), and we skip if a row with that
// key already exists. No cooldown, no TG send.
let _findBellByKey = null;
function recordBellEvent(opts) {
  try {
    if (!_findBellByKey) {
      _findBellByKey = db.prepare('SELECT id FROM notifications WHERE dedup_key = ? LIMIT 1');
    }
    if (!_insertNotif) {
      _insertNotif = db.prepare(`INSERT INTO notifications
        (dedup_key, rule_id, priority, entity_kind, entity_id, title, message, payload_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`);
    }
    if (!opts || !opts.dedup_key) return null;
    if (_findBellByKey.get(opts.dedup_key)) return null;
    const info = _insertNotif.run(
      opts.dedup_key,
      opts.rule_id || 'frontend',
      opts.priority || 'info',
      opts.entity_kind || 'system',
      opts.entity_id != null ? String(opts.entity_id) : null,
      opts.title || '',
      opts.message || '',
      JSON.stringify(opts.payload || {})
    );
    return info.lastInsertRowid || null;
  } catch (e) {
    logger.warn('[Alerts] recordBellEvent: ' + e.message);
    return null;
  }
}

// Reset cooldown for a specific (ruleId, payload) — used by the modem
// recovery path to re-arm "modem offline" when the modem comes back online.
function clearCooldown(ruleId, payload) {
  const rule = RULES[ruleId];
  if (!rule) return;
  const dedup = (typeof rule.dedupeKey === 'function') ? rule.dedupeKey(payload || {}) : 'global';
  cooldownState.delete(ruleId + '|' + dedup);
}

function listRules() {
  return Object.entries(RULES).map(([id, r]) => ({
    id, title: r.title, priority: r.priority,
    defaultOn: !!r.defaultOn,
    enabled: isRuleEnabled(id),
    cooldownSec: r.cooldownSec,
    channel: r.channel || 'tg+bell',   // Stage 18.15 — UI badge
  }));
}

// ────────────────────────────────────────────────────────────────
//  Helpers
// ────────────────────────────────────────────────────────────────
function esc(s) {
  if (s == null) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function formatRub(n) {
  if (n == null || isNaN(n)) return '—';
  return Math.round(Number(n) * 100) / 100 + ' ₽';
}
function formatDuration(sec) {
  if (!sec || sec < 60) return Math.round(sec || 0) + ' сек';
  const m = Math.floor(sec / 60);
  if (m < 60) return m + ' мин';
  const h = Math.floor(m / 60);
  return h + ' ч ' + (m % 60) + ' мин';
}

module.exports = { init, trigger, clearCooldown, listRules, recordBellEvent, isRuleEnabled, RULES };
