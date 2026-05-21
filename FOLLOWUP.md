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

## Behavior questions to confirm before changing

- The `BENIGN_MIGRATION_ERRORS` regex set includes `/no such column/i` with a
  hand-wavey comment about "safe for UPDATE re-runs". Verify on a specific
  failing migration before relying on this — currently the runner will pass
  over a real schema bug if it manifests as `no such column`.
