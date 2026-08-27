# Operations notes

## Architecture
- Single Node.js process under pm2 (`dashboard` app).
- Single SQLite database at `/root/Proxy-Dashboard/dashboard.db` (path overridable via `DASHBOARD_DB_PATH` for tests).
- **Single-process only** — in-memory caches (`clientById`, `dailyTraffic`, `billingLedger`, `snapCache`) are per-process. **Do not enable pm2 cluster mode** (`instances > 1`) without first migrating those caches to SQLite reads or shared cache.

### Source layout (after 2026-05 refactor)
- `server.js` — bootstrap + state init + shared helpers + cron scheduler (~5 100 lines, no route definitions).
- `src/routes/*.js` — 18 Express `Router` factories, all 168 HTTP endpoints live here. Mounted by `server.js` via `app.use(require('./src/routes/X')(deps))`.
- `src/db/*.js` — per-domain prepared-statement repositories (`clients`, `ledger`, `documents`, `simulator`). Bulk reads/writes go through these; misc. ad-hoc queries still live inline in helpers in `server.js`. (`src/db/payments.js` удалён в C5 — legacy-таблица `payments` read-only, читатели на billing_ledger.)
- `src/billing/atomic.js` — `atomicCredit` / `atomicDebit` (balance + ledger row in one transaction). Stage-4 patch: receives `getClientById` + `getBillingLedger` getters (not the maps directly) so it follows rebinds across `rebuildClientMaps()`.
- `src/api/proxy-smart.js` — ProxySmart polling, `serverCache.json` cache, `invalidateCache()`.
- `src/tochka/*` — bank-webhook JWT verify + document/bill generators.
- `src/utils/*` — pure helpers (time, traffic parsing, file write, kv-guard).
- `public/js/admin.js` + `public/js/client.js` — extracted SPAs (admin.html and index.html now only contain markup + `<link>`/`<script src>`).
- `tests/` — Vitest + supertest. **71 tests**: route snapshot of 168 endpoints + billing/auth/clients/portal/tochka characterization + security headers + utils.

## Test + lint discipline
```bash
npm test         # vitest run — must be green before any deploy
npm run lint     # ESLint — 0 errors policy (warnings OK; silent catches are errors)
```
Route snapshot (`tests/api/__snapshots__/routes.json`) freezes the (method, path) pair list at 168 entries. Refresh intentionally with `UPDATE_SNAPSHOT=1 npm test` — never accept drift without a sign-off.

### Code style: молчаливые catch (правило, C7)
- **Молчаливый catch при деградации обязан писать `warn`** (в logger; для
  денежных/инфраструктурных деградаций — в `system_log` через logActivity).
  Контекст обязателен: какой блок деградировал + `e.message`.
- Пустой `catch (_) {}` допустим только для genuinely best-effort веток без
  деградации (например, опциональный столбец до миграции) — с комментарием.
- Правило введено 2026-08 (C7) и применяется к НОВОМУ и меняемому коду.
  Глобальный аудит существующих ~160 молчаливых catch — отдельный этап ТЗ,
  массово не правим вместе с фичами.

## Clean DB / migrations
- `schema.sql` is the **initial baseline** (treated as migration 000). Subsequent changes go in `migrations/NNN_*.sql`.
- Runner at startup applies any unapplied file in `migrations/` (atomic per file, tolerates "already exists" benign errors for idempotent re-runs).
- Bringing up a fresh DB: `node server.js` is enough — schema.sql + migrations run in order.
- Schema drift caught once (`external_proxies` missing from schema.sql) — fixed via `CREATE TABLE IF NOT EXISTS` in baseline. See FOLLOWUP.md if you spot another mismatch.

### Migration numbering quirks (documented, do not "fix")
- **040 is intentionally absent** — numbering jumps 039 → 041. The runner
  sorts filenames, so the gap is harmless; reusing 040 later would only
  confuse archaeology. Leave it.
- **007_add_performance_indexes vs 026_perf_indexes** — overlapping by
  design: 026 is the later, wider index set (perf work revisited). Both are
  `CREATE INDEX IF NOT EXISTS`, so application order doesn't matter.
