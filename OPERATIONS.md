# Operations notes

## Architecture
- Single Node.js process under pm2 (`dashboard` app).
- Single SQLite database at `/root/Proxy-Dashboard/dashboard.db`.
- **Single-process only** — in-memory caches (`clientById`, `dailyTraffic`, `billingLedger`, `snapCache`) are per-process. **Do not enable pm2 cluster mode** (`instances > 1`) without first migrating those caches to SQLite reads or shared cache.

## Deployment
Current flow (production):
```
scp server.js root@5.35.87.236:/root/Proxy-Dashboard/server.js
ssh root@5.35.87.236 'pm2 restart dashboard'
```
No staging env. **Future improvement** — add `staging.proxies.rent` with a separate DB and run integration tests there before prod cuts.

Recommended deploy script (todo):
```bash
#!/bin/bash
set -euo pipefail
SERVER=root@5.35.87.236
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

## Frontend asset organization (current state)
- `public/admin.html` — single ~6500-line file with inline JS. **Future improvement** — split into modules under `public/js/`. Not blocking but improves first-paint and maintainability.
