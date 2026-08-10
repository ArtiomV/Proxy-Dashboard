# Proxy Dashboard — полная функциональная спецификация

> Назначение документа: единый источник правды о функционале и логиках системы для рефакторинга и исправления логик. Описывает ЧТО система делает, КАК и ПОЧЕМУ (включая исторические причины решений). По состоянию на 2026-08-04.

Система: оператор мобильных прокси. 4 сервера ProxySmart (S1 Молдова, S2 Румыния, S3/S4 Молдова), каждый с фермой USB-модемов; прокси-порты привязываются к клиентам (portName). Дашборд (Node.js/Express + SQLite) — центр управления: мониторинг флота, клиенты, биллинг, банк (Точка), алерты (Telegram).

---

## 0. Архитектура в одну картинку

```
┌────────────────────────┐   опрос ~каждые 1-2 мин (HTTP basic auth)
│ ProxySmart боксы ×4    │◄──────────────────────────┐
│ /apix/* (status, bw,   │                           │
│  ports, top_hosts…)    │                           ▼
└────────────────────────┘              ┌──────────────────────────────┐
                                        │  Dashboard (pm2, :3000)      │
┌────────────────────────┐              │  server.js + src/*           │
│ Точка Банк API         │◄──── счета/акты/выписки/вебхуки ──│  SQLite dashboard.db        │
└────────────────────────┘              │  in-memory state (stateMod)  │
┌────────────────────────┐              └──────┬───────────┬───────────┘
│ Telegram Bot           │◄─── алерты/сводки ───┘           │
                                                             ▼
                                            Админка (admin.html)
                                            Клиентский портал (index.html)
                                            Публичное API (X-API-Key)
```

Основные процессы: единый Node-процесс (`server.js` + `src/`), периодические джобы из `src/boot/startup.js`, БД SQLite (WAL), деплой — rsync из git-worktree + `pm2 restart dashboard --update-env`.

---

## 1. Модель данных (SQLite dashboard.db, WAL; schema.sql + migrations/001–057)

### 1.1. Клиенты и деньги
- **clients** — один клиент = один `port_name` (биндинг портов в ProxySmart). Поля: login (UNIQUE), password_hash (bcrypt), billing_type (`per_gb`/`per_modem`), price, balance (владеет только atomicCredit/atomicDebit — в saveClients-upsert НЕ входит), billing_paused, client_type (`individual`/`legal`; при ручном создании по умолчанию `individual`, AutoCreate под новый portName — `legal`), auto_acts/auto_bills, inn/kpp/legal_name/contract_info/contract_date (день взаиморасчётов — день выставления актов/счетов, 1..28), allow_debt/max_debt (allow_debt=0 у физика включает автоблок по долгу — §2.9; юрлица игнорируют allow_debt никогда не блокируясь), debt_blocked (флаг факта автоблока — §2.9), api_key/reset_token (SHA-256 at rest), referral_*. **Создание клиентов — только два пути (Р12/B4):** AutoCreate под новые portName — каждые 10 мин (цена по pricing_tiers, §2.10) — и ручное создание из админки. Автосоздания из банковского платежа НЕТ: платежи матчатся к существующим клиентам (findClientByPayer), неопознанные — ручная привязка в UI.
- **billing_ledger** — ЕДИНСТВЕННЫЙ источник правды по деньгам. type: charge/correction/manual_charge/payment/bank_payment/manual_credit/adjustment/payment_reversal. amount, gb_used, date (МСК), balance_before/after (цепочка — основа сверки), source, details(JSON). Идемпотентность: частичный UNIQUE (client_id,date,type) — дабл-списание отклоняется. Пишется ТОЛЬКО через atomicCredit/atomicDebit (транзакция с clients.balance + реферальная комиссия 10% внутри; Р6). Правки — ТОЛЬКО через payment_reversal (сторно с откатом баланса и реферальной комиссии в одной транзакции); физический DELETE строки ledger запрещён (A4, роут отвечает 405). Аудируется триггерами (db_audit; clients.price — тоже, миграция 057, B1). Канон баланса — ledgerFinalBalance (последний balance_after + типизированный хвост), НЕ реплей суммы. Все метрики — через `ledgerExpense()`/`computeRevenueWindow`.
- **bills** — счета: amount, status (unpaid/paid/replaced), bill_number (сквозной «N/YYYY» — §2.5), tochka_bill_id, formula (JSON-разбор расчёта; при ручной правке — edited_from). UNIQUE(client_id, period) — анти-дабл гейт (B2, миграция 056).
- **closing_documents** — акты: items (JSON позиций), total_amount, status (unsigned/signed), tochka_doc_id, act_number (сквозной «N/YYYY» — §2.5). UNIQUE(client_id, period, type) — анти-дабл гейт (B2, миграция 056). Позиции правятся из админки; в банке — только delete+create.
- **bank_payments** — входящие платежи Точки: payment_id/tochka_payment_id (UNIQUE), natural_key = ИНН|сумма|дата|назначение-prefix (главный анти-дабл гейт вебхук↔синк; при коллизии двух РАЗНЫХ платежей в день — суффикс `#2`/`#3` по resolveNaturalKey: повторная доставка с тем же paymentId — дубль, новый paymentId — отдельный платёж, A3), matched_*, dismissed, source.
- **payments** — legacy read-only (новые платежи не пишутся); все читатели переведены на billing_ledger (C5a, 2026-08: портал, публичное API, бут-загрузка и in-memory `client.payments[]` выпилены). **Дроп после чистой сверки** `scripts/reconcile-payments.js` — ручная миграция `migrations/manual/056_drop_payments.sql` (C5b, см. OPERATIONS.md).

### 1.2. Модемы и ростер
- **modem_meta** — авторитетная мета модема (UNIQUE server_name+imei): nick, operator/model/phone/iccid, sim_status, reboot_score, http_redirect, band, signal, deleted. Upsert «preserve-on-empty». Soft-delete (скрытие) + auto-restore (3 подряд онлайн-опроса).
- **known_modems** — реестр реквизитов: PK (server_name, port_key), data JSON {portName, imei, nick, model, portInfo, lastSeen, lastClientSeen, _missingSince}. Липкий; реконсиляция 7 дней; move-dedupe per (server,imei,portName).
- **uptime_tracking / uptime_daily** — total/online checks, last_online_check, offline_alerted (парность алертов «отключился/вернулся»).
- **ip_tracking / ip_history** — текущий IP + история смен (100 записей/ключ, интервалы from/to) — «Завис IP».
- **rotation_log** — ротации (UNIQUE server+nick+started_at, caller/target_mode).
- **proxy_checks** — curl-замеры (connect/total ms, status, error): health/latency.
- **modem_health_daily**, **server_downtime**, **failover_log**, **auto_reboot_log**, **operator_country_map** (auto+manual).

### 1.3. Трафик
- **traffic_hourly** — почасовой durable-учёт: UNIQUE(port_id, hour_start), bytes_in/out, uncertain (0=ок, 1=gap-fill, 2=расхождение счётчиков, 3=сглажено медианой), client_name/operator/nick заморожены при записи. Основа биллинга.
- **hourly_snapshots** — базлайны счётчиков для дельт (внутреннее).
- **daily_traffic** — суточный канон: UNIQUE(port_name, date), MAX-семантика (байты не убывают), client_name при записи.
- **traffic_recon** — (историческая) сверка с pmacct. 2026-08-07: сверка и её алерты УБРАНЫ решением оператора; таблица дропнута миграцией 055. Остаёмся на модели учёта по прокси-payload (pmacct = сетевой уровень, +5–7% к нашему числу; биллинг всегда по нашему).
- **top_hosts_detail / top_hosts_daily / domain_guard_hits** — доменный контроль.

