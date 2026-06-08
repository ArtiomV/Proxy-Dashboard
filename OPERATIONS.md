# Operations notes

## Architecture
- Single Node.js process under pm2 (`dashboard` app).
- Single SQLite database at `/root/Proxy-Dashboard/dashboard.db` (path overridable via `DASHBOARD_DB_PATH` for tests).
- **Single-process only** — in-memory caches (`clientById`, `dailyTraffic`, `billingLedger`, `snapCache`) are per-process. **Do not enable pm2 cluster mode** (`instances > 1`) without first migrating those caches to SQLite reads or shared cache.

### Source layout (after 2026-05 refactor)
- `server.js` — bootstrap + state init + shared helpers + cron scheduler (~5 100 lines, no route definitions).
- `src/routes/*.js` — 18 Express `Router` factories, all 168 HTTP endpoints live here. Mounted by `server.js` via `app.use(require('./src/routes/X')(deps))`.
- `src/db/*.js` — per-domain prepared-statement repositories (`clients`, `ledger`, `payments`, `documents`, `simulator`). Bulk reads/writes go through these; misc. ad-hoc queries still live inline in helpers in `server.js`.
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

## Clean DB / migrations
- `schema.sql` is the **initial baseline** (treated as migration 000). Subsequent changes go in `migrations/NNN_*.sql`.
- Runner at startup applies any unapplied file in `migrations/` (atomic per file, tolerates "already exists" benign errors for idempotent re-runs).
- Bringing up a fresh DB: `node server.js` is enough — schema.sql + migrations run in order.
- Schema drift caught once (`external_proxies` missing from schema.sql) — fixed via `CREATE TABLE IF NOT EXISTS` in baseline. See FOLLOWUP.md if you spot another mismatch.

## Deployment
Current flow (production):
```
scp server.js root@159.194.228.17:/root/Proxy-Dashboard/server.js
ssh root@159.194.228.17 'pm2 restart dashboard'
```
No staging env. **Future improvement** — add `staging.proxies.rent` with a separate DB and run integration tests there before prod cuts.

Recommended deploy script (todo):
```bash
#!/bin/bash
set -euo pipefail
SERVER=root@159.194.228.17
DIR=/root/Proxy-Dashboard
rsync -av --exclude='*.db' --exclude='node_modules' --exclude='logs' \
  ./ $SERVER:$DIR/
ssh $SERVER "cd $DIR && npm ci --omit=dev && pm2 restart dashboard"
ssh $SERVER "sleep 5 && curl -sf http://localhost:3000/health || (pm2 restart dashboard && exit 1)"
```

## Database backup
- Daily backup at 02:00 UTC to `/var/backups/proxy-dashboard/dashboard-YYYY-MM-DD.db`.
- Retention: 14 days.
- Restore: stop dashboard → copy backup over `dashboard.db` → start.
- **TODO** — sync backups offsite (S3 / external rsync target). Single-host backups don't protect against host loss.

### Full state inventory (what a complete backup must include)
A `dashboard.db` snapshot does NOT cover all process state — some
artifacts still live on disk as JSON files. A complete backup needs:

  1. **`dashboard.db`** — primary store: clients, billing_ledger,
     payments (read-only post-Stage-13.3), bank_payments, sessions,
     audit_log, system_log, modem_meta, rotation_log, proxy_checks,
     traffic_hourly, daily_traffic, hourly_snapshots, ip_history,
     api_usage, simulator_runs/samples, monthly_costs, sla_violations,
     auto_reboot_log, top_hosts_detail, ip_tracking, uptime_tracking,
     client_documents, closing_documents, bills, kv_store(+_history),
     external_proxies, _migrations.

  2. **`known_modems.json`** — server_name → port_id → modem metadata
     (IMEI, nick, model, last-seen). Mutated by every modem-polling
     cycle; restored at boot. Stale-port-cleanup runs against it.

  3. **`tochka_config.json`** — AES-256-GCM encrypted Tochka Bank API
     credentials (JWT, clientId, customerCode, accountId, company
     details, bank account). Key derivation: $TOCHKA_CONFIG_KEY env
     > /etc/machine-id > legacy hostname hash (Stage 12). Without the
     key the backup file is unreadable on a different host.

  4. **`speedtest_history.json`** — rolling per-modem speedtest entries
     (timestamp, download/upload Mbps, ping). Bounded by
     appSettings.speedtest_max_history.

  5. **`server_cache.json`** — per-ProxySmart-server cached bandwidth +
     status + ports response. Non-critical — rebuilt from API polling
     on next cycle. Useful for cold-start without waiting for first poll.

  6. **`.env`** — `$TOCHKA_CONFIG_KEY` (mandatory for tochka_config
     decryption on a new host), `$ANTHROPIC_API_KEY`, `$CRM_DB_URL`,
     other secrets.

  7. **`logs/dashboard.log`** — optional, log rotation handles size.

  8. **Migration history** — `_migrations` table (inside `dashboard.db`)
     records which migrations have run. Don't drop it on restore.

### Why files outside the DB?
Historical: tochka_config.json + known_modems.json + speedtest predate
the SQLite migration. **FOLLOWUP candidate** (deferred per TZ): fold
the JSON state into `kv_store` so a single `dashboard.db` snapshot
captures everything except `.env` secrets.

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

## Environment variables
Required:
- `PORT` — HTTP listen port (default 3000)

Optional:
- `TOCHKA_CONFIG_KEY` — 64-char hex AES key for encrypting `tochka_config.json`. If unset, a host-derived key is used.
- `DB_BACKUP_DIR` — backup destination (default `/var/backups/proxy-dashboard`)
- `TRUSTED_PROXY` — comma-separated trusted reverse-proxy IPs (default `127.0.0.1,::1`)
- `CRM_DB_URL` — Postgres URL for CRM read-only access (optional integration)
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
