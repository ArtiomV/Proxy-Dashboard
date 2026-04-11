'use strict';

const fs = require('fs');
const fsPromises = fs.promises;
const path = require('path');

const _fileLocks = new Map();

/**
 * Atomically write file: write to .tmp, then rename.
 * Serializes writes to the same file path.
 */
function safeWriteFile(filePath, data, logger) {
  const prev = _fileLocks.get(filePath) || Promise.resolve();
  const next = prev.then(async () => {
    const tmp = filePath + '.tmp';
    try {
      await fsPromises.writeFile(tmp, data, 'utf8');
      await fsPromises.rename(tmp, filePath);
    } catch (e) {
      try { await fsPromises.unlink(tmp); } catch (_) {}
      if (logger) logger.error(`[safeWriteFile] Error writing ${path.basename(filePath)}:`, e.message);
    }
  }).catch(() => {}).finally(() => {
    if (_fileLocks.get(filePath) === next) _fileLocks.delete(filePath);
  });
  _fileLocks.set(filePath, next);
  return next;
}

module.exports = { safeWriteFile, _fileLocks };