### 1.4. Состояние/журналы
- **kv_store** (+kv_store_history 50 версий): app_settings (секреты enc1: AES-GCM), api_servers, кэши, маркеры джоб, baseline'ы. kvSetCritical — shape-guard против «усыхания» значения.
- **sessions** — SHA-256 токены, TTL 30д. **notifications**(+read_state) — колокольчик (TTL 30д).
- **audit_log / system_log / db_audit(+context)** — аудит действий, события автоматики (critical/error сразу в TG), триггерный аудит денежных таблиц.
- **api_usage / api_access_log** — телеметрия API.
- **monthly_costs** — расходы per (period, category, subkey=сервер/оператор).
- **simulator_***, **client_documents**, **_migrations**. (sla_violations, external_proxies, sales_* — дропнуты миграцией 055, выпил фич по ТЗ C1/C3/C6.)
- Файловые хранилища вне БД (и вне бэкапов!): speedtest_history.json, server_cache.json. ~~tochka_config.json~~ — перенесён в kv_store (D1, 2026-08), файл оставлен read-only как legacy-фолбэк/источник миграции.

---

## 2. Бизнес-логики (ядро, выверенное сессиями)

### 2.1. Fleet-счётчики (src/modems/fleet.js)
- `total` = стабильный ростер (modem_meta, без random/test/soft-deleted). Меняется только при добавлении железа/soft-delete.
- `active` = весь ростер (48h-правило УБРАНО 2026-07-28 — мёртвые не выпадают).
- `online` = IS_ONLINE=yes в живом снапшоте. `offline` = active − online.
- `disconnected` = offline дольше `modem_offline_threshold_min` (настройка, дефолт 10 мин; на проде 15) → карточка «Модем отключен», TG-алерт, колокольчик. Единый порог везде.
- `working` = active − disconnected. Показ «working/total».
- Glitched-to-random credit: модем, пере-энумерованный как random-порт (USB слот пуст, random онлайн) — кредитуется в disconnected, чтобы не занижать working.

### 2.2. Ростер реквизитов (known_modems, src/services/modems.js)
- Порт попадает в ростер из bw-фида или из list_ports_json (порт мёртвого модема тоже существует!).
- **Липкость:** временная пропажа с бокса не убирает реквизит.
- **Реконсиляция:** отсутствует непрерывно >7 дней (по свежим данным) → выбывает.
- **Move-dedupe** по (server, imei, portName): пере-энумерация с новым portID вытесняет старый (total не раздувается).
- **Pass A (cleanup)** — дедуп только per-(server,imei): клонированные IMEI на разных стиках/серверах существуют (доказано access-логами).
- **Pass C удалён:** «модем онлайн на другом порту» больше не сносит биндинг.
- **Soft-delete** (кнопка 🗑) прячет модем со страницы модемов; реквизиты с клиентской привязкой НЕ сносит (с 2026-08-04) — credential продолжает считаться у клиента. Auto-restore: 3 подряд онлайн-опроса → модем сам возвращается (настройка `modem_restore_online_polls`); одиночный блип не воскрешает.

### 2.3. Биллинг (src/jobs/billing.js, ежедневно 01:00 UTC (04:00 МСК) + ретраи)
- Списание = max(durable traffic_hourly, live ProxySmart counters) за вчера (MSK). Durable выигрывает при рестартах бокса (счётчики обнуляются).
- Теневой тест ShadowBilling запущен (01:10 UTC, сравнение V1/V2 → billing_shadow_log, еженедельный итог в TG по понедельникам); переключение канона durable/live — после 4 недель по критериям ТЗ §2.2.
- Пауза (`billing_paused=1`) → джоба пропускает клиента («Skipping … billing paused»), деньги не уходят; клиент исключён из всех текущих финстатистик (revenue_30d «MRR», per-tariff, daily revenue, forecast), но история остаётся фактической.
- Долговая политика: allow_debt/max_debt, алерты «списание не прошло», пауза обслуживания.
- Идемпотентность: одна запись на клиент-день; ретраи через billing_retry_delay_hours.

### 2.4. Счёт на оплату (formula per_gb)
`сумма = max(списания прошлого месяца, среднесуточное за последние 7 дней × дней в месяце × тариф) + долг`, округление вверх до кратного 10 000 ₽ (пример: 12 300 → 20 000; только per_gb — src/tochka/documents.js:390-392). Разбор хранится в bills.formula и показывается на странице актов/счетов. per_modem: price × живые модемы (без округления).
- Выставление: в день расчёта клиента (contractDate day, дефолт 1), autoBills.
- Правка суммы вручную сохраняет formula.edited_from.

### 2.5. Акты
- **Нумерация актов и счетов (B2, Р15/Р23):** сквозная «№ N/YYYY» — **единый счётчик для актов и счетов вместе** (таблица `doc_numbering`: year → next_num; решение: одна серия на систему, т.к. ТЗ требует «сквозная по системе с годом»). Номер выдаётся атомарно (INSERT OR IGNORE + UPDATE … RETURNING в одной транзакции), старт с 1 для каждого нового года. Дыры от удалённых документов НЕ переиспользуются; удаление фиксируется в audit_log с номером (delete_closing_document/delete_bill). Документы старого формата «АКТ-YYYYMM-<id4>» не перенумеровываются. Анти-дабл: UNIQUE(client_id, period, type) на closing_documents и UNIQUE(client_id, period) на bills — истина; in-memory проверки в роутах/кроне — fast-path (create_act/create_bill отвечают 409 при существующем документе за период). Храним наш номер (act_number/bill_number) + tochka_doc_id/tochka_bill_id.
- Позиции из ledger: per_gb → **строка на каждый непрерывный период одной цены** («трафик 01.08–14.08 по 250 ₽/ГБ» + «15.08–31.08 по 220 ₽/ГБ»; B1, Р14/Р32 — без grandfathering, разбивка по price_per_unit каждого списания; одна цена за месяц → одна строка «трафик за <месяц>»); per_modem → строка на каждую группу «N модемов × D дней» **по сочетанию количество×цена** (при нескольких ценах в названии добавляется «по X ₽/мес»); корректировки → отдельная строка «Корректировка (доначисление/возврат)».
- **Журнал смены цены (B1):** ручная смена через PUT /api/admin/clients/:id пишет audit_log (action=price_change: кто/старая/новая) + system_log; сам UPDATE clients.price покрыт db_audit-триггером (миграция 057). Точная ретро-разбивка возможна только по строкам ledger с price_per_unit; у legacy-строк без неё берётся текущая цена клиента.
- Негативные позиции фолдятся (sanitizeActPositionsForTochka — Точка отвергает отрицательные).
- Редактирование позиций в админке (PUT closing_documents/:docId) — наша история верна; «↻ В Точку с правками» — удалить в банке + создать заново с правками (API Точки не редактирует документы).

