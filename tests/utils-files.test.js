// P1-2 — safeWriteFile must REJECT on write failure (the old code applied a
// .catch before returning, so the promise never rejected and awaiting callers
// could never tell a write failed). Also verifies the per-path lock isn't
// poisoned by a failed write.
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';

const cjsRequire = createRequire(import.meta.url);
const { safeWriteFile } = cjsRequire('../src/utils/files.js');
const noopLogger = { error() {}, fatal() {}, warn() {}, info() {} };

describe('safeWriteFile', () => {
  it('writes atomically and resolves on success', async () => {
    const fp = path.join(os.tmpdir(), 'swf_ok_' + Date.now() + '.txt');
    await safeWriteFile(fp, 'hello', noopLogger);
    expect(fs.readFileSync(fp, 'utf8')).toBe('hello');
    fs.unlinkSync(fp);
  });

  it('REJECTS when the target directory does not exist (P1-2)', async () => {
    const bad = path.join(os.tmpdir(), 'swf_nodir_' + Date.now(), 'sub', 'x.txt');
    await expect(safeWriteFile(bad, 'x', noopLogger)).rejects.toBeTruthy();
  });

  it('a rejected write releases the lock — the next write to the same path still works', async () => {
    const dir = path.join(os.tmpdir(), 'swf_poison_' + Date.now());
    const fp = path.join(dir, 'x.txt');
    await expect(safeWriteFile(fp, 'first', noopLogger)).rejects.toBeTruthy(); // dir missing → fail
    fs.mkdirSync(dir, { recursive: true });
    await safeWriteFile(fp, 'second', noopLogger);                            // same path → must succeed
    expect(fs.readFileSync(fp, 'utf8')).toBe('second');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('serializes writes to the same path (last write wins)', async () => {
    const fp = path.join(os.tmpdir(), 'swf_serial_' + Date.now() + '.txt');
    await Promise.all([
      safeWriteFile(fp, 'a', noopLogger),
      safeWriteFile(fp, 'b', noopLogger),
      safeWriteFile(fp, 'c', noopLogger),
    ]);
    expect(fs.readFileSync(fp, 'utf8')).toBe('c');
    fs.unlinkSync(fp);
  });
});