- **015_ledger_unique vs 025_ledger_unique_all** — 025 supersedes 015
  (extends the uniqueness guarantee to all ledger rows, not just the subset
  015 covered). Keep both: 015's constraints are a subset and harmless.
- **manual/-миграции** (`migrations/manual/*.sql`) НЕ подхватываются раннером
  (он читает только `migrations/*.sql` верхнего уровня). Применяются
  оператором вручную по инструкции в шапке файла — см. ниже про payments.
  NB: номера manual/ и авторан-миграций независимы — `manual/056_drop_payments.sql`
  (C5b) и авторан-`056_doc_numbering_and_debt_block.sql` (B2) — разные файлы,
  это не коллизия.

### Дроп legacy-таблицы payments (C5b, на проде, руками оператора)

Таблица `payments` read-only: все читатели переведены на billing_ledger (C5a,
2026-08). Дроп — только после чистой сверки:

1. Pre-deploy снапшот БД: `cp dashboard.db dashboard.db.pre-056.bak`.
2. Сверка (read-only, exit 0 = чисто):
   `node scripts/reconcile-payments.js --db /root/Proxy-Dashboard/dashboard.db --out reconcile-report.json`
   Для каждого клиента сравнивает Σ `payments` vs Σ ledger
   (payment + bank_payment − payment_reversal). Расхождения — список для
   ручной доимпортации в billing_ledger; после доимпортации прогнать сверку
   повторно до exit 0.
3. Применить ручную миграцию (команды — в шапке
   `migrations/manual/056_drop_payments.sql`), отметить в `_migrations`,
   `pm2 restart dashboard`.
4. После дропа убрать `CREATE TABLE payments` (+ её индексы) из `schema.sql`
   и строку из §1.1 FUNCTIONAL-SPEC.
- **043_api_key_hash** calls `sha256hex()`, a JS function registered by
  server.js before the runner executes — it cannot be applied with the
  sqlite3 CLI. Keep comments in migration files free of `;` — the runner's
  per-statement fallback splits files naively (a `;` inside a comment once
  aborted startup).

## Deployment
Current flow (production): `scripts/deploy.sh` (rsync + npm ci + pm2 restart).
С D2 (2026-08) скрипт перед rsync делает **pre-deploy снапшот БД** на сервере
(`$DB_BACKUP_DIR/pre-deploy-<timestamp>/`, ротация последних 5) — точка отката
на случай сломанного деплоя/миграции. Usage: `SERVER=root@2.29.2.168 ./scripts/deploy.sh`.
No staging env. **Future improvement** — add `staging.proxies.rent` with a separate DB and run integration tests there before prod cuts.

Recommended deploy script (todo):
```bash
#!/bin/bash
set -euo pipefail
SERVER=root@2.29.2.168
DIR=/root/Proxy-Dashboard
rsync -av --exclude='*.db' --exclude='node_modules' --exclude='logs' \
  ./ $SERVER:$DIR/
ssh $SERVER "cd $DIR && npm ci --omit=dev && pm2 restart dashboard"
ssh $SERVER "sleep 5 && curl -sf http://localhost:3000/health || (pm2 restart dashboard && exit 1)"
```

## Database backup
- Daily backup at 02:00 UTC (джоба DbBackup, src/jobs/backup.js) to
  `/var/backups/proxy-dashboard/dashboard-YYYY-MM-DD.db`, с верификацией
  (открывается и проверяется наличие таблицы clients).
- Retention: **7 daily** + **12 monthly** (D2): снапшот, сделанный 1-го числа,
  копируется в `monthly/` и хранится год.
- **Offsite (D2)**: после успешного DbBackup вызывается
  `scripts/backup-offsite.sh` — выгрузка daily+monthly в облако через **rclone**
  (remote из `$RCLONE_REMOTE`, назначение `<remote>:proxy-dashboard-backups`).
  Сбой выгрузки НЕ роняет локальный бэкап, но пишет warn в лог и system_log
  (`backup_offsite_failed`) — не молчит (C7). Если rclone/remote не настроены,
  скрипт падает с понятной ошибкой — тот же warn.