### 2.6. Метрики: факт vs ожидание (GET /api/admin/finance_dashboard, src/routes/billing-ext.js)
Главное правило: **«Выручка 30д (факт)» ≠ «Run-rate (ожидание)»**. В API оба числа рядом: факт — `metrics.revenue_30d` (= `summary.mrr`, легаси-имя; явный алиас `summary.revenue_30d_fact`), ожидание — `summary.forecast_eom` (явный алиас `summary.run_rate_eom`). Смешивать их в одной подписи «MRR» нельзя — в UI факт и ожидание подписаны отдельно.

- **Выручка 30д (факт)** = Σ charge + correction через ledgerExpense за скользящие 30 дней с краями окна в MSK; клиенты на паузе исключены (billing-ext.js:124-131, канон — computeRevenueWindow, src/billing/revenue.js:28-49). Это ФАКТ: деньги уже списаны.
- **Run-rate (ожидание)** = прогноз месяца (forecast EOM): Σ по клиентам — per_gb: среднесуточное потребление за последние 7 дней × дней в месяце × тариф; per_modem: price × живые модемы; paused исключены (billing-ext.js:377-398; та же формула, что в счетах — src/tochka/documents.js:352-365). Это ОЖИДАНИЕ при текущем темпе, не выручка; в тренде рисуется полупрозрачным столбцом, формула — за кнопкой «Формула».
- **ARR** = Выручка 30д × 12 (billing-ext.js:157) — бегущая годовая оценка, не GAAP-метрика.
- **ARPU** = Выручка 30д / активные клиенты; активный = не на паузе И выручка 30д > 0 (billing-ext.js:160, 172).
- **NRR (когорта 3 мес)** = выручка когорты за последние 30д / её же выручка за окно 120..90 дн назад; когорта = клиенты со списаниями в базовом окне (billing-ext.js:138-141, 187-195). NB: базовое окно берёт только `type='charge'` (без корректировок), а «сейчас» — charge+correction, т.е. формула слегка завышает NRR при возвратах; держится для сопоставимости истории.
- **Churn rate (клиентский, за месяц)** = ушедшие / активные на начало периода: ушедший = выручка в окне 60..30д назад > 0 и = 0 за последние 30д; база = клиенты с выручкой > 0 в окне 60..30д назад (billing-ext.js:164-169, 197-201). Revenue churn (доля потерянной выручки) отдельно НЕ считается — при необходимости: Σ last_mrr ушедших / выручка окна 60..30д назад.
- **Концентрация Top-1/3/5** = доля N крупнейших клиентов в Выручке 30д (billing-ext.js:174-185).

### 2.7. Алерты
- Оффлайн-модем: TG-алерт в окне [threshold; 12ч) тишины; парность «отключился/вернулся» через offline_alerted; сводный «🚨 Не работает модемов: N» (modems_down_bulk) — порог настраивается, soft-deleted не попадают (janitor _downSince).
- Колокольчик = ровно fleet.disconnectedList (per-day dedup).
- Серверные: server_unreachable (≥10 мин), дневная сводка, долги.

### 2.8. Recovery / failover
- Auto-recovery: ребут модема → Re-Add → сдача (recovery_exhausted) с дневными капами.
- Failover: переназначение клиентских модемов на запасные при смерти/глючности (dry-run режим по умолчанию).

### 2.9. Блокировка должников-физиков (B3, Р13/Р24/Р25; src/jobs/debt-block.js)
- **Условия:** клиент-физик (`client_type != 'legal'` — юрлица НЕ блокируются никогда, явная проверка), `balance ≤ 0` после DailyBilling и `allow_debt = 0`. allow_debt=1 — не трогаем (дефолт колонки уже 0 — существующие физики под блокировкой, мягкость обеспечивается цепочкой уведомлений; юрлица allow_debt игнорируют). per_modem физики блокируются так же (Р25 — долг возможен при любом тарифе).
- **Механика:** пост-биллинговый проход в конце runDailyBilling (после освобождения clients-lock; идемпотентен, работает и на retry-прогонах). Для всех портов клиента выставляется «дата до» (`PROXY_VALID_BEFORE`) = **сегодня** — тем же путём, что ручной save_port_config: чтение формы `/conf/edit_port/:portId` целиком (proxyConf, обход логин-стены S2) → правка одного поля → POST → `apply_port`. ProxySmart гасит порт. Порты с уже истёкшей датой (в т.ч. ручной override в прошлое) не перезаписываются.
- **Флаг `clients.debt_blocked`** (миграция 056): ставится только когда погашен ≥1 порт именно автоблоком. По нему восстановление отличает наш блок от ручного — ручное гашение автоматом не «лечится». Блок/восстановление пишутся в audit_log (debt_block/debt_unblock) + system_log.
- **Уведомления:**
  - **«за 3 дня» (прогноз):** `0 < balance ≤ 3 × среднесуточное списание за 7 дн` (charge-строки ledger за [today−7..today−1]/7 — тот же avgDailyCharge7d, что в портале) → TG-правило `client_block_warning` (cooldown 3 сут — одно предупреждение на эпизод) + портал-баннер «баланса хватит на N дн.».
  - **в день блока:** TG-правило `client_blocked_debt` (critical) + портал-баннер «доступ приостановлен».
  - **истекающая «дата до»:** админский алерт `proxy_expiring_3d` (ProxyExpiryCheck 06:30 UTC) + клиентский контур — `billing.expiresAt` в dashboard_data, портал-баннер при ≤ 3 днях.
  - Портал-баннер рендерится на вкладках «Трафик» и «История баланса» из `debtStatus` (blocked/debt/warning) в `/api/dashboard_data` и `/api/billing_history`; юрлица и allow_debt=1 получают null.
- **Восстановление:** любое зачисление (atomicCredit: ручной платёж, webhook, TochkaSync, ручная привязка) эмитит событие `client-credit` (src/billing/events.js); слушатель вызывает restoreAfterCredit: если `debt_blocked=1` и `balance > 0` → «дата до» продлевается на **сегодня + 30 дней** (дефолт B3: стандартного срока у портов/ручного override в коде нет; более поздний ручной срок не укорачивается) → флаг снимается. Задержка восстановления — до ~30 мин для банковского канала (цикл TochkaSync), мгновенно для ручного платежа/webhook.
- **Ручной override** «Действителен до» в UI (save_port_config) сохраняется и имеет приоритет: автоблок не перезаписывает уже истёкшие даты, восстановление — более поздние.

### 2.10. Прайсинг-сетка pricing_tiers (B5)
- **Хранилище:** `appSettings.pricing_tiers` — JSON-массив `[{ min_proxies, price, label }]`, редактируется в Настройках (PUT /api/admin/settings… блок в servers.js + UI settings.js). Дефолт: 30 ₽ (1–4), 25 ₽ (5–9), 23 ₽ (10–19), 20 ₽ (20+).
- **Правило выбора** (`getPriceForProxyCount`, server.js): тиры сортируются по убыванию min_proxies, берётся первый с `count >= min_proxies` — т.е. скидка за объём.
- **Применение:** тир вычисляется ТОЛЬКО при создании клиента (AutoCreate по числу живых проксей portName) и записывается в `clients.price`; дальше цена живёт в клиенте, изменение сетки существующих не пересчитывает. Смена `clients.price` — руками, с журналом B1 (§2.5).
- **Промах (ни один тир не подошёл, напр. count=0 или min_proxies все > count):** fallback `tiers[0].price` (или 23 при пустой сетке) — но больше НЕ молчит (правило C7): warn в logger + system_log (`pricing_tier_miss`) + TG-алерт оператору (правило `pricing_tier_miss`, cooldown 6ч — AutoCreate может создавать несколько клиентов за прогон).
- NB: per-server ветка pricing_tiers (servers.js:204) — write-only, никем не читается (зафиксировано; выпил — в рамках будущего единого прайса tariffs, Р36).

