import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';
import zlib from 'zlib';
const require = createRequire(import.meta.url);
const { gzipFile } = require('../src/jobs/backup');

describe('atomic backup compression', () => {
  it('keeps the previous archive when compression cannot start', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-atomic-'));
    const source = path.join(dir, 'missing.db');
    const archive = source + '.gz';
    fs.writeFileSync(archive, zlib.gzipSync(Buffer.from('previous')));
    const before = fs.readFileSync(archive);
    await expect(gzipFile(source)).rejects.toThrow();
    expect(fs.readFileSync(archive)).toEqual(before);
    expect(fs.readdirSync(dir).some(f => f.endsWith('.partial'))).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('publishes a valid archive and removes the source only after success', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-atomic-'));
    const source = path.join(dir, 'snapshot.db');
    fs.writeFileSync(source, Buffer.from('snapshot-data'));
    const archive = await gzipFile(source);
    expect(zlib.gunzipSync(fs.readFileSync(archive)).toString()).toBe('snapshot-data');
    expect(fs.existsSync(source)).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