- **Pre-deploy снапшот (D2)**: `scripts/deploy.sh` перед rsync делает снапшот
  БД на сервере в `$DB_BACKUP_DIR/pre-deploy-<timestamp>/` (sqlite3 `.backup`,
  фолбэк — WAL-checkpoint + cp), хранятся последние 5. Это точка отката,
  если деплой или авторан-миграция сломает БД.
- Restore: stop dashboard → copy backup over `dashboard.db` → start.
  Полный сценарий восстановления на чистой машине — **docs/DR-RUNBOOK.md** (D6).

### Настройка rclone (оператор, на сервере)
1. `rclone config` → завести remote типа S3 / Backblaze B2 (креды B2
   предоставляет оператор — application key; хранятся в `~/.config/rclone/`,
   НЕ в репо). Для B2: type=b2, account=keyID, key=applicationKey.
2. В env дашборда: `RCLONE_REMOTE=<имя remote>` (например `b2`), затем
   `pm2 restart dashboard --update-env`.
3. Проверка руками: `bash scripts/backup-offsite.sh /var/backups/proxy-dashboard`.
4. Lifecycle-правила на стороне бакета (TTL версий) — на усмотрение оператора;
   ротация daily/monthly и так ограничивает объём выгрузки.

### Full state inventory (what a complete backup must include)
A `dashboard.db` snapshot does NOT cover all process state — some
artifacts still live on disk as JSON files. A complete backup needs:

  1. **`dashboard.db`** — primary store: clients, billing_ledger,
     payments (legacy read-only, дроп после сверки — C5b), bank_payments, sessions,
     audit_log, system_log, modem_meta, rotation_log, proxy_checks,
     traffic_hourly, daily_traffic, hourly_snapshots, ip_history,
     api_usage, simulator_runs/samples, monthly_costs,
     auto_reboot_log, top_hosts_detail, ip_tracking, uptime_tracking,
     client_documents, closing_documents, bills, kv_store(+_history),
     _migrations.

  2. **`known_modems.json`** — server_name → port_id → modem metadata
     (IMEI, nick, model, last-seen). Mutated by every modem-polling
     cycle; restored at boot. Stale-port-cleanup runs against it.

  3. **`tochka_config` (kv_store, внутри dashboard.db)** — D1 (2026-08):
     Tochka Bank API credentials (JWT, clientId, customerCode, accountId,
     company details, bank account) переехали из файла `tochka_config.json`
     в kv_store: JSON-объект, каждое непустое значение — `enc1:` +
     AES-256-GCM (per-field, как SENSITIVE_SETTINGS), запись через
     kvSetCritical (shape-guard). Конфиг теперь входит в dashboard.db →
     попадает в DbBackup автоматически. Приоритет источников при старте:
     **.env (`TOCHKA_*`) > kv_store > legacy-файл**. Файл
     `tochka_config.json` — DEPRECATED read-only фолбэк: если kv пуст,
     а файл есть, при старте выполняется миграция файл → kv; файл не
     удаляется и больше не перезаписывается. Ключ шифрования:
     $TOCHKA_CONFIG_KEY env > /etc/machine-id > legacy hostname hash.

  4. **`speedtest_history.json`** — rolling per-modem speedtest entries
     (timestamp, download/upload Mbps, ping). Bounded by
     appSettings.speedtest_max_history.

  5. **`server_cache.json`** — per-ProxySmart-server cached bandwidth +
     status + ports response. Non-critical — rebuilt from API polling
     on next cycle. Useful for cold-start without waiting for first poll.

  6. **`.env`** — `$TOCHKA_CONFIG_KEY` (mandatory for tochka_config
     decryption on a new host), `$ANTHROPIC_API_KEY`,
     other secrets.

  7. **`logs/dashboard.log`** — optional, log rotation handles size.

  8. **Migration history** — `_migrations` table (inside `dashboard.db`)
     records which migrations have run. Don't drop it on restore.