---

## 3. Карта взаимосвязей (потоки данных)

### 3.1. Главный поток ProxySmart → UI
```
ProxySmart /apix/* ─ fetchServerData (3 GET параллельно, 10с таймаут, ≤16 МБ) ─► server_cache.json (last-good)
   │                                                                                  │
   ├─ injectRotationData (kv rotation_cache, обновляется 30 мин)                      ├─ updateKnownModems → known_modems (БД)
   │                                                                                  └─ injectOfflineModems (плейсхолдеры из ростера + modem_meta fallback)
   ▼
fetchAllServersData (allSettled; при outage — getCachedDataAsOffline: <10 мин «как есть», ≥10 мин все офлайн)
   ▼
_psCache SWR (TTL 10с / stale ≤5 мин, single-flight) ─ fetchAllServersDataCached
   ▼
mergeServerData: префиксация S<n>_, фильтр portName, вычитка randomport*, бэкфилл CELLOP из meta
   ▼
Потребители:
 ├─ trackModems (3 мин) → modem_meta, uptime/ip tracking, auto-recovery, TG-алерты, mass-down сводка
 ├─ HourlyAgg (:00) → traffic_hourly (durable) ─┐
 ├─ DailySync (00:45/07:00/15:00) → daily_traffic │
 ├─ DailyBilling (01:00) ─ max(durable, live) → atomicDebit → billing_ledger ─► выручка 30д/акты/счета
 ├─ conns-history (1 мин), notify-collect (2 мин → колокольчик), proxy-checks (60 мин), failover (3 мин)
 └─ Роуты: /api/admin/data (главный агрегат админки), /api/dashboard_data (портал), /api/v1/proxy(s) (X-API-Key)
```

### 3.2. Деньги и банк
```
billing_ledger ◄─ atomicCredit/Debit (единственные писатели; транзакция с clients.balance)
   ▲   │  ▲
   │   │  └─ DailyBilling / billing_rerun / monthly-reconciliation / ручные операции
   │   └─► computeRevenueWindow → revenue_30d (факт, одно число везде) → finance_dashboard → Дашборд/Клиенты
   │
Точка: webhook (JWT/JWKS-verify) ─┐
   statement-sync (30 мин, 14д) ──┴─► bank_payments (natural_key анти-дабл) → матч по ИНН → atomicCredit
                                          → settleBillsOnPayment (номер в назначении → точная сумма → старейшие)
                                          → TG payment_received; BillStatusSync (ежедневно) — страховка
Документы: MonthlyActs/MonthlyBills (день взаиморасчётов, ≥08:00 МСК) → POST в Точку → closing_documents/bills
```

### 3.3. Модемы/контроль
```
trackModems → uptime_tracking.last_online_check ─► computeFleet.disconnectedList ─► «Модем отключен»+TG+колокольчик
                                        (порог = modem_offline_threshold_min, единый везде)
known_modems (ростер реквизитов) ─► computeClientWorking (working клиента) + injectOfflineModems (плейсхолдеры)
TopHosts (03:00) → top_hosts_detail → DomainGuard (03:25, guard-servers S2/S4) → domain_guard_hits → алерты
cleanup (00:30 + hourly): retention; Pass A — dedupe per (server,imei); мёртвые модемы НЕ вытесняются
```

### 3.4. kv_store — ключи и владельцы
`app_settings` (все настройки; секреты enc1:), `api_servers` (боксы+метаданные; boot-мерж с env), `tochka_config` (D1: конфиг Точки Банка, каждое непустое поле — `enc1:` AES-GCM; приоритет env TOCHKA_* > kv > legacy-файл, миграция файла при первом буте; shape-guard считает только поля), `top_hosts_cache`, `rotation_cache`, `hourly_last_recorded`, `last_reconciliation_month`, `reconcile_known_breaks`, `telegram_alert_cooldowns`, `telegram_last_sent_date`, `integrity_baseline_*`.

### 3.5. In-memory состояние (src/state + server.js)
Стабильные ссылки (mutate-in-place): clients[]+мапы (ById/ByLogin/ByApiKey/ByInn/ByResetToken), dailyTraffic, ipTracking, uptimeTracking, ipHistory, appSettings, knownModems, tochkaConfig, portKeyToPortName. Прочее: apiServers, users, modemRotationCache, autoRecovery, _serverDownSince, offlineAlertSent, _downSince, _deletedModemSet (+_deletedOnlineStreak), _panelSessions, snapCache (hourly), connsHistory (65 мин, 1-мин сэмплы), _psCache. Мьютекс withClientsLock сериализует billing против saveClients.

### 3.6. Симулятор нагрузки (src/simulator, src/routes/simulator.js; D11)
Инструмент стенда, не прода: «не запускать в проде без необходимости».
- `simulator_enabled` (appSettings, **дефолт false**): POST /api/admin/simulator/run → 403, UI показывает баннер «выключено». Исторические runs/profiles читаются и при выключенном флаге.
- Лимиты ресурсов (appSettings): `simulator_max_duration_min` (30, кламп duration_ms), `simulator_max_workers` (50, потолок concurrency), `simulator_max_sse` (10, лишний стрим → 429). Одновременно возможен только один run (singleton в engine).
- Blast radius: прогон гоняет реальную нагрузку через модемы тест-пула (is_test_pool=1) и пишет сэмплы в simulator_samples батчами раз в секунду. Биллинг и вебхуки Точки симулятор не трогает, но нагрузка на тест-модемы/сеть — реальная: прогоны только вне пиков и только test-pool.


---

## 4. Интерфейсы

### 4.1. Админка (public/admin.html + public/js/admin*.js)

**Навигация** (`switchMainTab`, активная вкладка в localStorage): Дашборд / Модемы / Клиенты / Финансы / Настройки. Шапка: бейдж «В работе: N/M» (fleet), время обновления, колокольчик уведомлений (фильтры, переходы к сущностям; источник `GET /api/admin/notifications`), автообновление ~10 с. Баннер «сервер недоступен — данные из кеша» на всех вкладках.

#### Дашборд («Командный центр»)
- **Пульс бизнеса**: Трафик сегодня (парк), Активные модемы working/total, Выручка 30д (факт) (+Δ М/М), На балансах (Σ положительных балансов).
- **Требует внимания** (4 карточки): «Проблемы инфраструктуры» (плитки Модем отключен / Низкая скорость / Завис IP / Сбоит прокси — клик открывает попап со списком); «Потребление трафика» (тренд 6 мес); «Выручка: факт и прогноз» (стек-бар «За ГБ»/«За модем» + run-rate прогноз месяца полупрозрачным столбцом, поповер «Формула» — см. §2.6); «Операторы» (трафик/модем/сут, ₽/ГБ себестоимость).
- **Парк по серверам**: «Весь парк» + карточка на сервер (working/total, отключено, трафик сегодня/месяц, сигнал, проблемные).
- **Финансы**: «Выручка по дням» (стек по клиентам, 30 дн) + «Последние пополнения» (5, с разделителями); «Качество выручки» — плитки в порядке: Выручка 30д (факт) → Расходы (мес.) → Прибыль 30д → Маржинальность → Run-rate (ожидание) → NRR 3мес → Churn → ARPU → Активных клиентов + кнопка **«⚙ Затраты»** (редактор себестоимости) + бары концентрации Top-1/3/5.
- **Клиенты**: таблица Клиент/Live/Сегодня/Тариф/Выручка 30д/Δ M/M/% выручки/Баланс.
- **Инфраструктура** (раскрывашки): Топ проблемных модемов (ребут/Re-Add), Ротации·IP·ёмкость (периоды 1–30 дн, успешность %, уникальных IP, подсетей/модем), Распределение задержек (P50/P95/ошибки), Сверка биллинга (расхождения ГБ, «не выставлен счёт», «счёт без трафика»).
- **Трафик**: почасовая тепловая карта (страны/операторы/клиенты, GMT+3), потребление 60 дней (стек по клиентам/странам), топ доменов, матрица трафика, обращения к API (кто/тип/цель/статус/мс/IP).

