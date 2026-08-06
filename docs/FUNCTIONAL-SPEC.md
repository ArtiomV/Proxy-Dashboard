# Proxy Dashboard — полная функциональная спецификация

> Назначение документа: единый источник правды о функционале и логиках системы для рефакторинга и исправления логик. Описывает ЧТО система делает, КАК и ПОЧЕМУ (включая исторические причины решений). По состоянию на 2026-08-04.

Система: оператор мобильных прокси. 4 сервера ProxySmart (S1 Молдова, S2 Румыния, S3/S4 Молдова), каждый с фермой USB-модемов; прокси-порты привязываются к клиентам (portName). Дашборд (Node.js/Express + SQLite) — центр управления: мониторинг флота, клиенты, биллинг, банк (Точка), алерты (Telegram), CRM.

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
└────────────────────────┘                                   ▼
┌────────────────────────┐                        Админка (admin.html)
│ CRM (Postgres, внешняя)│◄── напоминания/сделки ─  Клиентский портал (index.html)
└────────────────────────┘                        Публичное API (X-API-Key)
```

Основные процессы: единый Node-процесс (`server.js` + `src/`), периодические джобы из `src/boot/startup.js`, БД SQLite (WAL), деплой — rsync из git-worktree + `pm2 restart dashboard --update-env`.

---

## 1. Модель данных (SQLite dashboard.db, WAL; schema.sql + migrations/001–053)

### 1.1. Клиенты и деньги
- **clients** — один клиент = один `port_name` (биндинг портов в ProxySmart). Поля: login (UNIQUE), password_hash (bcrypt), billing_type (`per_gb`/`per_modem`), price, balance (владеет только atomicCredit/atomicDebit — в saveClients-upsert НЕ входит), billing_paused, client_type (`individual`/`legal`; при создании по умолчанию `individual`, автосоздание из банка — `legal`), auto_acts/auto_bills, inn/kpp/legal_name/contract_info/contract_date (день взаиморасчётов — день выставления актов/счетов, 1..28), sla_* (uptime/latency/error/auto_credit), allow_debt/max_debt, api_key/reset_token (SHA-256 at rest), referral_*. Авто-создание под новые portName — каждые 10 мин (цена по pricing_tiers).
- **billing_ledger** — ЕДИНСТВЕННЫЙ источник правды по деньгам. type: charge/correction/manual_charge/payment/bank_payment/manual_credit/adjustment/payment_reversal. amount, gb_used, date (МСК), balance_before/after (цепочка — основа сверки), source, details(JSON). Идемпотентность: частичный UNIQUE (client_id,date,type) — дабл-списание отклоняется. Пишется ТОЛЬКО через atomicCredit/atomicDebit (транзакция с clients.balance + реферальная комиссия 15% внутри). Аудируется триггерами (db_audit). Канон баланса — ledgerFinalBalance (последний balance_after + типизированный хвост), НЕ реплей суммы. Все метрики — через `ledgerExpense()`/`computeRevenueWindow`.
- **bills** — счета: amount, status (unpaid/paid/replaced), bill_number, tochka_bill_id, formula (JSON-разбор расчёта; при ручной правке — edited_from).
- **closing_documents** — акты: items (JSON позиций), total_amount, status (unsigned/signed), tochka_doc_id, act_number. Позиции правятся из админки; в банке — только delete+create.
- **bank_payments** — входящие платежи Точки: payment_id/tochka_payment_id (UNIQUE), natural_key = ИНН|сумма|дата|назначение-prefix (главный анти-дабл гейт вебхук↔синк), matched_*, dismissed, source.
- **payments** — legacy read-only (новые платежи не пишутся).

### 1.2. Модемы и ростер
- **modem_meta** — авторитетная мета модема (UNIQUE server_name+imei): nick, operator/model/phone/iccid, sim_status, reboot_score, http_redirect, band, signal, deleted. Upsert «preserve-on-empty». Soft-delete (скрытие) + auto-restore (3 подряд онлайн-опроса).
- **known_modems** — реестр реквизитов: PK (server_name, port_key), data JSON {portName, imei, nick, model, portInfo, lastSeen, lastClientSeen, _missingSince}. Липкий; реконсиляция 7 дней; move-dedupe per (server,imei,portName).
- **uptime_tracking / uptime_daily** — total/online checks, last_online_check, offline_alerted (парность алертов «отключился/вернулся»).
- **ip_tracking / ip_history** — текущий IP + история смен (100 записей/ключ, интервалы from/to) — «Завис IP».
- **rotation_log** — ротации (UNIQUE server+nick+started_at, caller/target_mode).
- **proxy_checks** — curl-замеры (connect/total ms, status, error): health/SLA/latency.
- **modem_health_daily**, **server_downtime**, **failover_log**, **auto_reboot_log**, **operator_country_map** (auto+manual).

### 1.3. Трафик
- **traffic_hourly** — почасовой durable-учёт: UNIQUE(port_id, hour_start), bytes_in/out, uncertain (0=ок, 1=gap-fill, 2=расхождение счётчиков, 3=сглажено медианой), client_name/operator/nick заморожены при записи. Основа биллинга.
- **hourly_snapshots** — базлайны счётчиков для дельт (внутреннее).
- **daily_traffic** — суточный канон: UNIQUE(port_name, date), MAX-семантика (байты не убывают), client_name при записи.
- **traffic_recon** — сверка с pmacct (ps_* vs our_*, diff_pct; UNIQUE port_key+date). Систематика +5–7% у pmacct (сетевой уровень vs прокси-payload).
- **top_hosts_detail / top_hosts_daily / domain_guard_hits** — доменный контроль.

### 1.4. Состояние/журналы
- **kv_store** (+kv_store_history 50 версий): app_settings (секреты enc1: AES-GCM), api_servers, кэши, маркеры джоб, baseline'ы. kvSetCritical — shape-guard против «усыхания» значения.
- **sessions** — SHA-256 токены, TTL 30д. **notifications**(+read_state) — колокольчик (TTL 30д).
- **audit_log / system_log / db_audit(+context)** — аудит действий, события автоматики (critical/error сразу в TG), триггерный аудит денежных таблиц.
- **api_usage / api_access_log** — телеметрия API.
- **monthly_costs** — расходы per (period, category, subkey=сервер/оператор).
- **sla_violations**, **external_proxies**, **simulator_***, **sales_*** (AI-лидген), **client_documents**, **_migrations**.
- Файловые хранилища вне БД (и вне бэкапов!): speedtest_history.json, server_cache.json, tochka_config.json (AES-GCM).

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

### 2.3. Биллинг (src/jobs/billing.js, ежедневно 01:00 MSK + ретраи)
- Списание = max(durable traffic_hourly, live ProxySmart counters) за вчера (MSK). Durable выигрывает при рестартах бокса (счётчики обнуляются).
- Пауза (`billing_paused=1`) → джоба пропускает клиента («Skipping … billing paused»), деньги не уходят; клиент исключён из всех текущих финстатистик (MRR, revenue_30d, per-tariff, daily revenue, forecast), но история остаётся фактической.
- Долговая политика: allow_debt/max_debt, алерты «списание не прошло», пауза обслуживания.
- Идемпотентность: одна запись на клиент-день; ретраи через billing_retry_delay_hours.

### 2.4. Счёт на оплату (formula per_gb)
`сумма = max(списания прошлого месяца, среднесуточное за последние 7 дней × дней в месяце × тариф) + долг`, округление вверх до 10 000 ₽. Разбор хранится в bills.formula и показывается на странице актов/счетов. per_modem: price × живые модемы.
- Выставление: в день расчёта клиента (contractDate day, дефолт 1), autoBills.
- Правка суммы вручную сохраняет formula.edited_from.

### 2.5. Акты
- Позиции из ledger: per_gb → одна строка «трафик за <месяц>» (qty=ГБ, price=средний); per_modem → строка на каждую группу «N модемов × D дней»; корректировки → отдельная строка «Корректировка (доначисление/возврат)».
- Негативные позиции фолдятся (sanitizeActPositionsForTochka — Точка отвергает отрицательные).
- Редактирование позиций в админке (PUT closing_documents/:docId) — наша история верна; «↻ В Точку с правками» — удалить в банке + создать заново с правками (API Точки не редактирует документы).

### 2.6. MRR и прогноз
- MRR = выручка за скользящие 30 дн. (charge+correction через ledgerExpense, paused исключены).
- Прогноз EOM = Σ по клиентам: per_gb — среднесуточное за 7 дней × дней × тариф; per_modem — price × живые модемы; paused исключены. Отображается полупрозрачным столбцом в MRR-тренде; формула — за кнопкой «Формула».

### 2.7. Алерты
- Оффлайн-модем: TG-алерт в окне [threshold; 12ч) тишины; парность «отключился/вернулся» через offline_alerted; сводный «🚨 Не работает модемов: N» (modems_down_bulk) — порог настраивается, soft-deleted не попадают (janitor _downSince).
- Колокольчик = ровно fleet.disconnectedList (per-day dedup).
- Серверные: server_unreachable (≥10 мин), дневная сводка, долги, CRM-напоминания, сверка трафика (порог %).

### 2.8. Recovery / failover
- Auto-recovery: ребут модема → Re-Add → сдача (recovery_exhausted) с дневными капами.
- Failover: переназначение клиентских модемов на запасные при смерти/глючности (dry-run режим по умолчанию).

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
 ├─ DailyBilling (01:00) ─ max(durable, live) → atomicDebit → billing_ledger ─► MRR/акты/счета
 ├─ conns-history (1 мин), notify-collect (2 мин → колокольчик), proxy-checks (60 мин), failover (3 мин)
 └─ Роуты: /api/admin/data (главный агрегат админки), /api/dashboard_data (портал), /api/v1/proxy(s) (X-API-Key)
```

