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

## Stage 4 — billingLedger in-memory mirror (deferred)

**The main bug is fixed** (atomic.js stale `clientById` getter pattern — Stage 4
✅). What's still pending is the TZ's "убрать billingLedger из памяти как
полное зеркало БД": today `billingLedger = {}` in server.js loads the
entire history on startup and grows unbounded with each credit/debit.

Why it's deferred:
  - 8 callsites read `billingLedger[clientId]` directly in routes
    (clients.js, tochka.js, ops.js, client-portal.js, ops-ext.js) and
    iterate JS objects with already-typed fields (delta_gb, delta_bytes
    in JSON, etc.)
  - The DB row stores the same data but with different column layout +
    the optional fields live in a `details` JSON column.
  - Naive swap to `ledgerDb.listByClient(id)` is correct in shape but
    changes the per-entry object identity in a few places that compare
    by reference. TZ explicitly flags this as the "самый рискованный
    пункт" — strongly suggests doing it as a focused, scoped commit
    with all billing tests re-run between every callsite swap.

Plan when this is picked up:
  1. Add `listByClient(clientId)` in src/db/ledger.js that returns DB
     rows mapped to the in-memory shape (parse `details` JSON, fold
     into top-level fields).
  2. One callsite at a time: replace `billingLedger[id]` with the
     repo call. Run tests after each. 5 commits, 5 reviews.
  3. Drop the in-memory write from atomic.js (now redundant).
  4. Drop `let billingLedger` + the startup load from server.js.
  5. Add a startup integrity test: count of DB rows = sum of historical
     entries to catch any drift.

Until then: in-memory mirror is small (a few MB) and not a hot-path
performance issue. The HTTP-balance-mismatch bug that motivated Stage 4
is already fixed via the atomic.js getter — leftover memory growth is
the only outstanding concern, and it's bounded by client count × entries
which is manageable for the current scale.

## Stage 5 — phase 2 (not yet done)

- **CSP not restored.** server.js still has `helmet({ contentSecurityPolicy:
  false })`. After JS extraction (✅ done) the next blocker is the dozens
  of inline `onclick="…"` attributes in dynamically-generated HTML inside
  admin.js. To turn CSP on without breaking them: either (a) replace all
  with event delegation, (b) allow them via `script-src-attr 'unsafe-inline'`
  in the policy. Pragmatic: ship (b) now, migrate to (a) progressively.

- **client-portal.css :root may diverge from admin's variables.css.**
  index.html's CSS was lifted into a new client-portal.css with its own
  `:root { --bg-0, --accent, … }` block. variables.css has the admin
  versions of the same tokens. If a theme color changes in one file but
  not the other, the two SPAs drift visually. Future tidy: merge the
  shared subset into variables.css, keep client-only tokens in
  client-portal.css.

- **admin.js + client.js could share a small "common" module** for
  things like `apiFetch`, `authToken` handling, theme persistence. Today
  there's some duplication. Not urgent — utils.js dedup already covered
  the hottest helpers (esc, parseTraffic, fmtGb).

## Behavior questions to confirm before changing

- The `BENIGN_MIGRATION_ERRORS` regex set includes `/no such column/i` with a
  hand-wavey comment about "safe for UPDATE re-runs". Verify on a specific
  failing migration before relying on this — currently the runner will pass
  over a real schema bug if it manifests as `no such column`.