#### Модемы
- Чипы-фильтры: Все/Онлайн/Проблемы/SIM/Офлайн/Свободные; селекты сервера (группы по странам) и клиента; виды Таблица/Сетка. Тест-пул 🧪 из счётчиков исключён.
- Таблица: rail причины, статус-пилюля (+«блип»), флаги 🧪⛔📴♻🔒🌐⚠, чипы исключения «Не в стат.»/«Без клиента», портName-бейджи, креды (копия), IP, трафик, скорость, аптайм, латентность (инлайн-лог проверок по клику), TCP-коннекты со спарклайном 60 мин, ошибки %, здоровье, ротация. По серверу: «↻ Сброс IP», «⏻ Ребут» (пароль).
- Bulk: сброс IP, ребут, OS-spoof, ротация, экспорт (формат/фильтры/скачать), proxy-check, удаление.
- Карточка модема: Обзор (баннер состояния, действия Сброс IP/Ребут/Re-Add/Доступ, KPI, Сеть и сигнал, Подключение — по каждому порту своя «📋 строка» креда, Трафик, тоггл тест-пула), Здоровье (скор /100, таймлайн 30 дн, разложение по факторам, формула), Трафик (heatmap + топ доменов модема), История (ротации IP, спидтесты + запуск), Настройки (идентификация, сеть/ротация, порты: перенос/редактирование/удаление/добавление). SMS/USSD, VPN-профиль.

#### Клиенты
- Фильтры: Все/Активные/Должники/Истекают (баланс < 5 дней расхода). Карточка: статус ДОЛЖНИК/ПАУЗА/НЕТ МОДЕМОВ/АКТИВЕН, баланс, тариф, расход/трафик в мес, модемов working/total. Вход как клиент (impersonate). Привязка/отвязка модемов.
- Карточка клиента: Обзор, Тариф и баланс (доступ, банковские реквизиты, авто-акты/счета, пауза биллинга, минус/макс-долг, API-ключ), Модемы, Платежи (пополнить/списать, ledger по месяцам/кварталам; платежи — кнопка «Сторнировать» через payment_reversal, физическое удаление запрещено — A4).
- **Документы**: Акты — создать за период, редактор позиций ✏️ (название/кол-во/ед.-выпадающий список/цена; «💾 Сохранить» локально, «↻ В Точку с правками» — удалить в банке + создать с правками), PDF/печать/статус/перевыставить/удалить. Счета — выставить (сумма авто по формуле или вручную), ✏️ сумма, ↻ перевыставить с новой суммой, PDF, статус, удалить. Расшифровка формулы счёта в списке (per-GB). Файлы — загрузка/скачивание.

#### Финансы (вкладка)
Сайдбар: Акты (массовая генерация за месяц, аккордеон по месяцам, действия ✏️/📥/✅/↻/🗑), Счета (аналогично + формула), Платежи (неопознанные — привязка к клиенту вручную, последние платежи). Редактор затрат (по серверам ₽, SIM ₽/мес по операторам, прочее; шаблон из прошлого месяца). Настройка Точки (JWT/Customer Code/Account ID, webhook, синхронизация платежей).

#### Настройки
Мониторинг (здоровье сервера, системный лог, журнал действий); Инфраструктура (серверы — карточки с кредами, операторы→страны); Автоматика (правила уведомлений с каналами/кулдаунами/тестом, порог массового падения `modems_down_threshold`, failover — тогглы/пороги/кандидаты/ручной перенос/история, восстановление, проверка прокси); Инструменты (банк-конфиг, симулятор нагрузки с профилями/SSE-стримом, тест-пул); Данные (Telegram-уведомления и сводка, спидтесты/пороги, `stale_modem_hours`, `modem_offline_threshold_min`, трекинг, хранение, сессии/биллинг, тарифная сетка pricing_tiers).

### 4.2. Клиентский портал (public/index.html + client.js)
- Логин (поддержка impersonate админом), тёмная тема.
- **Панель**: активных портов (по странам), трафик сегодня/за месяц (**биллинговый объём = совпадает с актом**), баланс, аптайм 30д; таблица модемов (статус, реквизиты ip:port + копия, логин:пароль, смена IP по ссылке/кнопке, история IP, выбор ротации, трафик ↓/↑); экспорт прокси (TXT/JSON/CSV, cURL/Python/.env, PAC/FoxyProxy, свой шаблон; фильтры).
- **Аналитика**: трафик за период, прогноз до конца месяца (объём ÷ дней × дней в мес.), топ-день, среднесуточное, посл. час; чарты по локациям/модемам, периоды/диапазоны.
- **История баланса**: баланс, расход за месяц, средний расход/день, дней до нуля; по месяцам (трафик/списано/оплачено, фильтры типов).
- **Документы**: акты (PDF, бейдж неподписанных), счета (PDF, неоплаченные), файлы.
- **API**: документация по X-API-Key, GET /api/v1/proxy, смена IP, коды ошибок.
- **Партнёрская программа**: 10% от платежей привлечённых.

### 4.3. Публичное API (X-API-Key)
`GET /api/v1/proxy` — список прокси клиента (креды, состояние); смена IP по secure-ссылке; учёт обращений (api_usage, api_access_log — видно в админке «Обращения к API»; деньги не затрагиваются, D10).

### 4.4. Доступ и безопасность (D8, факты + рекомендации)