### 3.2. Деньги и банк
```
billing_ledger ◄─ atomicCredit/Debit (единственные писатели; транзакция с clients.balance)
   ▲   │  ▲
   │   │  └─ DailyBilling / billing_rerun / monthly-reconciliation / SLA-кредиты / ручные операции
   │   └─► computeRevenueWindow → revenue_30d/MRR (одно число везде) → finance_dashboard → Дашборд/Клиенты
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
TrafficRecon (03:40) → traffic_recon (наш учёт vs pmacct) → расхождения ≥10% → алерт + страница сверки
cleanup (00:30 + hourly): retention; Pass A — dedupe per (server,imei); мёртвые модемы НЕ вытесняются
```

### 3.4. kv_store — ключи и владельцы
`app_settings` (все настройки; секреты enc1:), `api_servers` (боксы+метаданные; boot-мерж с env), `top_hosts_cache`, `rotation_cache`, `hourly_last_recorded`, `last_reconciliation_month`, `reconcile_known_breaks`, `traffic_recon_status`, `telegram_alert_cooldowns`, `telegram_last_sent_date`, `integrity_baseline_*`.

### 3.5. In-memory состояние (src/state + server.js)
Стабильные ссылки (mutate-in-place): clients[]+мапы (ById/ByLogin/ByApiKey/ByInn/ByResetToken), dailyTraffic, ipTracking, uptimeTracking, ipHistory, appSettings, knownModems, tochkaConfig, portKeyToPortName. Прочее: apiServers, users, modemRotationCache, autoRecovery, _serverDownSince, offlineAlertSent, _downSince, _deletedModemSet (+_deletedOnlineStreak), _panelSessions, snapCache (hourly), connsHistory (65 мин, 1-мин сэмплы), _psCache. Мьютекс withClientsLock сериализует billing против saveClients.

