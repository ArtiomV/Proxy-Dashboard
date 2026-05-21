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

- **`atomicCredit` / `atomicDebit` keep a stale `clientById` reference after
  `rebuildClientMaps()`.** server.js does
  `billing.init({ ..., clientById })`, but later `rebuildClientMaps()`
  reassigns the *binding* `clientById = new Map(...)` (a fresh Map). Billing's
  closure still points at the original (now-empty) Map, so after a
  `rebuildClientMaps()` (triggered by any client create/update/delete) the
  `if (client) client.balance = balanceAfter` line in atomic.js is a no-op.
  **Effect:** `/api/admin/clients/:id/payment` and friends return
  `{ balance: 0 }` in the HTTP body even though the DB row updates correctly.
  The DB is authoritative — money accounting is fine — but the API contract
  is broken until the next server restart.
  Fix candidate (Stage 4): wrap the binding in a getter
  (`init({ getClientById: () => clientById })`), or reassign the Map's
  contents instead of the binding in rebuildClientMaps. Tests in
  `tests/api/clients.test.js` work around this by asserting DB balance
  instead of response body balance.

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

## Behavior questions to confirm before changing

- The `BENIGN_MIGRATION_ERRORS` regex set includes `/no such column/i` with a
  hand-wavey comment about "safe for UPDATE re-runs". Verify on a specific
  failing migration before relying on this — currently the runner will pass
  over a real schema bug if it manifests as `no such column`.
