# Refactor follow-ups

Things spotted while doing the structured refactor that are **out of scope** for
the migration but worth dealing with later. Per the TZ rule "не чинить по ходу"
they go here instead of into the working commits.

## Schema / migrations

- **`external_proxies` was missing from `schema.sql`** (only existed implicitly
  through migration 005's `ALTER TABLE ... ADD COLUMN` statements). Fresh DBs
  could not bootstrap because migration 005 ran before the table existed.
  Worked around by adding the base `CREATE TABLE IF NOT EXISTS` to `schema.sql`
  in Stage 1 (idempotent on prod). The broader cleanup — "schema.sql is
  migration 000, source of truth lives in `migrations/`" — is Stage 2 work.

- **Decide policy:** keep `schema.sql` as the bootstrap snapshot AND keep
  per-table migrations? Or fold `schema.sql` into `migrations/000_baseline.sql`
  and delete the standalone file? Either is defensible — picking one removes
  the drift class.

- **No automated schema-equivalence check.** A fresh DB built from
  `schema.sql + migrations/` should be structurally identical to the prod DB.
  Today this is checked by eye. Add a test in Stage 2 that diffs `.schema`
  output of a fresh DB against a committed reference.

## Test harness

- **`logs/dashboard.log` is appended to from tests** because `src/logger.js`
  always opens a write stream regardless of `NODE_ENV`. Low priority — log
  noise, not correctness. Could be guarded by `NODE_ENV !== 'test'`.

- **Single shared DB across test files in one process.** With `fileParallelism:
  false` all suites in a vitest run share one temp DB. Tests must clean up
  their own fixtures. If isolation per file becomes important, switch to
  spawning one worker per file (`pool: 'forks'`) which gets its own process /
  setup-env / DB.

## Production gotchas observed

- **Tochka config decryption is fragile when `$TOCHKA_CONFIG_KEY` is unset:**
  derived fallback uses `hostname + platform`, so a hostname change locks the
  user out of the config (already happened once, recovered with old-hostname
  derivation). Stage 4 candidate: switch fallback to `/etc/machine-id` (stable
  across hostname changes), or require explicit `$TOCHKA_CONFIG_KEY` and refuse
  to derive silently.

## Production bugs surfaced by lint / Stage 6

- **Proxy-cache invalidation was completely broken.** server.js had 12
  spots doing `_psCache = null; _psCacheTs = 0;` to drop the ProxySmart
  cache. Those identifiers don't exist in server.js scope — they live
  inside `src/api/proxy-smart.js`. Without `'use strict'`, the
  assignments became silent no-ops, so every cache-invalidate code path
  (manual /api/admin/cache/invalidate, post-rotation, after-bulk-port-
  change, etc.) had been doing nothing for an unknown amount of time.
  Stage 6 commit added `proxySmart.invalidateCache()` and rewrote all
  12 callsites. Symptom in prod: changes to ports / rotations / clients
  could take up to PS_CACHE_TTL (30s) to appear in the dashboard for
  every user — admins probably just refreshed twice.

## Production bugs surfaced by characterization tests

- ✅ **FIXED in Stage 4 (commit refactor/stage-4):** `atomicCredit` /
  `atomicDebit` used to keep a stale `clientById` reference after
  `rebuildClientMaps()` because server.js passed the Map by value and
  later rebound the global. Billing's closure pointed at the (now-empty)
  original Map → `if (client) client.balance = balanceAfter` no-op.
  `/api/admin/clients/:id/payment` returned `balance: 0` even though DB
  was correct. Stage 4 fix: `billing.init({ getClientById, getBillingLedger })`
  takes getters so every credit/debit re-reads the current binding.
  Characterization tests now assert HTTP body balance matches DB —
  previously they pinned to DB only to avoid red.

## Stage 2 — remaining db.prepare() migrations

Stage 2 extracted the **billing-critical** domains: simulator, clients,
ledger, payments, documents (43 statements → 5 repos). Remaining 162
inline `db.prepare()` calls in server.js are mostly inside route bodies
for tracking / traffic / kv / proxy-checks / analytics. These will move
into per-domain modules naturally during **Stage 3** (route slicing) —
each `src/routes/<domain>.js` file will own its prepared statements via
a sibling `src/db/<domain>.js`. Doing it in Stage 2 first would mean
touching the same routes twice; folding it into Stage 3 keeps the
review surface smaller.

Domains still to extract (will happen alongside Stage 3 commits):
  - `kv` (4 stmts; coupled with kv-guard so will keep current layering)
  - `traffic` (~5 stmts: daily_traffic, traffic_hourly, hourly_snapshots)
  - `tracking` (~7 stmts: ip_tracking, uptime_tracking, ip_history,
    modem_meta, rotation_log, proxy_checks, api_usage)

## Stage 4 — billingLedger removal (DONE)

Stage 4a (commit `079633c`) and 4b (`dc12b9d`) closed this entirely.

What changed:
  - `src/db/ledger.js#listByClient(clientId)` reads + rehydrates the
    historical JS shape on every call (charges store `cost`, others
    `amount`; `delta_gb` not `gb_used`; camelCase `paymentId`; `details`
    JSON merged onto the entry).
  - All 8 former callsites (`clients.js`, `tochka.js`, `client-portal.js`,
    `billing-ext.js`, `ops-ext.js`, `server.js` autoActs/autoBills/recon)
    now call `ledgerDb.listByClient(id)` or a hoisted SQL aggregate.
  - `src/billing/atomic.js` no longer writes to any in-memory ledger
    array — `_ledgerInsert.run()` inside the same transaction is the
    canonical write. Dropped the `getBillingLedger` dep entirely.
  - `let billingLedger = {}` + its startup loader were deleted from
    server.js. The legacy `billing_ledger.json` JSON file (pre-SQLite
    fallback) is one-shot imported into the table if rows == 0 AND the
    file exists; otherwise the path is dead.
  - `/metrics` (proxy_dashboard_ledger_entries_total) and `/api/admin/health`
    (database.ledger_entries) read `SELECT COUNT(*) FROM billing_ledger`
    instead of walking the in-memory object.
  - Startup integrity: `tests/billing-ledger-integrity.test.js` confirms
    the row count returned by `ledgerDb.rowCount()` matches the rows
    listed by `listByClient` summed across all clients (no silent drift).

The only `billingLedger` references left in the repo are commented-out
historical notes (e.g. "moved in Stage 4"). Verified via:
`grep -rnE 'billingLedger' server.js src/` — only comments match.

## TZ status snapshot (post-Stage 4 finish)

| TZ item                               | Status        | Notes                                                                        |
|---------------------------------------|---------------|------------------------------------------------------------------------------|
| Stage 1: tests + route snapshot       | ✅ Done       | 11 files, 72 tests, 168-route snapshot locked                                |
| Stage 2: SQL → src/db/*               | ✅ Done       | 8 repos (clients, ledger, kv, traffic, tracking, payments, documents, sim)   |
| Stage 3: routers → src/routes/*       | ✅ Done       | 18 routers; latent dep-injection gaps closed (commit 9834016)                |
| Stage 4a: billingLedger removed       | ✅ Done       | Commit 079633c — DB reads via ledgerDb.listByClient on every call            |
| Stage 4b: src/state/index.js          | ✅ Done       | Commit dc12b9d — clients + 5 maps centralized; shim objects gone             |
| Stage 5: inline JS extracted          | ✅ Done       | admin.js, client.js, client-portal.css separated                             |
| Stage 5 phase 2: onclick → delegation | ⏳ Deferred   | CSP allowlist active; migration backlog below                                |
| Stage 6: lint + dead code + docs      | ✅ Done       | 0 lint errors across server.js + src/ (DoD #3)                               |
| DoD #1: server.js < 250 lines         | ⏳ Partial    | Currently ~5,160. See "Backlog: src/jobs extraction" below                   |
| DoD #2: > 70 tests                    | ✅ Done       | 72 tests across 11 files                                                     |
| DoD #3: 0 ESLint errors               | ✅ Done       | server.js + src/ both zero-error                                             |
| DoD #7: route snapshot matches        | ✅ Done       | Locked at 168 routes; trips on any new/dropped route                         |

## Backlog: src/jobs extraction (DoD #1 path)

server.js is still ~5,160 lines vs. the TZ's <250 aspirational target. The
gap is in long-running jobs and cron handlers that live as top-level
functions. Pre-identified extraction targets (by line count, biggest wins
first):

| Target function                  | Lines | Extract to                  |
|----------------------------------|------:|-----------------------------|
| `_runDailyBillingImpl`           |   215 | `src/jobs/daily-billing.js` |
| `trackModems`                    |   162 | `src/jobs/modem-monitor.js` |
| `cleanupStalePortMappings`       |   147 | `src/jobs/cleanup.js`       |
| `aggregateTopHosts`              |   113 | `src/analytics/top-hosts.js`|
| `runMonthlyReconciliation`       |    95 | `src/jobs/daily-billing.js` |
| `autoCreateMissingClients`       |    86 | `src/jobs/tochka-cron.js`   |
| `checkProxyLatency`              |    82 | `src/jobs/modem-monitor.js` |
| `autoGenerateMonthlyBills`       |    81 | `src/jobs/tochka-cron.js`   |
| `autoGenerateMonthlyActs`        |    78 | `src/jobs/tochka-cron.js`   |
| `runRetentionCleanup`            |    77 | `src/jobs/cleanup.js`       |
| `runNightlySpeedtests`           |    78 | `src/jobs/speedtest.js`     |

Extracting all of the above ≈ −1,200 lines (server.js → ~3,950). To reach
<250 would also need to lift: state declarations (dailyTraffic / ipTracking
/ uptimeTracking / etc., still mutable globals — see "src/state/index.js
deferred state" below), the cron schedule (4–5 `setInterval` calls),
helpers (mergeServerData / fetchApi / saveApiServersToDb), and the
migration runner (~100 lines). That's another ~1,800–2,000 lines moved
out, putting the boot script in the ~1,500-line range. Hitting <250
needs aggressive splitting of the migration runner itself + boot
sequencing.

**Why deferred:** each extraction is risky (the cron jobs touch ~15
globals each); doing them under the "one stage = one commit, tests as
gates" discipline of the TZ is multi-day work and the user explicitly
chose to prioritize behavior-preserving completion of Stages 1–4 first.

## src/state/index.js deferred state

Stage 4b moved `clients` + 5 client maps into `src/state/index.js`. The
following module-level state still lives in server.js as `let` bindings
and should follow the same pattern in a future pass:

- `dailyTraffic`, `ipTracking`, `uptimeTracking`, `ipHistory` — mutated
  via property writes (no rebind) so safe to migrate as `const` views.
- `apiServers`, `appSettings`, `tochkaConfig` — get REBOUND via
  saveTochkaConfig / hot-reload. Migrate with explicit mutators
  (`setTochkaConfig()`, etc.) on the state module.
- `portKeyToPortName`, `knownModems`, `users` — same as the first group.

## Stage 5 — phase 2 (not yet done)

- **CSP partially restored.** server.js has `script-src 'self'` after
  Stage 5 phase 1 (✅), with `script-src-attr 'unsafe-inline'` carved out
  to keep the dozens of inline `onclick="…"` attributes in admin.html /
  dynamically-generated admin.js markup working. Phase 2 is the
  progressive migration to event delegation + dropping the
  `script-src-attr` carve-out.

- **client-portal.css :root may diverge from admin's variables.css.**
  index.html's CSS was lifted into a new client-portal.css with its own
  `:root { --bg-0, --accent, … }` block. variables.css has the admin
  versions of the same tokens. If a theme color changes in one file but
  not the other, the two SPAs drift visually. Future tidy: merge the
  shared subset into variables.css, keep client-only tokens in
  client-portal.css.

- **admin.js + client.js could share a small "common" module** for
  things like `apiFetch`, `authToken` handling, theme persistence. Today
  there's some duplication.

  Stage 7 closed the byte-unit slice of this: `utils.js` is now the
  single source for `esc`, `parseTraffic`, `bytesToGb`, `fmtGb`,
  `fmtGbShort`, `pct`, `formatBytes`, `getModemStatus`, `formatUptime`,
  `formatTraffic`, `renderSignalBars`, `renderNetBadge`, `fmtDateRu`,
  `showToast`, `getChartColors` — loaded by BOTH `admin.html` and
  `index.html`. Tests in `tests/frontend-utils.test.js` lock the
  decimal-SI semantics and the frontend↔backend invariant. What still
  isn't shared: HTTP plumbing (`apiFetch`), auth token handling, theme
  persistence; those duplicates remain and a `common.js` module would
  collapse them.

## Behavior questions to confirm before changing

- The `BENIGN_MIGRATION_ERRORS` regex set includes `/no such column/i` with a
  hand-wavey comment about "safe for UPDATE re-runs". Verify on a specific
  failing migration before relying on this — currently the runner will pass
  over a real schema bug if it manifests as `no such column`.