---

## 4. Интерфейсы

### 4.1. Админка (public/admin.html + public/js/admin*.js)

**Навигация** (`switchMainTab`, активная вкладка в localStorage): Дашборд / Модемы / Клиенты / Финансы / CRM / Настройки. Шапка: бейдж «В работе: N/M» (fleet), время обновления, колокольчик уведомлений (фильтры, переходы к сущностям; источник `GET /api/admin/notifications`), автообновление ~10 с. Баннер «сервер недоступен — данные из кеша» на всех вкладках.

#### Дашборд («Командный центр»)
- **Пульс бизнеса**: Трафик сегодня (парк), Активные модемы working/total, Выручка за 30 дней (+Δ М/М), На балансах (Σ положительных балансов).
- **Требует внимания** (4 карточки): «Проблемы инфраструктуры» (плитки Модем отключен / Низкая скорость / Завис IP / Сбоит прокси — клик открывает попап со списком); «Потребление трафика» (тренд 6 мес); «MRR» (стек-бар «За ГБ»/«За модем» + прогноз месяца полупрозрачным столбцом, поповер «Формула»); «Операторы» (трафик/модем/сут, ₽/ГБ себестоимость).
- **Парк по серверам**: «Весь парк» + карточка на сервер (working/total, отключено, трафик сегодня/месяц, сигнал, проблемные).
- **Финансы**: «Выручка по дням» (стек по клиентам, 30 дн) + «Последние пополнения» (5, с разделителями); «Качество выручки» — плитки в порядке: Выручка 30д → Расходы (мес.) → Прибыль 30д → Маржинальность → NRR 3мес → Churn → ARPU → Активных клиентов + кнопка **«⚙ Затраты»** (редактор себестоимости) + бары концентрации Top-1/3/5.
- **Клиенты**: таблица Клиент/Live/Сегодня/Тариф/MRR/Δ M/M/% MRR/Баланс.
- **Инфраструктура** (раскрывашки): Топ проблемных модемов (ребут/Re-Add), Ротации·IP·ёмкость (периоды 1–30 дн, успешность %, уникальных IP, подсетей/модем), Распределение задержек (P50/P95/ошибки), Сверка биллинга (расхождения ГБ, «не выставлен счёт», «счёт без трафика»).
- **Трафик**: почасовая тепловая карта (страны/операторы/клиенты, GMT+3), потребление 60 дней (стек по клиентам/странам), топ доменов, матрица трафика, обращения к API (кто/тип/цель/статус/мс/IP).

