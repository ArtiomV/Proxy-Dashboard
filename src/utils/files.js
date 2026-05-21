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
  const prev = _fileLocks.get(filePath) || Promise.resolve();
  const next = prev.then(async () => {
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
      // Re-throw so callers can react (e.g. avoid showing stale data as "saved").
      throw e;
    }
  }).catch(() => { /* swallow re-throw for fire-and-forget callers */ }).finally(() => {
    if (_fileLocks.get(filePath) === next) _fileLocks.delete(filePath);
  });
  _fileLocks.set(filePath, next);
  return next;
}

module.exports = { safeWriteFile, _fileLocks };