**Факты (по коду на 2026-08):**
- **Роли:** две. `admin` (sessions.is_admin=1, adminMiddleware — полный доступ к /api/admin/*) и `client` (authMiddleware + port_name_filter: портал видит только свои portName). Отдельно — публичное API по X-API-Key (per-client ключ, хранится хэшированным, migration 043).
- **Аудит:** `audit_log` пишет действия админов (admin, action, details, timestamp): impersonate (auth.js, с IP), ручные денежные операции — add_payment / manual_charge / delete_payment(→сторно, A4) / balance_adjust / price_change (clients.js, с IP), операции с клиентами/серверами/симулятором. Retention — `retention_audit_log` (90 дн).
- **TTL сессий:** `session_ttl_days = 30` (SETTINGS_DEFAULTS; админских и клиентских одинаковый). Токены хранятся хэшированными (SHA-256), legacy-токены переписываются при первом входе.
- **Экспозиция:** admin.html отдаётся тем же Express-приложением на публичном порту; IP-allowlist нет (есть TRUSTED_PROXY только для корректного client IP).

**Рекомендации (не реализовано):**
- **2FA для админки** (TOTP) — единственная роль с правом ручных денежных операций сейчас защищена только паролем (bcrypt) + 30-дневной сессией.
- **Сократить TTL админ-сессии** (30 дн → 1–7 дн) или разделить TTL admin/client.
- **Ограничить экспозицию admin.html**: IP-allowlist на уровне nginx или вынос админки за VPN/отдельный порт; портал и публичное API оставить открытыми.
- Периодически reviewing audit_log по `impersonate` и ручным денежным action (есть в админке «Журнал действий»).

---

## 5. Интеграции

### 5.1. ProxySmart /apix
Используемые эндпоинты: show_status_json, bandwidth_report_all, list_ports_json, top_hosts (через шим на боксах), speedtest, reset/reboot_modem_by_imei, reboot_server (через панельную сессию — fetchApiPanel), apply_port, get_counters_port, get_rotation_log, unique_ips_json. Кэширование server_cache + поведение при недоступности (cached → offline-аннотация). Контракт (обязательные поля ответов, валидатор, известные пробелы) — docs/PROXYSMART-CONTRACT.md (D7).

### 5.2. Точка Банк (enter.tochka.com, Bearer JWT + CustomerCode)
- **Выписки (statements)**: init → poll до Ready (backoff), окно 14 дней; sync каждые 30 мин + 90 с после старта + дебаунс по вебхуку + вручную. Только Credit-строки.
- **Вебхук** `POST /api/tochka/webhook`: тело = JWT; верификация подписи по JWKS (кэш 15 мин, force-refresh по неизвестному kid). Неверифицированный платёж сохраняется как unmatched + планируется ресинк — «денежное решение» принимает только доверенная выписка. Автозачёт: verified + incomingPayment + матч по ИНН (приоритет) или нормализованному имени (ровно 1 совпадение) → atomicCredit (bank_payment + рефералка 10% в той же транзакции, Р6) → settleBillsOnPayment → TG payment_received. Statement-sync зачисляет так же — с реферальной комиссией 10% (Р22); сторно комиссии — при payment_reversal. Идемпотентность: natural_key с суффиксом `#N` при коллизии разных платежей в день (A3).
- **Bill-settle**: номер счёта в назначении (ё≡е) → точная сумма → жадное покрытие старейших; частичная оплата счёт не закрывает. Страховка — BillStatusSync (ежедневно 05:20 UTC, unpaid→paid по payment-status банка).
- **Документы**: closing-documents и bills — create/delete/get-file (PDF)/send-to-email. Редактирования в API НЕТ (поэтому «правка у нас + перевыставление в банке»).
- Конфиг Точки — kv_store `tochka_config` (D1, 2026-08): каждое непустое поле `enc1:` AES-256-GCM (ключ: TOCHKA_CONFIG_KEY env → /etc/machine-id → legacy hostname). Приоритет источников: env TOCHKA_* > kv > legacy `tochka_config.json` (мигрирует в kv при первом чтении, далее файл read-only deprecated).

### 5.3. Telegram
Long-poll бот (без webhook). Команды: `/start` (первый чат = получатель алертов), `/today`, `/yesterday`, `/status`. Алерты по правилам (см. §8) + дневная сводка в `telegram_summary_time` (финансы/трафик/модемы/AI-insights + блок «лежат >12 ч» (D3), 3 ретрая; маркер `telegram_last_sent_date`). Boot-сообщение через 30 с после старта. Inline-кнопок/действий из TG нет — только исходящее. Отдельно: `logActivity` critical/error по whitelist URGENT_ACTIONS идёт через `alerts.trigger()` (D4) — правила в §8, гейт token/chatId/telegram_summary_enabled сохранён.

### 5.4. CRM
CRM (Twenty) вынесена из админки (2026, ТЗ C2): iframe-вкладка, CRM-синк, напоминания и экспорт удалены; AI-лидген (sales_*) удалён вместе с ней (ТЗ C3).

---

## 6. Карта API (все эндпоинты)

Конвенции: auth = `X-Auth-Token` или httpOnly-cookie `pr_session` (SameSite=Strict), сессии SHA-256-хэшированы. Лимитеры: login 10/15мин, reset-link 10/мин, check_proxy 5/мин, apiV1 120/мин (по ключу), dashboard 60/мин. Все клиентские/внешние обращения пишутся в `api_access_log`. CSP: `script-src-attr 'none'` — все обработчики через `data-on-*` + delegation.js (ограниченная грамматика!).

### 6.1. Системные / auth
`GET /health`, `GET /metrics` (Prometheus); `POST /api/login` (bcrypt), `POST /api/logout`, `POST /api/admin/impersonate/:id` (вход как клиент).

### 6.2. Модемы/прокси/порты (admin)
- Действия: `POST /api/admin/reset_ip`, `/reboot`, `/usb_reset`, `/readd_modem`, `/reboot_server` (пароль админа; через панельную сессию fetchApiPanel), `/reset_complete`, `/reconnect_all`.
- Порты: `POST /api/admin/store_port`, `/move_port` (телепорт на другой IMEI — эталон failover), `/update_port_creds`, `GET /get_port_config`, `POST /save_port_config`, `/apply_port`, `/purge_port`, `/bulk_os_spoof`, `/bulk_rotation`, `GET /free_ports`.
- Модемы: `POST /api/admin/store_modem`, `/apply_modem`, `/assign_modem`, `GET /available_modems`, `/modem_status`, `/rotation_log`, `/ip_history`; `DELETE /api/admin/modems/:srv/:port_id` (soft-delete, только offline), `POST .../restore` (мгновенное восстановление).
- Спидтест: `POST /api/admin/speedtest/start`, `GET /status`, `/speedtest`, `/speedtest_history`.
- SMS/USSD: `GET /api/admin/sms`, `POST /send_sms`, `/send_ussd`, `/purge_sms`; `GET /api/admin/vpn_profile`.

### 6.3. Клиенты (admin)
CRUD: `GET/POST /api/admin/clients`, `PUT/DELETE /api/admin/clients/:id` (delete откажет при живых портах). Деньги: `POST /payment` (atomicCredit + settleBills + рефералка), `/charge`, `/balance_adjust`, `GET /payments`, `GET /ledger`, `DELETE /payment/by-ledger/:id` (сторнирование платежа: payment_reversal + откат рефералки, идемпотентно). `DELETE /ledger/:entryIndex` — ЗАПРЕЩЁН (405): правки только через сторнирование (A4). Документы: `POST/DELETE /document`. `POST /regenerate_key`.

### 6.4. Биллинг/финансы (admin)
`POST /api/admin/run_billing` (sync опция), `POST /billing_rerun` (пересчёт за дату из durable, dry_run); `GET/POST /api/admin/monthly_costs`; `GET /api/admin/finance_dashboard` (выручка 30д факт + run-rate прогноз EOM, ARR/churn/ARPU/NRR/концентрация/utilization/RPM/затраты/тренд 12 мес/выручка по дням/платежи — формулы §2.6); `GET /api/admin/billing/reconciliation`.

### 6.5. Банк (Точка)
Конфиг: `POST/GET /api/admin/tochka/config`, `/autodetect`, `/register_webhook`, `/sync` (ручная сверка выписки), `GET /payments`, `/match_payment`, `/dismiss_payment`, `/dismiss_unmatched`. Акты: `POST /create_act` (409 — акт за период уже есть, B2), `GET /all_acts`, `POST /generate_acts`, per-client `GET/PUT /closing_documents/:docId` (PUT — правка позиций), `GET pdf|print`, `POST closing_document_status`, `DELETE closing_document/:docId` (удаляет и в банке). Счета: `POST /create_bill` (409 — счёт за период уже есть, B2), `/generate_bills`, `GET /all_bills` (с formulaText), `GET pdf|print`, `POST bill_status`, `DELETE /bill/:billId`.

### 6.6. Аналитика (admin)
`/api/analytics/monthly_traffic`, `/heatmap`, `/modem_heatmap`, `/rotations`, `/ip_stats`, `/traffic_forecast`, `/capacity`, `/latency_stats`, `/logs_domains_full`, `/modem_health`, `/modem_health_history`; `/api/admin/daily_traffic`, `/backfill_daily_traffic`, `/bandwidth_single|period`, `/reset_bandwidth`, `/unique_ips`, `/proxy_checks`, `POST /proxy_check`, `/top_hosts`, `/domain_guard` (+`/run`).

### 6.7. Система/настройки (admin)
`GET /api/admin/data` (главный агрегат: fleet+clients+traffic+finance, посекционная деградация), `/health` (+реестр джобов), `/jobs/:id`, `/system_health`, `/system_log`, `/audit_log`, `/db_audit`, `/api_usage`, `/api_access_log`, `/auto_reboot_log`, `/backup`, `POST /restart_dashboard`, `/cache/invalidate`. Серверы: `GET/POST/PATCH/DELETE /api/admin/servers[/:name]`, `/server_stats`. Настройки: `GET/PUT /api/admin/settings` (маскировка секретов; тумблеры alert_*). Алерты: `GET /api/admin/alerts`, `PUT /alerts/:id`, `POST /alerts/:id/test`. Уведомления: `GET /api/admin/notifications`, `/badge`, `/:id/read`, `/dismiss`, `/read-all`, `/dismiss-read-older`. Failover: `/failover/log|spares|candidates`, `POST /execute`. TG: `/telegram/preview`, `/telegram/send_test`. Симулятор: `simulator/*` (pool, profiles, run/abort, runs, compare, stream…).

### 6.8. Клиентский портал
`GET /api/dashboard_data`, `GET /api/billing_history`, `POST /api/client/reset_ip` (свой модем), `GET|POST /api/client/reset_ip_by_token` (секретная ссылка), `/rotation_log`, `/set_rotation`, `/ip_history`, `/credentials_export`, `/reset_link/rotate`, `/referral`, документы: `/documents`, `/closing_documents` (+pdf), `/bills` (+pdf), `/daily_traffic`.

### 6.9. Публичное API и вебхуки
`GET /api/v1/proxy` (креды+change_ip_url+billing-сводка), `GET /api/v1/proxies` (JSON/TXT/CSV). Вебхук: `POST /api/tochka/webhook` — JWT-верификация по JWKS (невериф. → unverified/400 при strict), идемпотентность по natural_key/paymentId, автозачёт только verified+matched по ИНН, иначе дебаунс-ресинк выписки. `POST /api/tools/check_proxy` — чекер (admin+client).

---

## 7. Периодические джобы (src/boot/startup.js)

### Суточные (UTC; МСК = +3)
| Время | Джоба | Что делает |
|---|---|---|
| 00:30 | DbCleanup | retention-чистка таблиц + prune in-memory карт |
| 00:45/07:00/15:00 | DailySync | вчерашние счётчики боксов → daily_traffic (MAX) |
| 01:00 | DailyBilling | ежедневные списания (см. §2.3) + пост-биллинговый автоблок должников-физиков (§2.9) |
| 01:10 | ShadowBilling | теневой тест тарификации: сравнение V1/V2 → billing_shadow_log, без списаний (Фаза 0) |
| 02:00 | DbBackup | SQLite online backup, верификация, ротация 7 daily + 12 monthly (D2), затем offsite-выгрузка rclone (scripts/backup-offsite.sh, best-effort + warn) |
| 02:30 | HistoryPrune | rotation_log/system_log/proxy_checks >60д |
| 03:00 | TopHosts | сбор top_hosts по всем портам → top_hosts_detail |
| 03:25 | DomainGuard | контроль бан-листа доменов (config/blocked-domains.json) по дельтам |
| 03:30 | MonthlyReconciliation | 1-го числа: stored vs billed, добивка корректировкой |
| 04:00 | BalanceReconcile | баланс vs ledger, новые разрывы → critical+TG |
| 05:05 | MonthlyActs | авто-акты в день взаиморасчётов клиента |
| 05:10 | MonthlyBills | авто-счета (формула §2.4) |
| 05:20 | BillStatusSync | payment-status неоплаченных счетов → paid |
| 06:00 | ShadowBillingWeekly | понедельник: итог теневого теста за 7 дней → TG |
| 06:30 | ProxyExpiryCheck | прокси истекают <3 дн → алерт админу; клиентский контур — expiresAt/баннер в портале (§2.9) |
| 11:00/23:00 | Speedtest | по расписанию `speedtest_times` (задаётся в МСК, дефолт 02:00/14:00 МСК), re-test при <1 Мбит/с |
| 20:55 | HealthSnapshot | дневной скор здоровья модемов → modem_health_daily |

### Интервальные
- **trackModems** (~3 мин): фетч боксов, server down/recovered, meta-upsert, IP-трекинг, uptime-бакеты, авто-recovery, offline-алерты (порог `modem_offline_threshold_min`), сводка mass-down, prune.
- **HourlyAgg** (каждый час :00, 5 попыток): дельты → traffic_hourly; детект ресета счётчиков; spike-clamp (3×/1.5× от 24ч-среднего, floor 500 МБ); сглаживание uncertain медианой.
- **NotifyCollect** (2 мин): bell по fleet.disconnectedList (per-day дедуп), SIM-сигналы, долги, TTL-чистка.
- **ProxyCheck** (60 мин): curl-замеры проданных неистёкших портов → proxy_checks.
- **AutoCreate** (10 мин): новый portName → авто-клиент (per_gb, цена по сетке).
- **AutoReboot** (15 мин, выкл по дефолту): ребут проблемных по computeProxyIssues с троттлом.
- **TochkaSync** (30 мин + дебаунс от webhook): выписка 14 дней, идемпотентный зачёт, bill-settle.
- **Failover scan** (3 мин): кандидаты → teleport на спейр (гейты/кулдауны/рейт-лимит).
- **StalePortsHourly** (60 мин): чистка портов, отсутствующих >3 дней из daily_traffic; IMEI-dedupe per-server.
- **Watchdogs** (5 мин/60 мин): heap/диск/cron_stuck (джобы молчат >2× интервала).
- **ConnsHist** (60 с): TCP-коннекты по модемам (in-memory, 65 мин).
- **TG summary-loop** (60 с): дневная сводка по расписанию.
- **Billing catch-up** при старте (snapshot >26ч → немедленный биллинг).

---

## 8. Правила алертов (src/telegram/alerts.js)

Каждое правило: вкл/выкл (`alert_<id>_enabled`), канал TG+колокольчик или только колокольчик, кулдаун per dedupeKey (персист в kv, TTL 7д), boot-grace 5 мин, каждый триггер пишется в notifications.

**D4 (2026-08):** бывший URGENT_ACTIONS-контур logActivity консолидирован в этот движок. logActivity больше не шлёт TG сам — вызывает `alerts.trigger()` синхронно (немедленность critical сохранена). Кулдауны прежние: 15 мин (cooldownSec 900) на (rule, target); гейт `telegram_summary_enabled` остался на стороне logActivity. Правила контура: billing_failed, billing_unique_conflict, tochka_sync_failed, tochka_unverified_webhook, uncaught_exception, unhandled_rejection, telegram_summary_failed + generic-фолбэк system_critical (любое critical-событие system_log). server_unreachable и db_backup_failed маршрутизируются в свои давние правила. **Долговые сигналы — общий dedupeKey-family `debt_<client_id>_<signal>`**: client_charge_failed (`…_charge_failed`), client_balance_negative (`…_balance_negative`), client_debt (`…_debt`, bell-only), client_blocked_debt / client_unblocked_debt / client_block_warning; частоты не изменились.

**D3 (2026-08):** дневная TG-сводка содержит строку «Лежат >12 ч: N модемов (список, топ-10 + …и ещё N)» — источник тот же fleet.disconnectedList, что у колокольчика (notify-collect); закрывает дыру «TG-алерт оффлайна глушится после stale_modem_hours».

**D7 (2026-08):** proxysmart_contract_mismatch — бокс отвечает не по контракту (shape-валидация /apix/* в цикле опроса, docs/PROXYSMART-CONTRACT.md), cooldown сутки на бокс.

**🔴 critical:** server_unreachable (≥10 мин), modems_down_bulk (≥порога), tochka_webhook_failed, db_backup_failed, balance_drift, duplicate_credit_blocked, client_charge_failed (maxDebt), client_blocked_debt (автоблок по долгу, §2.9), failover_no_spare, failover_failed, domain_guard_hit, domain_guard_failed, heap_high, disk_low_critical, proxysmart_contract_mismatch + URGENT-контур (D4 выше).
**🟡 important:** modem_offline_20m (порог настраиваемый, парность), modem_recovered, recovery_exhausted, failover_done, sim_redirect_imposed, sim_iccid_changed, sim_status_bad, reboot_score_high (≥70), payment_received, client_balance_negative, client_block_warning (прогноз блокировки ≤3 дн, §2.9), client_unblocked_debt (восстановление после оплаты, §2.9), pricing_tier_miss (промах сетки цен, §2.10), proxy_expiring_3d, traffic_spike_burst, dashboard_restarted.
**🔵 early:** heap_warn, disk_low_warn, cron_stuck.
**🔔 bell-only:** modem_offline, client_debt.

---

## 9. Известные исторические ловушки (важно при рефакторинге)

1. Счётчики ProxySmart обнуляются при рестарте бокса → биллинг по max(durable, live).
2. «91/90», «31 vs 32»: счётчики по разным источникам → единый fleet-слой; total стабилен, working живой.
3. Клонированные IMEI у E3372 на разных стиках → никаких глобальных дедупов по imei.
4. Пауза ≠ удаление: paused исключён из текущих метрик, но не из истории.
5. Точка не редактирует документы → правка у нас + перевыставление в банке.
6. inline-обработчики запрещены CSP (`script-src-attr 'none'`) — только data-on-* + delegation.js; грамматика ограничена (см. баг m[1]/m[2] 2026-08-02).
7. pmacct ≠ наш учёт на 5–7% (сетевой уровень vs payload) — оператор считает как pmacct.

---

## 10. Замеченные несостыковки (к рефакторингу)

1. ~~`trackModems`: дефолт `tracking_interval_min=3`, а лог/комментарии пишут «every 5 min»~~ — закрыто (C8, 2026-08): комментарии в server.js и startup.js синхронизированы с `tracking_interval_min` (дефолт 3).
2. `payments` — мёртвая таблица (read-only legacy). C5a закрыт: все читатели (портал, публичное API, бут) читают billing_ledger, in-memory `client.payments[]` и роут `DELETE /payment/:index` выпилены, `src/db/payments.js` удалён. Осталось C5b: сверка `scripts/reconcile-payments.js` на проде → ручной дроп `migrations/manual/056_drop_payments.sql`.
3. ~~`daily_summary` читает system_log с несуществующей колонкой `source` — деградирует молча в try/catch~~ — закрыто (C7, 2026-08): запрос переписан под реальные колонки (timestamp/action/target), молчаливые catch переведены на warn; покрыто tests/daily-summary.test.js.
4. `tochkaRequest` имеет две сигнатуры (config-first в api.js и method-first через обёртку в server.js) — **унифицировать при выносе** в общий модуль (кода не касались, C8).
5. `bills` пишутся двумя путями (saveClients-upsert + updateBillStatus) — **хрупкое место, кандидат на унификацию** в один путь записи (зафиксировано, кода не касались, C8).
7. ~~Джобы вне scheduler-реестра (notify-collect, failover, conns-history) не видны в `/api/admin/health.jobs`~~ — закрыто (C8, 2026-08): все три зарегистрированы через `scheduler.wrapJob` (NotifyCollect 2 мин, Failover 3 мин, ConnsHist 1 мин), поведение/частота не менялись; crm-sync выпилен ранее.
8. ~~Скрытые вкладки `#tab-traffic` и `#tab-ai_sales`~~ — выпилены (2026, ТЗ C4) вместе с эксклюзивными роутами (`/api/analytics/latency_day`, `/api/admin/top_hosts_aggregated|_refresh`).
9. ~~`speedtest_history.json`, `server_cache.json`, `tochka_config.json` — файловые хранилища вне БД и вне бэкапов~~ — частично закрыто (D1/D2, 2026-08): `tochka_config` перенесён в kv_store (попадает в бэкап БД); бэкапы покрыты ротацией 7 daily + 12 monthly + offsite rclone + pre-deploy снапшотами. Остаются `speedtest_history.json` и `server_cache.json` вне БД/бэкапов (оба — восстановимые кэши, потеря не критична).
10. Миграции 040 не существует — дыра в нумерации (не ошибка).

## 11. Процессы разработки

- Репозиторий: GitHub ArtiomV/Proxy-Dashboard (main). Деплой: `scripts/deploy.sh` (rsync + npm ci + pm2; **pre-deploy снапшот БД** перед rsync, ротация 5 — D2) → `pm2 restart dashboard --update-env` → проверка `/health`; бэкап кода tar перед каждым деплоем (/root/backups).
- **DR:** восстановление на чистой машине — **docs/DR-RUNBOOK.md** (D6); бэкапы — 7 daily + 12 monthly локально + offsite в облако через rclone (D2, настройка — OPERATIONS.md «Настройка rclone»). Целевой RPO при облачной копии — 6 ч (текущий 24 ч).
- Модель данных: глоссарий идентификаторов, ER, матрица источников трафика, инвариант «портал == акт» — **docs/DATA-MODEL.md** (D9). Контракт боксов — **docs/PROXYSMART-CONTRACT.md** (D7).
- Тесты: vitest (374+ тестов; контракты API через снапшоты routes.json/schema.json — обновлять UPDATE_SNAPSHOT=1 при осознанных изменениях). Линт ESLint (warnings допустимы, errors — нет).
- CI: GitHub Actions (тесты + линт).
- Изменения БД — только через migrations/0NN_*.sql (раннер при старте); schema-эквивалентность залочена тестом.