#### Модемы
- Чипы-фильтры: Все/Онлайн/Проблемы/SIM/Офлайн/Свободные; селекты сервера (группы по странам) и клиента; виды Таблица/Сетка. Тест-пул 🧪 из счётчиков исключён.
- Таблица: rail причины, статус-пилюля (+«блип»), флаги 🧪⛔📴♻🔒🌐⚠, чипы исключения «Не в стат.»/«Без клиента», портName-бейджи, креды (копия), IP, трафик, скорость, аптайм, латентность (инлайн-лог проверок по клику), TCP-коннекты со спарклайном 60 мин, ошибки %, здоровье, ротация. По серверу: «↻ Сброс IP», «⏻ Ребут» (пароль).
- Bulk: сброс IP, ребут, OS-spoof, ротация, экспорт (формат/фильтры/скачать), proxy-check, удаление.
- Карточка модема: Обзор (баннер состояния, действия Сброс IP/Ребут/Re-Add/Доступ, KPI, Сеть и сигнал, Подключение — по каждому порту своя «📋 строка» креда, Трафик, тоггл тест-пула), Здоровье (скор /100, таймлайн 30 дн, разложение по факторам, формула), Трафик (heatmap + топ доменов модема), История (ротации IP, спидтесты + запуск), Настройки (идентификация, сеть/ротация, порты: перенос/редактирование/удаление/добавление). SMS/USSD, VPN-профиль.

#### Клиенты
- Фильтры: Все/Активные/Должники/Истекают (баланс < 5 дней расхода). Карточка: статус ДОЛЖНИК/ПАУЗА/НЕТ МОДЕМОВ/АКТИВЕН, баланс, тариф, расход/трафик в мес, модемов working/total. Вход как клиент (impersonate). Привязка/отвязка модемов.
- Карточка клиента: Обзор, Тариф и баланс (доступ, банковские реквизиты, авто-акты/счета, пауза биллинга, минус/макс-долг, SLA, API-ключ), Модемы, Платежи (пополнить/списать, ledger по месяцам/кварталам с удалением записей).
- **Документы**: Акты — создать за период, редактор позиций ✏️ (название/кол-во/ед.-выпадающий список/цена; «💾 Сохранить» локально, «↻ В Точку с правками» — удалить в банке + создать с правками), PDF/печать/статус/перевыставить/удалить. Счета — выставить (сумма авто по формуле или вручную), ✏️ сумма, ↻ перевыставить с новой суммой, PDF, статус, удалить. Расшифровка формулы счёта в списке (per-GB). Файлы — загрузка/скачивание.

