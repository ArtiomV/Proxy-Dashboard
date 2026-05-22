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

- **Schema policy: DECIDED (Stage 12).** `schema.sql` is the bootstrap
  snapshot (treated as logical migration 000); the source of truth for
  per-table changes is `migrations/NNN_*.sql`. Documented in
  OPERATIONS.md → "Clean DB / migrations". A fresh DB built from
  `schema.sql + migrations/*` is verified structurally identical to prod
  by `tests/schema-equivalence.test.js` (snapshots `sqlite_master`
  output, trips on any drift). The earlier "either is defensible" entry
  here is now closed.

## Test harness

- **`logs/dashboard.log` test noise: FIXED (Stage 12).** `src/logger.js`
  no longer opens the file write stream when `NODE_ENV === 'test'`; tests
  still see logs on stdout (where vitest's `--silent` flag mutes them by
  default in CI). The historical noise is gone.

- **Single shared DB across test files in one process.** With `fileParallelism:
  false` all suites in a vitest run share one temp DB. Tests must clean up
  their own fixtures. If isolation per file becomes important, switch to
  spawning one worker per file (`pool: 'forks'`) which gets its own process /
  setup-env / DB.

## Production gotchas observed

- **Tochka config key fragility: FIXED (Stage 12).** Key derivation now
  follows a preference chain: (1) `$TOCHKA_CONFIG_KEY` env, (2)
  `/etc/machine-id` SHA-256 (stable across `hostnamectl set-hostname`),
  (3) the legacy `hostname + platform` hash. Decryption tries all three
  in turn; whichever authenticates wins. On a successful non-preferred
  decrypt we WARN-log and the next `saveTochkaConfig()` re-encrypts with
  the preferred key, completing the migration silently. So a hostname
  change can no longer lock the operator out, and existing files
  encrypted with the legacy hash still open without any manual
  intervention.

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

## TZ status snapshot (post-Stage 12)

| TZ item                                | Status      | Notes                                                                        |
|----------------------------------------|-------------|------------------------------------------------------------------------------|
| Stage 1: tests + route snapshot        | ✅ Done     | 13 files, 83 tests, 168-route snapshot locked                                |
| Stage 2: SQL → src/db/*                | ✅ Done     | 8 repos (clients, ledger, kv, traffic, tracking, payments, documents, sim)   |
| Stage 3: routers → src/routes/*        | ✅ Done     | 18 routers; latent dep-injection gaps closed (commit 9834016)                |
| Stage 4a: billingLedger removed        | ✅ Done     | Commit 079633c. Integrity test in tests/billing-ledger-integrity.test.js     |
| Stage 4b: src/state/index.js           | ✅ Done     | Commit dc12b9d — clients + 5 maps centralized; shim objects gone             |
| Stage 5: inline JS extracted           | ✅ Done     | admin.js, client.js, client-portal.css separated                             |
| Stage 5 phase 2: onclick → delegation  | ⏳ Deferred | (Stage 11) — CSP allowlist active; migration backlog below                   |
| Stage 6: lint + dead code + docs       | ✅ Done     | 0 lint errors across server.js + src/ (DoD #3)                               |
| Stage 7: traffic-unit divergence       | ✅ Done     | utils.js decimal; admin+client load it; +8 lock tests (commit aa51500)       |
| Stage 8: finish SQL extraction         | ✅ Done     | 59 → 36 inline (rest are intentional). Commit a77c7ea                        |
| Stage 9: shrink server.js              | ⏳ Partial  | 11,193 → 4,607 (−59%); <250 target documented as multi-day. See backlog      |
| Stage 10: verify billingLedger removal | ✅ Done     | Audit + integrity test + FOLLOWUP synced (commit 0458c0a)                    |
| Stage 11: drop script-src-attr unsafe-inline | ⏳ Deferred | Per TZ "трудоёмкий и чисто фронтовый, можно отложить отдельно"             |
| Stage 12: prod hardening               | ✅ Done     | Tochka key + machine-id, schema policy, test logger silence, ESLint config   |
| DoD #1: server.js < 250 lines          | ⏳ Partial  | 4,607 lines. <250 needs the deferred extractions below                       |
| DoD #2: > 70 tests                     | ✅ Done     | 83 tests across 13 files                                                     |
| DoD #3: 0 ESLint errors                | ✅ Done     | Whole tree (server.js + src/ + tests/ + vitest.config.js) zero-error         |
| DoD #7: route snapshot matches         | ✅ Done     | Locked at 168 routes; trips on any new/dropped route                         |

## Backlog: src/jobs extraction (DoD #1 path)

server.js is at 4,607 lines vs. the TZ's <250 aspirational target.
Stages so far extracted: cleanup.js (−225), tochka-cron.js (−245),
top-hosts.js (−113), crm-sync.js (−38). Cumulative: −621 from the
post-Stage-6 baseline of 5,160.

Remaining extraction targets (by line count, biggest wins first):

| Target function                  | Lines | Extract to                  | Risk   |
|----------------------------------|------:|-----------------------------|--------|
| `_runDailyBillingImpl`           |   215 | `src/jobs/daily-billing.js` | HIGH   |
| `trackModems`                    |   162 | `src/jobs/modem-monitor.js` | MED    |
| `runMonthlyReconciliation`       |    95 | `src/jobs/daily-billing.js` | HIGH   |
| `checkProxyLatency`              |    82 | `src/jobs/modem-monitor.js` | LOW    |
| `runNightlySpeedtests`           |    78 | `src/jobs/speedtest.js`     | LOW    |
| `injectOfflineModems`            |    69 | `src/services/modems.js`    | LOW    |
| `mergeServerData`                |    68 | `src/services/proxy-data.js`| MED    |
| `runSlaCheck`                    |    61 | `src/jobs/sla.js`           | LOW    |
| `runAutoReboot`                  |    60 | `src/jobs/auto-reboot.js`   | MED    |
| `updateKnownModems`              |    50 | `src/services/modems.js`    | LOW    |
| `computeProxyIssues`             |    45 | `src/services/proxy-data.js`| LOW    |
| `computeClientSlaMetrics`        |    43 | `src/jobs/sla.js`           | LOW    |

Extracting the LOW/MED-risk set ≈ −710 lines (server.js → ~3,900).
Touching `_runDailyBillingImpl` and `runMonthlyReconciliation` is HIGH
risk because they're the billing math — moving them needs a dedicated
day with all billing tests re-run after every callsite swap.

To hit <250 also requires: state declarations (`dailyTraffic`,
`ipTracking`, `uptimeTracking`, `apiServers`, `appSettings`,
`tochkaConfig`, `portKeyToPortName`, `knownModems`, `users` — still
mutable globals; see "src/state/index.js deferred state" below), the
cron schedule (8 `setInterval` calls), proxy/server data helpers
(`mergeServerData`, `fetchApi`, `saveApiServersToDb`), and the
migration runner (~100 lines). Multi-day work overall.

**Why deferred:** the TZ rule "один этап = один коммит, тесты как
ворота" means each extraction needs its own commit + green test run.
Doing 12 more extractions safely is ~2 working days; the user
prioritized behavior-preserving completion of every other Stage first.

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
