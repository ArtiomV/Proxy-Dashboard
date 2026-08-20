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
  balance_drift: {
    title: 'Баланс клиента не сходится с ledger',
    priority: 'critical',
    defaultOn: true,
    cooldownSec: 86400,   // джоба суточная — одного сообщения в день достаточно
    dedupeKey: () => 'global',
    render: p => `🔴 <b>Реконсиляция: баланс ≠ ledger у ${p.count} клиент(ов)</b>\n\n${esc(p.offenders || '')}\n\nБаланс ведётся инкрементально — дрейф означает пропущенную или лишнюю запись. Автоправки НЕТ: разобрать вручную (см. system_log → balance_drift).`,
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
    // D4: долговые сигналы — общий dedupeKey-family debt_<client_id>_<signal>,
    // чтобы кулдауны/дедуп были консистентны (частоты не менялись).
    dedupeKey: p => 'debt_' + (p.client_id || '') + '_charge_failed',
    render: p => `🔴 <b>Списание не прошло</b>\n\nКлиент <b>${esc(p.client || '?')}</b>: попытка списать ${p.amount} ₽, баланс был ${p.balance_before} ₽.\nСервис под угрозой отключения.`,
  },

  // Сводка массового падения: в потоке одиночных «модем оффлайн» масштаб
  // аварии не читается. Одно сообщение = сколько модемов лежит и где.
  modems_down_bulk: {
    title: 'Массовое падение модемов',
    priority: 'critical',
    defaultOn: true,
    cooldownSec: 1800,   // 30 мин — авария развивается, но спамить не надо
    dedupeKey: () => 'mdb',
    render: p => {
      // Печатаем ВЕСЬ список. Единственная обрезка — жёсткий лимит Telegram
      // (4096 символов на сообщение): режем по строкам с запасом на шапку.
      const MAX_LIST = 3500;
      const lines = String(p.list || '').split('\n').filter(Boolean);
      let more = Number(p.more) || 0;
      const kept = [];
      let len = 0;
      for (const l of lines) {
        if (len + l.length + 1 > MAX_LIST) { more += lines.length - kept.length; break; }
        kept.push(l); len += l.length + 1;
      }
      return `🚨 <b>Не работает модемов: ${p.count}</b>\n\nПо серверам: ${esc(p.servers || '—')}\n\n${esc(kept.join('\n'))}`
        + (more > 0 ? `\n…и ещё ${more}` : '');
    },
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
  // Алерты агрегированы по модему (failover.js шлёт ОДИН trigger на весь
  // набор портов): p.moves / p.clients — массивы; одиночные client/spareNick
  // оставлены для обратной совместимости (ручные вызовы, старые тесты).
  failover_done: {
    title: 'Failover: клиент перенесён на спейр',
    priority: 'important',
    defaultOn: true,
    cooldownSec: 30,
    dedupeKey: p => 'fdone_' + (p.server || '') + '_' + (p.deadNick || '') + '_' + (p.client || ''),
    render: p => {
      const lines = Array.isArray(p.moves) && p.moves.length
        ? p.moves.map(m => `• <b>${esc(m.client)}</b> → <b>${esc(m.spareNick)}</b>`).join('\n')
        : `Клиент <b>${esc(p.client || '?')}</b> перенесён на <b>${esc(p.spareNick || '?')}</b>.`;
      const n = Array.isArray(p.moves) && p.moves.length ? p.moves.length : 1;
      return `🔀 <b>Failover выполнен</b>\n\nМодем <b>${esc(p.deadNick || '?')}</b> (${esc(p.server || '?')}) — перенесено портов: <b>${n}</b>.\n${lines}\nПричина: ${esc(p.reason || '?')}. Строки подключения сохранены, внешний IP сменился.`;
    },
  },
  failover_no_spare: {
    title: 'Failover: нет здорового спейра',
    priority: 'critical',
    defaultOn: true,
    cooldownSec: 900,   // пока модем мёртв и не перенесён — напоминаем раз в 15 мин
    dedupeKey: p => 'fnospare_' + (p.server || '') + '_' + (p.nick || ''),
    render: p => {
      const clients = Array.isArray(p.clients) && p.clients.length ? p.clients : [p.client || '?'];
      return `🔴 <b>Failover невозможен — нет спейра</b>\n\nМодем <b>${esc(p.nick || '?')}</b> (${esc(p.server || '?')}) умер, без рабочего прокси остались: ${clients.map(c => `<b>${esc(c)}</b>`).join(', ')}.\nНа сервере нет здорового свободного модема для замены. Повторю через 15 мин, если не решится.`;
    },
  },
  failover_failed: {
    title: 'Failover: ошибка переноса',
    priority: 'critical',
    defaultOn: true,
    cooldownSec: 900,   // 15 мин — авария продолжается, но спамить не надо
    dedupeKey: p => 'ffail_' + (p.server || '') + '_' + (p.client || ''),
    render: p => {
      const lines = Array.isArray(p.clients) && p.clients.length
        ? p.clients.map(c => `• <b>${esc(c.client)}</b>: ${esc(c.error || '?')}`).join('\n')
        : `Клиент <b>${esc(p.client || '?')}</b>: ${esc(p.error || 'неизвестная ошибка')}.`;
      return `🔴 <b>Failover не удался</b>\n\n${esc(p.server || '?')}:\n${lines}\nНужно вмешаться вручную.`;
    },
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
  sim_iccid_changed: {
    title: 'SIM заменена (ICCID сменился)',
    priority: 'important',
    defaultOn: true,
    cooldownSec: 3600,
    dedupeKey: p => 'iccid_' + (p.server || '') + '_' + (p.imei || ''),
    render: p => `🔄 <b>SIM заменена</b>\n\n<b>${esc(p.nick || p.imei)}</b> (${esc(p.server || '?')}) — ICCID изменился при том же модеме.\nБыл: <code>${esc(p.old_iccid || '')}</code>\nСтал: <code>${esc(p.new_iccid || '')}</code>\nЕсли SIM никто не менял — разберись, откуда новая карта.`,
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
  // 2026-08-07: уведомление при выставлении актов/счетов (авто и вручную).
  act_issued: {
    title: 'Выставлен акт',
    priority: 'important',
    defaultOn: true,
    cooldownSec: 5,
    dedupeKey: p => 'act_' + (p.client_id || '') + '_' + (p.period || '') + '_' + (p.amount || 0),
    render: p => `📃 <b>Выставлен акт: ${formatRub(p.amount)}</b>\n\nКлиент: <b>${esc(p.client || '?')}</b>\nПериод: ${esc(p.period || '?')}\nНомер: ${esc(p.actNumber || '—')}\nВ банке: ${p.tochkaPushed ? 'создан в Точке' : 'только локально'}`,
  },
  bill_issued: {
    title: 'Выставлен счёт',
    priority: 'important',
    defaultOn: true,
    cooldownSec: 5,
    dedupeKey: p => 'bill_' + (p.client_id || '') + '_' + (p.period || '') + '_' + (p.amount || 0),
    render: p => `💳 <b>Выставлен счёт: ${formatRub(p.amount)}</b>\n\nКлиент: <b>${esc(p.client || '?')}</b>\nПериод: ${esc(p.period || '?')}\nНомер: ${esc(p.billNumber || '—')}\nВ банке: ${p.tochkaPushed ? 'создан в Точке' : 'только локально'}`,
  },
  client_balance_negative: {
    title: 'Клиент ушёл в минус',
    priority: 'important',
    defaultOn: true,
    cooldownSec: 86400,
    dedupeKey: p => 'debt_' + (p.client_id || '') + '_balance_negative',   // D4: debt-family
    render: p => `⚠️ <b>Клиент в минусе</b>\n\n<b>${esc(p.client || '?')}</b>: баланс <b>${formatRub(p.balance)}</b>.\nЕсли в ближайший день не пополнит — сервис будет отключён по списанию.`,
  },
  // B3 (Р13): автоблок должников-физиков. День блока — факт гашения портов.
  client_blocked_debt: {
    title: 'Физик заблокирован по долгу',
    priority: 'critical',
    defaultOn: true,
    cooldownSec: 86400,
    dedupeKey: p => 'debt_' + (p.client_id || '') + '_blocked',   // D4: debt-family
    render: p => `🔒 <b>Автоблок по долгу</b>\n\nКлиент <b>${esc(p.client || '?')}</b>: баланс <b>${formatRub(p.balance)}</b>.\nПогашено портов: ${p.ports || '?'} («дата до» = ${p.validBefore || 'сегодня'}).\nПосле оплаты доступ восстановится автоматически (+30 дн).`,
  },
  // B3 (Р13): восстановление после оплаты.
  client_unblocked_debt: {
    title: 'Физик восстановлен после оплаты',
    priority: 'important',
    defaultOn: true,
    cooldownSec: 3600,
    dedupeKey: p => 'debt_' + (p.client_id || '') + '_unblocked',   // D4: debt-family
    render: p => `🔓 <b>Доступ восстановлен</b>\n\nКлиент <b>${esc(p.client || '?')}</b>: баланс <b>${formatRub(p.balance)}</b>.\n«Дата до» продлена до ${p.validBefore || '?'} (портов: ${p.ports ?? '?'}).`,
  },
  // B3 (Р13): прогноз «за 3 дня» — баланс покрывает ≤ 3 суток списаний.
  // Cooldown 3 суток: одно предупреждение на эпизод, чтобы не спамить ежедневно.
  client_block_warning: {
    title: 'Физик на пороге блокировки (≤3 дн)',
    priority: 'important',
    defaultOn: true,
    cooldownSec: 259200,
    dedupeKey: p => 'debt_' + (p.client_id || '') + '_block_warning',   // D4: debt-family
    render: p => `⏳ <b>На пороге блокировки</b>\n\nКлиент <b>${esc(p.client || '?')}</b>: баланс <b>${formatRub(p.balance)}</b> — хватит примерно на <b>${p.daysLeft} дн.</b> (среднесуточное списание ${formatRub(p.avgDaily)}).\nПри уходе в ноль порты будут погашены автоматически.`,
  },
  // Ручная блокировка клиента админом: blocked=1 + kill сессий + гашение
  // всех портов (B2B «дата до» = сегодня, розница — пул → blocked).
  client_blocked_admin: {
    title: 'Клиент заблокирован админом',
    priority: 'critical',
    defaultOn: true,
    cooldownSec: 3600,
    dedupeKey: p => 'adminblock_' + (p.client_id || ''),
    render: p => `🔒 <b>Клиент заблокирован админом</b>\n\n<b>${esc(p.client || '?')}</b>: сессии сброшены, погашено портов: B2B ${p.b2b ?? 0}, розница ${p.retail ?? 0}.${p.errors ? `\nОшибки: <code>${esc(String(p.errors).slice(0, 300))}</code>` : ''}`,
  },
  // B2C Э2: тест-день розницы завершён — порт отвязан и возвращён в пул.
  retail_test_day_ended: {
    title: 'Тест-день завершён',
    priority: 'important',
    defaultOn: true,
    cooldownSec: 3600,
    dedupeKey: p => 'testday_' + (p.client_id || '') + '_' + (p.port_id || ''),
    render: p => `🧪 <b>Тест-день завершён</b>\n\nКлиент <b>${esc(p.client || '?')}</b>: порт <code>${esc(p.port_id || '?')}</code> (${esc(p.server || '?')}) отвязан и возвращён в пул.`,
  },
  // B2C Э3 (WP5): операционные алерты розницы — регистрации, покупки, пул.
  retail_registered: {
    title: 'Розница: новая регистрация',
    priority: 'important',
    defaultOn: true,
    cooldownSec: 10,   // защита от двойного сабмита формы
    dedupeKey: p => 'reg_' + (p.login || p.email || ''),
    render: p => `🆕 <b>Новая розничная регистрация</b>\n\nЛогин: <code>${esc(p.login || '?')}</code>\nEmail: ${esc(p.email || '—')}\nКанал: ${p.via === 'telegram' ? 'Telegram Login' : 'email + пароль'}`,
  },
  retail_purchase: {
    title: 'Розница: покупка прокси',
    priority: 'important',
    defaultOn: true,
    cooldownSec: 10,
    dedupeKey: p => 'buy_' + (p.login || '') + '_' + (p.tariff || '') + '_' + (p.price || 0),
    render: p => `🛒 <b>Покупка прокси</b>\n\nКлиент: <b>${esc(p.login || '?')}</b>\nТариф: ${esc(p.tariff || '?')}\nСписано: ${formatRub(p.price)}`,
  },
  // Массовая покупка одним аккаунтом: триггерится из buy_proxy при
  // ПЕРЕСЕЧЕНИИ порога (count === threshold), дедуп по clientId — суточный
  // кулдаун на случай граничных гонок (reserve/lease).
  retail_bulk_buy: {
    title: 'Розница: массовая покупка одним аккаунтом',
    priority: 'important',
    defaultOn: true,
    cooldownSec: 86400,
    dedupeKey: p => 'bulk_' + (p.client_id || ''),
    render: p => `📦 <b>Массовая покупка</b>\n\nКлиент <b>${esc(p.login || '?')}</b> арендует уже <b>${p.count ?? '?'}</b> порт(ов) (порог ${p.threshold ?? '?'}).\nПроверь, не мультиаккаунт/перепродажа ли это.`,
  },
  // Пул на исходе: свободных портов СУММАРНО по боксам розницы <
  // retail_pool_min_free. Триггеры: после покупки (retail.js) и тик
  // retail-guard. 20.08: агрегировано (один алерт на весь пул), cooldown —
  // сутки: раньше шёл по каждому серверу раз в час.
  retail_pool_low: {
    title: 'Розница: пул на исходе',
    priority: 'important',
    defaultOn: true,
    cooldownSec: 86400,
    dedupeKey: () => 'poollow_global',
    render: p => `📉 <b>Пул розницы на исходе</b>\n\nСвободных портов суммарно: <b>${p.free ?? '?'}</b> (минимум ${p.min ?? '?'})${p.breakdown ? `\nПо боксам: ${esc(p.breakdown)}` : ''}.\nПополни пул: Настройки → Розница → «Добавить порты».`,
  },
  // B2C Э5 (WP7): антифрод розницы — авто-саспенд порта по доменному
  // контролю (domain-guard). При достижении порога strikes — blocked=1.
  retail_abuse_suspend: {
    title: 'Розница: авто-саспенд по антифроду (AUP)',
    priority: 'critical',
    defaultOn: true,
    cooldownSec: 300,
    dedupeKey: p => 'abuse_' + (p.client_id || '') + '_' + (p.port_id || ''),
    render: p => `🚨 <b>Антифрод: порт розницы приостановлен</b>\n\nКлиент <b>${esc(p.client || '?')}</b>: порт <code>${esc(p.port_id || '?')}</code> (${esc(p.server || '?')}) — обращение к <code>${esc(p.host || '?')}</code> из бан-листа.\nНарушений (strikes): <b>${p.strikes ?? '?'}</b>${p.blocked ? '\n\n⛔ Порог strikes достигнут — аккаунт ЗАБЛОКИРОВАН, сессии убиты.' : ''}\nРазблокировка — только вручную (карточка клиента).`,
  },
  // B2C Э5 (WP7): анти-мультиаккаунт — отказ регистрации по лимиту reg_ip.
  retail_multiaccount_ip: {
    title: 'Розница: мультиаккаунт с одного IP',
    priority: 'important',
    defaultOn: true,
    cooldownSec: 3600,   // дедуп по IP: одно сообщение в час на адрес
    dedupeKey: p => 'multiip_' + (p.ip || 'unknown'),
    render: p => `⚠️ <b>Мультиаккаунт: лимит регистраций с IP</b>\n\nIP <code>${esc(p.ip || '?')}</code>: уже <b>${p.count ?? '?'}</b> аккаунт(ов) (лимит ${p.limit ?? '?'}). Очередная регистрация отклонена.`,
  },
  // B2C Э5 (WP7): деградация уникальности IP розничного бокса (14-дневный
  // скан /apix/unique_ips_json; проверка в тике retail-guard).
  retail_pool_ip_degraded: {
    title: 'Розница: деградация уникальности IP пула',
    priority: 'important',
    defaultOn: true,
    cooldownSec: 21600,   // 6ч на бокс — метрика 14-дневная, быстро не меняется
    dedupeKey: p => 'poolip_' + (p.server || 'unknown'),
    render: p => `📉 <b>Уникальность IP пула деградировала</b>\n\n<b>${esc(p.server || '?')}</b>: уникальных IP за 14 дней <b>${p.uniqueIps ?? '?'}%</b> (порог ${p.min ?? '?'}%).\nРозница платит за «чистые» IP — проверь ротации и занятость модемов на боксе.`,
  },
  // Пул пуст: buy_proxy не смог зарезервировать ни одного free-порта.
  retail_pool_empty: {
    title: 'Розница: пул пуст (покупка отклонена)',
    priority: 'critical',
    defaultOn: true,
    cooldownSec: 1800,
    dedupeKey: p => 'poolempty_' + (p.server || 'unknown'),
    render: p => `🔴 <b>Пул розницы пуст</b>\n\nНа <b>${esc(p.server || '?')}</b> (geo ${esc(p.geo || '?')}) нет свободных портов — клиенту отказано в покупке.\nСрочно пополни пул.`,
  },
  // Заявка с лендинга не ушла в Twenty CRM. Заявка НЕ потеряна: она в
  // локальной таблице leads и в TG-боте сайта — это сигнал починить контур
  // (Twenty упала / сменилась workspace-схема после переустановки).
  crm_lead_failed: {
    title: 'CRM: заявка с сайта не ушла в Twenty',
    priority: 'critical',
    defaultOn: true,
    cooldownSec: 900,
    dedupeKey: p => 'leadfail_' + (p.error || '').slice(0, 80),
    render: p => `🔴 <b>Заявка не ушла в Twenty CRM</b>\n\nЗаявка #${p.id ?? '?'} (${esc(p.contact || '?')}) сохранена локально и продублирована в TG-боте, но push в Twenty упал:\n<code>${esc(p.error || '?')}</code>\nПроверь контейнер twenty-server/twenty-db и настройку crm_db_url.`,
  },
  // B2C Э4 (WP3): эквайринг розницы. Зачисление карта/СБП по webhook;
  // error-поле — сбой контура (amount_mismatch / credit_failed) → critical.
  retail_card_payment: {
    title: 'Розница: оплата картой/СБП',
    priority: 'important',
    defaultOn: true,
    cooldownSec: 10,
    dedupeKey: p => 'cardpay_' + (p.login || '') + '_' + (p.amount || 0) + '_' + (p.error || 'ok') + '_' + Date.now(),
    render: p => p.error
      ? `🚨 <b>Эквайринг: сбой зачисления</b>\n\nКлиент <b>${esc(p.login || '?')}</b>: ${formatRub(p.amount)} (${esc(p.method || '?')}) — <code>${esc(p.error)}</code>.\nПлатёж требует ручного разбора (card_payments).`
      : `💳 <b>Оплата ${p.method === 'sbp' ? 'через СБП' : 'картой'}</b>\n\nКлиент: <b>${esc(p.login || '?')}</b>\nЗачислено: <b>${formatRub(p.amount)}</b>`,
  },
  retail_card_refund: {
    title: 'Розница: возврат эквайринга',
    priority: 'important',
    defaultOn: true,
    cooldownSec: 10,
    dedupeKey: p => 'cardref_' + (p.order_id || '') + '_' + (p.error || 'ok'),
    render: p => p.error
      ? `🚨 <b>Возврат ${esc(p.order_id || '?')}: провайдер ОК, сторно НЕ записалось</b>\n\nКлиент <b>${esc(p.login || '?')}</b>: ${formatRub(p.amount)}.\nРасхождение ledger — ручной разбор!`
      : `↩️ <b>Возврат эквайринга</b>\n\nКлиент <b>${esc(p.login || '?')}</b>: <b>${formatRub(p.amount)}</b> (${esc(p.order_id || '?')}).\nБаланс и рефкомиссия сторнированы.`,
  },
  // B5 (C7): pricing_tiers промах — раньше молчаливый fallback в tiers[0]/23.
  // Cooldown 6ч, чтобы AutoCreate по нескольким portName не спамил.
  pricing_tier_miss: {
    title: 'pricing_tiers: промах (fallback цены)',
    priority: 'important',
    defaultOn: true,
    cooldownSec: 21600,
    dedupeKey: () => 'global',
    render: p => `⚠️ <b>pricing_tiers: ни один тир не подошёл</b>\n\nПроксей у клиента: ${p.count ?? '?'}, применён fallback <b>${p.fallback} ₽</b>.\nПроверь сетку в Настройках — min_proxies должен начинаться с 1.`,
  },
  proxy_expiring_3d: {
    title: 'Истекает срок прокси <3 дней',
    priority: 'important',
    defaultOn: true,
    cooldownSec: 86400,
    dedupeKey: p => 'expire_' + (p.server + '_' + (p.portId || '')),
    render: p => `⏰ <b>Прокси истекает через ${p.daysLeft} д.</b>\n\nКлиент: <b>${esc(p.client || '?')}</b>, порт: <code>${esc(p.portName || p.portId)}</code>\nДата истечения: ${p.validBefore}`,
  },
  domain_guard_hit: {
    title: 'Доменный контроль: обращения к банкам/платёжкам',
    priority: 'critical',
    defaultOn: true,
    cooldownSec: 72000,   // суточная джоба; 20ч, чтобы не заглушить следующий прогон
    dedupeKey: () => 'global',
    render: p => {
      const seen = {};
      const lines = (p.top || []).map(h => {
        let s = `• <b>${esc(h.client)}</b> (${esc(h.server)}): <code>${esc(h.host)}</code> +${h.delta} (всего ${h.total})`;
        // Полный список доменов клиента за день — один раз на клиента/сервер,
        // даже если совпадений с бан-листом у него несколько.
        const key = h.server + '|' + h.client;
        if (!seen[key] && h.allHosts && h.allHosts.length) {
          seen[key] = 1;
          const doms = h.allHosts.map(d => `<code>${esc(d.host)}</code> +${d.delta}`).join(', ');
          s += `\n  └ Все домены за день: ${doms}${h.allHostsMore ? ` …и ещё ${h.allHostsMore}` : ''}`;
        }
        return s;
      });
      return `🚨 <b>Доменный контроль за ${p.date}: ${p.count} совпадений с бан-листом</b>\n\n${lines.join('\n')}`
        + (p.count > (p.top || []).length ? `\n…и ещё ${p.count - (p.top || []).length}` : '')
        + `\n\nНа этих боксах фильтрация банков СНЯТА (hfilter-bypass) — это единственный контроль. Свяжись с клиентом.\nПолная история по дням: админка → Настройки → Доменный контроль.`;
    },
  },
  domain_guard_failed: {
    title: 'Доменный контроль не отработал',
    priority: 'critical',
    defaultOn: true,
    cooldownSec: 43200,
    dedupeKey: () => 'global',
    render: p => `🚨 <b>Доменный контроль не отработал</b>\n\nЗа ${p.date || '?'}: ${esc(p.error || 'unknown')}\nПовторы не помогли. На bypass-боксах сейчас НЕТ контроля обращений к банкам — разберись срочно.`,
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

  // ── D4: бывший URGENT_ACTIONS-контур logActivity (server.js) ─────────
  // Раньше logActivity сам слал немедленный TG для ВСЕХ critical-событий и
  // error-событий из URGENT_ACTIONS, кулдаун 15 мин на (action,target), гейт
  // на telegram_summary_enabled. Теперь каждое событие — правило: те же
  // каналы (TG + bell), тот же кулдаун 15 мин (cooldownSec 900), dedupeKey
  // по target (= старый action|target, т.к. ruleId входит в ключ кулдауна).
  // Немедленность сохранена: logActivity вызывает trigger() синхронно.
  // server_unreachable и db_backup_failed маршрутизируются в свои давние
  // правила выше (Stage 18.13) — здесь их нет.
  billing_failed: {
    title: 'Биллинг: сбой джобы списаний',
    priority: 'critical',
    defaultOn: true,
    cooldownSec: 900,
    dedupeKey: p => 'ua_' + (p.target || 'global'),
    render: _renderUrgentEvent,
  },
  billing_unique_conflict: {
    title: 'Биллинг: конфликт уникальности списания',
    priority: 'critical',
    defaultOn: true,
    cooldownSec: 900,
    dedupeKey: p => 'ua_' + (p.target || 'global'),
    render: _renderUrgentEvent,
  },
  tochka_sync_failed: {
    title: 'Точка: сбой синхронизации платежей',
    priority: 'critical',
    defaultOn: true,
    cooldownSec: 900,
    dedupeKey: p => 'ua_' + (p.target || 'global'),
    render: _renderUrgentEvent,
  },
  tochka_unverified_webhook: {
    title: 'Точка: неверифицированный webhook',
    priority: 'critical',
    defaultOn: true,
    cooldownSec: 900,
    dedupeKey: p => 'ua_' + (p.target || 'global'),
    render: _renderUrgentEvent,
  },
  uncaught_exception: {
    title: 'uncaughtException в процессе',
    priority: 'critical',
    defaultOn: true,
    cooldownSec: 900,
    dedupeKey: p => 'ua_' + (p.target || 'global'),
    render: _renderUrgentEvent,
  },
  unhandled_rejection: {
    title: 'unhandledRejection в процессе',
    priority: 'critical',
    defaultOn: true,
    cooldownSec: 900,
    dedupeKey: p => 'ua_' + (p.target || 'global'),
    render: _renderUrgentEvent,
  },
  telegram_summary_failed: {
    title: 'Дневная TG-сводка не отправлена',
    priority: 'critical',
    defaultOn: true,
    cooldownSec: 900,
    dedupeKey: p => 'ua_' + (p.target || 'global'),
    render: _renderUrgentEvent,
  },
  // Фолбэк для critical-событий с произвольным action (старый контур слал TG
  // на ЛЮБОЙ critical — integrity_regression, disk_low и т.п.). Сохраняет
  // покрытие: ни одно critical-событие не теряется при консолидации.
  system_critical: {
    title: 'Критическое событие (system_log)',
    priority: 'critical',
    defaultOn: true,
    cooldownSec: 900,
    dedupeKey: p => 'crit_' + (p.action || '') + '_' + (p.target || 'global'),
    render: _renderUrgentEvent,
  },
  // D7: бокс отвечает не по контракту (docs/PROXYSMART-CONTRACT.md) — поля
  // отсутствуют или сменили тип. Одно сообщение в сутки на бокс.
  proxysmart_contract_mismatch: {
    title: 'Бокс отвечает не по контракту',
    priority: 'critical',
    defaultOn: true,
    cooldownSec: 86400,
    dedupeKey: p => 'pscontract_' + (p.server || 'unknown'),
    render: p => `🔴 <b>Бокс ${esc(p.server || '?')} отвечает не по контракту</b>\n\nНарушения (${p.count || '?'}):\n<code>${esc((p.sample || '').slice(0, 500))}</code>\nПарсинг дашборда может молча деградировать — сверься с docs/PROXYSMART-CONTRACT.md.`,
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
    dedupeKey: p => 'debt_' + (p.client_id || '') + '_debt',   // D4: debt-family
    render: p => `💸 <b>${esc(p.client || '?')}</b> — баланс ${formatRub(p.balance)}.`,
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
  modems_down_bulk:          () => ({ kind: 'fleet',   id: null }),
  modem_recovered:           p => ({ kind: 'modem',   id: p.nick || p.imei || null }),
  recovery_exhausted:        p => ({ kind: 'modem',   id: p.nick || null }),
  failover_done:             p => ({ kind: 'modem',   id: p.spareNick || p.deadNick || null }),
  failover_no_spare:         p => ({ kind: 'modem',   id: p.nick || null }),
  failover_failed:           p => ({ kind: 'system',  id: 'failover' }),
  payment_received:          p => ({ kind: 'payment', id: p.natural_key || null }),
  client_balance_negative:   p => ({ kind: 'client',  id: p.client_id || null }),
  client_blocked_debt:       p => ({ kind: 'client',  id: p.client_id || null }),
  client_blocked_admin:      p => ({ kind: 'client',  id: p.client_id || null }),
  client_unblocked_debt:     p => ({ kind: 'client',  id: p.client_id || null }),
  client_block_warning:      p => ({ kind: 'client',  id: p.client_id || null }),
  proxy_expiring_3d:         p => ({ kind: 'modem',   id: p.nick || p.portName || null }),
  sim_redirect_imposed:      p => ({ kind: 'modem',   id: p.nick || p.imei || null }),
  sim_status_bad:            p => ({ kind: 'modem',   id: p.nick || p.imei || null }),
  sim_iccid_changed:         p => ({ kind: 'modem',   id: p.nick || p.imei || null }),
  reboot_score_high:         p => ({ kind: 'modem',   id: p.nick || p.imei || null }),
  traffic_spike_burst:       () => ({ kind: 'system', id: 'traffic' }),
  domain_guard_hit:          () => ({ kind: 'system', id: 'domain_guard' }),
  domain_guard_failed:       () => ({ kind: 'system', id: 'domain_guard' }),
  dashboard_restarted:       () => ({ kind: 'system', id: 'pm2' }),
  heap_warn:                 () => ({ kind: 'system', id: 'heap' }),
  disk_low_warn:             () => ({ kind: 'system', id: 'disk' }),
  cron_stuck:                p => ({ kind: 'system', id: 'cron:' + (p.job || '') }),
  // D4 — бывший URGENT_ACTIONS-контур
  billing_failed:            () => ({ kind: 'system', id: 'billing' }),
  billing_unique_conflict:   () => ({ kind: 'system', id: 'billing' }),
  tochka_sync_failed:        () => ({ kind: 'system', id: 'tochka' }),
  tochka_unverified_webhook: () => ({ kind: 'system', id: 'tochka' }),
  uncaught_exception:        () => ({ kind: 'system', id: 'process' }),
  unhandled_rejection:       () => ({ kind: 'system', id: 'process' }),
  telegram_summary_failed:   () => ({ kind: 'system', id: 'summary' }),
  system_critical:           p => ({ kind: 'system', id: p.action || null }),
  proxysmart_contract_mismatch: p => ({ kind: 'system', id: p.server || null }),
  // B2C Э3 (WP5): розница
  retail_registered:         p => ({ kind: 'client', id: p.login || null }),
  retail_purchase:           p => ({ kind: 'client', id: p.login || null }),
  retail_bulk_buy:           p => ({ kind: 'client', id: p.client_id || null }),
  retail_pool_low:           () => ({ kind: 'system', id: 'pool' }),
  retail_pool_empty:         p => ({ kind: 'system', id: p.server || null }),
  retail_test_day_ended:     p => ({ kind: 'client', id: p.client_id || null }),
  // B2C Э5 (WP7): антифрод розницы
  retail_abuse_suspend:      p => ({ kind: 'client', id: p.client_id || null }),
  retail_multiaccount_ip:    () => ({ kind: 'system', id: 'multiaccount' }),
  retail_pool_ip_degraded:   p => ({ kind: 'system', id: p.server || null }),
  // B2C Э4 (WP3): эквайринг розницы
  retail_card_payment:       p => ({ kind: 'client', id: p.client_id || p.login || null }),
  retail_card_refund:        p => ({ kind: 'client', id: p.client_id || null }),
  // Заявки с лендинга → Twenty CRM
  crm_lead_failed:           () => ({ kind: 'system', id: 'crm' }),
  // Stage 18.15 — bell-only sources
  modem_offline:             p => ({ kind: 'modem',  id: p.nick || p.imei || null }),
  client_debt:               p => ({ kind: 'client', id: p.client_id || null }),
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

    const token = getSetting('telegram_bot_token', '');   // WP5: enc1: в kv — не читать appSettings напрямую (шифртекст)
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
// Telegram framework (the collector job for offline modems, client debts).
// Same dedup model — caller passes a stable dedup_key
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
// D4: общий renderer бывшего URGENT_ACTIONS-контура — формат сообщения
// сохранён 1-в-1 со старым _emitUrgentAlert из server.js.
function _renderUrgentEvent(p) {
  const icon = p.level === 'critical' ? '🚨' : '⚠️';
  const lvl = String(p.level || 'error').toUpperCase();
  return `${icon} <b>${lvl}</b>\n<code>${esc(String(p.action || '').slice(0, 60))}</code>${p.target ? ' · ' + esc(String(p.target).slice(0, 60)) : ''}\n${esc(String(p.message || '').slice(0, 800))}`;
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