#### Финансы (вкладка)
Сайдбар: Акты (массовая генерация за месяц, аккордеон по месяцам, действия ✏️/📥/✅/↻/🗑), Счета (аналогично + формула), Платежи (неопознанные — привязка к клиенту вручную, последние платежи). Редактор затрат (по серверам ₽, SIM ₽/мес по операторам, прочее; шаблон из прошлого месяца). Сверка трафика (наш учёт vs pmacct, расхождения ≥10%). Настройка Точки (JWT/Customer Code/Account ID, webhook, синхронизация платежей).

#### CRM
iframe Twenty CRM с автологином; экспорт CSV (люди/компании/сделки).

#### Настройки
Мониторинг (здоровье сервера, системный лог, журнал действий); Инфраструктура (серверы — карточки с кредами, операторы→страны); Автоматика (правила уведомлений с каналами/кулдаунами/тестом, порог массового падения `modems_down_threshold`, failover — тогглы/пороги/кандидаты/ручной перенос/история, восстановление, проверка прокси); Инструменты (банк-конфиг, симулятор нагрузки с профилями/SSE-стримом, тест-пул); Данные (Telegram-уведомления и сводка, спидтесты/пороги, `stale_modem_hours`, `modem_offline_threshold_min`, трекинг, хранение, сессии/биллинг/CRM, тарифная сетка pricing_tiers).

### 4.2. Клиентский портал (public/index.html + client.js)
- Логин (поддержка impersonate админом), тёмная тема.
- **Панель**: активных портов (по странам), трафик сегодня/за месяц (**биллинговый объём = совпадает с актом**), баланс, аптайм 30д; таблица модемов (статус, реквизиты ip:port + копия, логин:пароль, смена IP по ссылке/кнопке, история IP, выбор ротации, трафик ↓/↑); экспорт прокси (TXT/JSON/CSV, cURL/Python/.env, PAC/FoxyProxy, свой шаблон; фильтры).
- **Аналитика**: трафик за период, прогноз до конца месяца (объём ÷ дней × дней в мес.), топ-день, среднесуточное, посл. час; чарты по локациям/модемам, периоды/диапазоны.
- **История баланса**: баланс, расход за месяц, средний расход/день, дней до нуля; по месяцам (трафик/списано/оплачено, фильтры типов).
- **Документы**: акты (PDF, бейдж неподписанных), счета (PDF, неоплаченные), файлы.
- **API**: документация по X-API-Key, GET /api/v1/proxy, смена IP, коды ошибок.
- **Партнёрская программа**: 10% от платежей привлечённых.

### 4.3. Публичное API (X-API-Key)
`GET /api/v1/proxy` — список прокси клиента (креды, состояние); смена IP по secure-ссылке; тарификация обращений (api_usage, api_access_log — видно в админке «Обращения к API»).

---

## 5. Интеграции

### 5.1. ProxySmart /apix
Используемые эндпоинты: show_status_json, bandwidth_report_all, list_ports_json, top_hosts (через шим на боксах), speedtest, reset/reboot_modem_by_imei, reboot_server (через панельную сессию — fetchApiPanel), apply_port, get_counters_port, get_rotation_log, unique_ips_json. Кэширование server_cache + поведение при недоступности (cached → offline-аннотация).