### Why files outside the DB?
Historical: known_modems.json + speedtest predate the SQLite migration.
tochka_config folded into kv_store in D1 (2026-08) — see above.
**FOLLOWUP candidate** (deferred per TZ): fold the remaining JSON state
into `kv_store` so a single `dashboard.db` snapshot captures everything
except `.env` secrets.

## Log rotation
- `pm2-logrotate` module: 50 MB max, 14 retained, gzip compressed, daily.
- Config: `pm2 conf pm2-logrotate`.

## Health & metrics
- `GET /health` — public, verifies DB read, returns 503 if broken.
- `GET /metrics` — public, Prometheus text exposition format.
- `GET /api/admin/health` — auth required, detailed JSON dump (memory, ledger size, etc).

## Alerting
- Daily summary: Telegram, 08:00 MSK (configurable).
- Urgent alerts: errors/critical events in `system_log` that match `URGENT_ACTIONS` set in `server.js` (server_unreachable, billing_failed, db_backup_failed, etc.) forward immediately to Telegram with 15-min cooldown per action.

## Автоблок должников-физиков (B3, src/jobs/debt-block.js)
- **Когда срабатывает:** в конце DailyBilling (01:00 UTC, и на retry-прогонах): физик (`client_type != 'legal'`) с `balance ≤ 0` и `allow_debt = 0` → всем его портам `PROXY_VALID_BEFORE` = сегодня (тот же путь, что ручной save_port_config: edit_port form → POST → apply_port). Юрлица никогда.
- **Восстановление:** любое зачисление (atomicCredit → событие `client-credit`): `debt_blocked=1` и `balance > 0` → «дата до» = сегодня + 30 дней. Ручной платёж/webhook — сразу; банковский sync — до ~30 мин (цикл TochkaSync).
- **Диагностика:** audit_log (`debt_block`/`debt_unblock`), system_log (`debt_block`, `debt_block_error`, `debt_restore`, `debt_restore_error`), TG-правила `client_blocked_debt`/`client_unblocked_debt`/`client_block_warning`.
- **Ручная разблокировка:** поставить клиенту `allow_debt = 1` в настройках клиента и/или продлить «Действителен до» порта в UI (save_port_config) — автоблок уже истёкшие даты не перезаписывает, восстановление не укорачивает более поздние.
- **Нумерация актов/счетов (B2):** счётчик `doc_numbering` (year → next_num), единая сквозная серия «№ N/YYYY» для актов и счетов; дыры не переиспользуются. Анти-дабл: UNIQUE(client_id, period, type) на closing_documents и UNIQUE(client_id, period) на bills — если INSERT внезапно падает с constraint-ошибкой, значит дубль за период: удалить старый документ (delete+create = «перевыставить»).


## Network security: ProxySmart API transport (OPEN ITEM)
- Today the dashboard talks to ProxySmart servers over **plain HTTP with
  Basic-auth** (`API_S*_URL=http://...` in .env). Credentials and modem
  commands cross the wire unencrypted — anyone on the path (hoster, ISP,
  compromised middlebox) can read or replay them, including USB-reset actions.
