'use strict';

const fs = require('fs');
const fsPromises = fs.promises;
const path = require('path');

const _fileLocks = new Map();

/**
 * Atomically write file: write to .tmp, then rename.
 * Serializes writes to the same file path.
 */
// Disk-space alert state: throttle ENOSPC log spam (only first occurrence per minute).
let _lastEnospcLog = 0;

function safeWriteFile(filePath, data, logger) {
  // Wait for the previous write to this path to SETTLE (success or failure) but
  // don't inherit its rejection — one failed write must not poison the next.
  const prev = _fileLocks.get(filePath) || Promise.resolve();
  // `work` is the real write. It REJECTS on failure so an `await safeWriteFile(…)`
  // caller can actually react (P1-2: the old code applied .catch BEFORE returning,
  // so the returned promise never rejected and "Re-throw so callers can react"
  // was a lie). Fire-and-forget callers must attach their own .catch — every
  // current caller (saveKnownModems/saveServerCache/…) already does.
  const work = prev.catch(() => {}).then(async () => {
    const tmp = filePath + '.tmp';
    try {
      await fsPromises.writeFile(tmp, data, 'utf8');
      await fsPromises.rename(tmp, filePath);
    } catch (e) {
      try { await fsPromises.unlink(tmp); } catch (_) { /* best-effort */ }
      // ENOSPC = disk full; surface as critical so it's visible in dashboards
      // and Telegram alerts (system_log subscription). Throttle to 1/min to
      // avoid log-storm when 100 writes fail in a row.
      const isEnospc = e && (e.code === 'ENOSPC' || /no space left/i.test(e.message || ''));
      if (isEnospc) {
        const now = Date.now();
        if (now - _lastEnospcLog > 60000) {
          _lastEnospcLog = now;
          if (logger) logger.fatal(`[safeWriteFile] DISK FULL writing ${path.basename(filePath)}: ${e.message}`);
        }
      } else if (logger) {
        logger.error(`[safeWriteFile] Error writing ${path.basename(filePath)}: ${e.message}`);
      }
      throw e;  // propagates to the returned promise (and the caller's .catch)
    }
  });
  // The lock-chain link is a SWALLOWING view of `work`, so the next queued write
  // (which awaits this via `prev`) isn't blocked by a rejection, and the lock
  // entry is cleaned up once this is the latest write. NOT returned to the caller.
  const lockEntry = work.catch(() => {}).finally(() => {
    if (_fileLocks.get(filePath) === lockEntry) _fileLocks.delete(filePath);
  });
  _fileLocks.set(filePath, lockEntry);
  return work;  // caller gets the REAL, rejecting promise
}

module.exports = { safeWriteFile, _fileLocks };