### 5.2. Точка Банк (enter.tochka.com, Bearer JWT + CustomerCode)
- **Выписки (statements)**: init → poll до Ready (backoff), окно 14 дней; sync каждые 30 мин + 90 с после старта + дебаунс по вебхуку + вручную. Только Credit-строки.
- **Вебхук** `POST /api/tochka/webhook`: тело = JWT; верификация подписи по JWKS (кэш 15 мин, force-refresh по неизвестному kid). Неверифицированный платёж сохраняется как unmatched + планируется ресинк — «денежное решение» принимает только доверенная выписка. Автозачёт: verified + incomingPayment + матч по ИНН (приоритет) или нормализованному имени (ровно 1 совпадение) → atomicCredit (bank_payment + рефералка 15% в той же транзакции) → settleBillsOnPayment → TG payment_received.
- **Bill-settle**: номер счёта в назначении (ё≡е) → точная сумма → жадное покрытие старейших; частичная оплата счёт не закрывает. Страховка — BillStatusSync (ежедневно 05:20 UTC, unpaid→paid по payment-status банка).
- **Документы**: closing-documents и bills — create/delete/get-file (PDF)/send-to-email. Редактирования в API НЕТ (поэтому «правка у нас + перевыставление в банке»).
- Конфиг `tochka_config.json` — AES-256-GCM (ключ: TOCHKA_CONFIG_KEY env → /etc/machine-id → legacy hostname), env-оверрайды TOCHKA_*.

### 5.3. Telegram
Long-poll бот (без webhook). Команды: `/start` (первый чат = получатель алертов), `/today`, `/yesterday`, `/status`. Алерты по правилам (см. §8) + дневная сводка в `telegram_summary_time` (финансы/трафик/модемы/AI-insights, 3 ретрая; маркер `telegram_last_sent_date`). Boot-сообщение через 30 с после старта. Inline-кнопок/действий из TG нет — только исходящее. Отдельно: `logActivity` critical/error по whitelist URGENT_ACTIONS шлёт немедленный TG (кулдаун 15 мин).

### 5.4. CRM (внешняя Twenty, Postgres)
- Доступ — напрямую в Postgres (`CRM_DB_URL`, workspace `CRM_WORKSPACE`); self-heal URL через docker inspect при ECONNREFUSED. Модуль pg опционален (нет — silent no-op).
- Синк каждые `crm_check_interval_min` (10 мин): paymentConfirmed=true → lastPaymentDate=now, nextPaymentDate=+1 мес, флаг снимается (пишет в CRM).
- Напоминания (`reminderDate` ≤ now) → колокольчик (`crm_reminder`, per-day дедуп) + блок в админке.
- В админке — iframe с автологином (GraphQL `getLoginTokenFromCredentials` → `/api/admin/crm_token`), экспорт CSV (`/api/admin/crm/export`: компании/люди/сделки, BOM, «;»).
- AI-лидген (скрытая вкладка): Anthropic + Tavily → стейджинг sales_* → пуш в Twenty (тег «AI BizDev», дедуп по domain/name).

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
CRUD: `GET/POST /api/admin/clients`, `PUT/DELETE /api/admin/clients/:id` (delete откажет при живых портах). Деньги: `POST /payment` (atomicCredit + settleBills + рефералка), `/charge`, `/balance_adjust`, `GET /payments`, `GET /ledger`, `DELETE /ledger/:entryIndex` (пересчёт баланса), `DELETE /payment/by-ledger/:id`. Документы: `POST/DELETE /document`. `POST /regenerate_key`.

### 6.4. Биллинг/финансы (admin)
`POST /api/admin/run_billing` (sync опция), `POST /billing_rerun` (пересчёт за дату из durable, dry_run); `GET/POST /api/admin/monthly_costs`; `GET /api/admin/finance_dashboard` (MRR/ARR/churn/ARPU/NRR/концентрация/utilization/RPM/затраты/прогноз EOM/тренд 12 мес/выручка по дням/платежи); `GET /api/admin/billing/reconciliation`; SLA: `GET /api/admin/clients/:id/sla`, `/api/admin/sla_overview`.

### 6.5. Банк (Точка)
Конфиг: `POST/GET /api/admin/tochka/config`, `/autodetect`, `/register_webhook`, `/sync` (ручная сверка выписки), `GET /payments`, `/match_payment`, `/dismiss_payment`, `/dismiss_unmatched`. Акты: `POST /create_act`, `GET /all_acts`, `POST /generate_acts`, per-client `GET/PUT /closing_documents/:docId` (PUT — правка позиций), `GET pdf|print`, `POST closing_document_status`, `DELETE closing_document/:docId` (удаляет и в банке). Счета: `POST /create_bill`, `/generate_bills`, `GET /all_bills` (с formulaText), `GET pdf|print`, `POST bill_status`, `DELETE /bill/:billId`.