- This is NOT fixable from this repo — it needs infrastructure work on the
  ProxySmart hosts. Options, cheapest first:
  1. **WireGuard/Tailscale tunnel** between the dashboard host and each
     ProxySmart server; point `API_S*_URL` at tunnel IPs. No certs, no public
     exposure — recommended.
  2. **HTTPS reverse proxy** (nginx + Let's Encrypt) in front of each
     ProxySmart API; switch URLs to https:// and verify certs.
  3. **stunnel/socat TLS wrapper** per server if nginx is too heavy.
- Until then: treat ProxySmart credentials as exposed, rotate them
  periodically, and never reuse them anywhere else.

## Environment variables
Required:
- `PORT` — HTTP listen port (default 3000)

Optional:
- `TOCHKA_CONFIG_KEY` — 64-char hex AES key for encrypting the Tochka
  config (kv_store `tochka_config`, enc1:-values). **ОБЯЗАТЕЛЕН на проде
  (runbook, D1)**: без него ключ выводится из /etc/machine-id, а тот
  фолбэк умирает при пересборке хоста — конфиг станет нечитаемым.
  Генерация: `openssl rand -hex 32` (генерирует исполнитель, подставляет
  в env оператор — не в репо/не в чате). Приоритет источников конфига
  при старте: `.env (TOCHKA_*)` > kv_store > legacy-файл tochka_config.json
  (deprecated read-only фолбэк). См. также docs/DR-RUNBOOK.md.
- `DB_BACKUP_DIR` — backup destination (default `/var/backups/proxy-dashboard`)
- `RCLONE_REMOTE` — имя rclone remote для offsite-выгрузки бэкапов (D2);
  без него облачная выгрузка честно падает с warn в логах
- `TRUSTED_PROXY` — comma-separated trusted reverse-proxy IPs (default `127.0.0.1,::1`)
- `TELEGRAM_*` — defaults loaded from app_settings table, env vars override

## API versioning
- `/api/v1/*` — public proxy/credentials API, versioned (proxy, proxies endpoints).
- `/api/admin/*`, `/api/client/*` — unversioned internal endpoints. **Breaking changes** here directly impact the bundled admin.html — coordinate the two sides.
- Deprecation: `apikey` query-string parameter is deprecated; `X-API-Key` header is preferred. Both still work; query-string emits `Deprecation`, `Sunset`, and `Warning` HTTP headers.

## Time
- All billing keys on Moscow time (UTC+3 fixed; no DST). `getMoscowToday()` etc helpers.
- ProxySmart servers in MD/RO must remain in UTC+3. If they drift, billing-day boundary shifts.

## Frontend asset organization (after Stage 5)
- `public/admin.html` — 1 070 lines, only markup + CSS+JS `<link>`/`<script src>` references.
- `public/js/admin.js` — extracted SPA, served as static asset.
- `public/index.html` — 654 lines, ditto for the client portal.
- `public/js/client.js` + `public/js/utils.js` — client portal logic + shared utilities (`esc`, `parseTraffic`, `fmtGb`).
- `public/css/client-portal.css` — extracted theme/layout for the client portal (was 546 lines inline in index.html). `:root` defines its own tokens — see FOLLOWUP for the planned convergence with `css/variables.css`.

## CSP
- Restored after Stage 5 — `helmet({ contentSecurityPolicy: {...} })`.
- `script-src 'self' cdn.jsdelivr.net` (for Chart.js) — **no `unsafe-inline` on `script-src`**.
- `script-src-attr 'unsafe-inline'` — required because admin.js still emits dynamic HTML with `onclick="..."` attributes. Migrating those to event delegation is FOLLOWUP work.
- `frame-ancestors 'none'` — anti-clickjacking.
- `tests/api/security-headers.test.js` locks the policy shape (reverting to `contentSecurityPolicy: false` trips the test).

## Production bugs surfaced by the refactor (all fixed)
1. `external_proxies` missing from `schema.sql` — fresh DBs couldn't bootstrap.
2. ProxySmart cache invalidation was a **silent no-op** in 12 spots (`_psCache = null` referenced an identifier that didn't exist in scope). Replaced with `proxySmart.invalidateCache()`.
3. `billing/atomic.js` was holding a stale `clientById` Map reference after `rebuildClientMaps()` — `HTTP /api/admin/clients/:id/payment` returned `balance: 0` even when DB had the new value. Fixed by passing `getClientById` as a getter.
4. `tochka_config.json` decryption fragile when host hostname changes (derived key drift). Recovered with one-shot script + now use explicit `$TOCHKA_CONFIG_KEY` in .env.
5. `clientByLogin` had the same stale-rebind issue inside the client portal — fixed with the same shim pattern.
6. `getAllBankPayments` was called from tochka.js + ops-ext.js but never wired through deps — would have thrown `ReferenceError` on first hit. Caught by lint after Stage 3 extraction.

Each is documented in `FOLLOWUP.md` (✅ marker for the fixed ones).