### 6.6. Аналитика (admin)
`/api/analytics/monthly_traffic`, `/heatmap`, `/modem_heatmap`, `/rotations`, `/ip_stats`, `/traffic_forecast`, `/capacity`, `/latency_stats`, `/latency_day`, `/logs_domains_full`, `/modem_health`, `/modem_health_history`; `/api/admin/daily_traffic`, `/backfill_daily_traffic`, `/bandwidth_single|period`, `/reset_bandwidth`, `/unique_ips`, `/traffic_recon` (+`/run`), `/proxy_checks`, `POST /proxy_check`, `/top_hosts(_aggregated|_refresh)`, `/domain_guard` (+`/run`).

### 6.7. Система/настройки (admin)
`GET /api/admin/data` (главный агрегат: fleet+clients+traffic+finance, посекционная деградация), `/health` (+реестр джобов), `/jobs/:id`, `/system_health`, `/system_log`, `/audit_log`, `/db_audit`, `/api_usage`, `/api_access_log`, `/auto_reboot_log`, `/backup`, `POST /restart_dashboard`, `/cache/invalidate`. Серверы: `GET/POST/PATCH/DELETE /api/admin/servers[/:name]`, `/server_stats`. Настройки: `GET/PUT /api/admin/settings` (маскировка секретов; тумблеры alert_*). Алерты: `GET /api/admin/alerts`, `PUT /alerts/:id`, `POST /alerts/:id/test`. Уведомления: `GET /api/admin/notifications`, `/badge`, `/:id/read`, `/dismiss`, `/read-all`, `/dismiss-read-older`. Failover: `/failover/log|spares|candidates`, `POST /execute`. CRM/TG: `/crm/export`, `/crm_token`, `/crm_reminders`, `/telegram/preview`, `/telegram/send_test`. Симулятор: `simulator/*` (pool, profiles, run/abort, runs, compare, stream…). AI-продажи: `/ai_sales/*`.

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
| 01:00 | DailyBilling | ежедневные списания (см. §2.3) |
| 02:00 | DbBackup | SQLite online backup, ротация 7 дн, верификация |
| 02:00/14:00 МСК | Speedtest | по расписанию `speedtest_times`, re-test при <1 Мбит/с |
| 02:30 | HistoryPrune | rotation_log/system_log/proxy_checks >60д |
| 03:00 | TopHosts | сбор top_hosts по всем портам → top_hosts_detail |
| 03:25 | DomainGuard | контроль бан-листа доменов (config/blocked-domains.json) по дельтам |
| 03:30 | MonthlyReconciliation | 1-го числа: stored vs billed, добивка корректировкой |
| 03:40 | TrafficRecon | pmacct vs daily_traffic за вчера, алерты ≥10% |
| 04:00 | BalanceReconcile | баланс vs ledger, новые разрывы → critical+TG |
| 05:05 | MonthlyActs | авто-акты в день взаиморасчётов клиента |
| 05:10 | MonthlyBills | авто-счета (формула §2.4) |
| 05:20 | BillStatusSync | payment-status неоплаченных счетов → paid |
| 20:55 | HealthSnapshot | дневной скор здоровья модемов → modem_health_daily |
| 06:30 | ProxyExpiryCheck | прокси истекают <3 дн → алерт |

### Интервальные
- **trackModems** (~3 мин): фетч боксов, server down/recovered, meta-upsert, IP-трекинг, uptime-бакеты, авто-recovery, offline-алерты (порог `modem_offline_threshold_min`), сводка mass-down, prune.
- **HourlyAgg** (каждый час :00, 5 попыток): дельты → traffic_hourly; детект ресета счётчиков; spike-clamp (3×/1.5× от 24ч-среднего, floor 500 МБ); сглаживание uncertain медианой.
- **NotifyCollect** (2 мин): bell по fleet.disconnectedList (per-day дедуп), SIM-сигналы, долги, CRM-напоминания, TTL-чистка.
- **ProxyCheck** (60 мин): curl-замеры проданных неистёкших портов → proxy_checks.
- **AutoCreate** (10 мин): новый portName → авто-клиент (per_gb, цена по сетке).
- **SlaCheck** (6 ч): uptime/latency/error против SLA клиента → violations + авто-кредит 1%.
- **AutoReboot** (15 мин, выкл по дефолту): ребут проблемных по computeProxyIssues с троттлом.
- **TochkaSync** (30 мин + дебаунс от webhook): выписка 14 дней, идемпотентный зачёт, bill-settle.
- **Failover scan** (3 мин): кандидаты → teleport на спейр (гейты/кулдауны/рейт-лимит).
- **StalePortsHourly** (60 мин): чистка портов, отсутствующих >3 дней из daily_traffic; IMEI-dedupe per-server.
- **Watchdogs** (5 мин/60 мин): heap/диск/cron_stuck (джобы молчат >2× интервала).
- **ConnsHist** (60 с): TCP-коннекты по модемам (in-memory, 65 мин).
- **TG summary-loop** (60 с): дневная сводка по расписанию.
- **CRM sync** (10 мин). **Billing catch-up** при старте (snapshot >26ч → немедленный биллинг).

---

## 8. Правила алертов (src/telegram/alerts.js)

Каждое правило: вкл/выкл (`alert_<id>_enabled`), канал TG+колокольчик или только колокольчик, кулдаун per dedupeKey (персист в kv, TTL 7д), boot-grace 5 мин, каждый триггер пишется в notifications.

**🔴 critical:** server_unreachable (≥10 мин), modems_down_bulk (≥порога), tochka_webhook_failed, db_backup_failed, balance_drift, duplicate_credit_blocked, client_charge_failed (maxDebt), failover_no_spare, failover_failed, domain_guard_hit, domain_guard_failed, heap_high, disk_low_critical.
**🟡 important:** modem_offline_20m (порог настраиваемый, парность), modem_recovered, recovery_exhausted, failover_done, sim_redirect_imposed, sim_iccid_changed, sim_status_bad, reboot_score_high (≥70), payment_received, client_balance_negative, proxy_expiring_3d, traffic_recon_mismatch, traffic_recon_failed, traffic_spike_burst, dashboard_restarted.
**🔵 early:** heap_warn, disk_low_warn, cron_stuck.
**🔔 bell-only:** modem_offline, client_debt, crm_reminder.

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

1. `trackModems`: дефолт `tracking_interval_min=3`, а лог пишет «every 5 min» (startup.js) — рассинхрон комментария и кода.
2. `payments` — мёртвая таблица (read-only legacy); UI читает историю из billing_ledger.
3. `daily_summary` читает system_log с несуществующей колонкой `source` — деградирует молча в try/catch.
4. `tochkaRequest` имеет две сигнатуры (config-first в api.js и method-first через обёртку в server.js) — при выносе проверять.
5. `bills` пишутся двумя путями (saveClients-upsert + updateBillStatus) — осознанно, но хрупко.
6. CRM-напоминания читаются двумя независимыми путями (роут + notify-collect) с дублирующим SQL.
7. Джобы вне scheduler-реестра (crm-sync, notify-collect, failover, conns-history) не видны в `/api/admin/health.jobs`.
8. Скрытые вкладки в DOM: `#tab-traffic` (старый ACC-вид) и `#tab-ai_sales` — из навигации убраны, код жив.
9. `speedtest_history.json`, `server_cache.json`, `tochka_config.json` — файловые хранилища вне БД и вне бэкапов.
10. Миграции 040 не существует — дыра в нумерации (не ошибка).

## 11. Процессы разработки

- Репозиторий: GitHub ArtiomV/Proxy-Dashboard (main). Деплой: rsync из git-worktree на коммит → `pm2 restart dashboard --update-env` → проверка `/health`; бэкап кода tar перед каждым деплоем (/root/backups).
- Тесты: vitest (374+ тестов; контракты API через снапшоты routes.json/schema.json — обновлять UPDATE_SNAPSHOT=1 при осознанных изменениях). Линт ESLint (warnings допустимы, errors — нет).
- CI: GitHub Actions (тесты + линт).
- Изменения БД — только через migrations/0NN_*.sql (раннер при старте); schema-эквивалентность залочена тестом.
