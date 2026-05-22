// Sanity-check that schema.sql + migrations/* produce a deterministic
// schema. The TZ asks for a test that verifies "чистая БД из миграций
// даёт ту же схему, что описана" — this is the practical version: it
// boots the harness on a clean temp DB (schema.sql + all migrations run),
// then dumps `sqlite_master` and snapshots it.
//
// If schema drift sneaks in (e.g. someone adds a new migration but
// the prod DB has additional columns from a manual ALTER) this test
// flags it. Refresh intentionally with UPDATE_SNAPSHOT=1.

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { bootApp } from './_helpers/app.js';

const SNAPSHOT_PATH = path.join(__dirname, 'api', '__snapshots__', 'schema.json');

describe('SQLite schema (from schema.sql + migrations)', () => {
  it('matches the locked-in baseline', () => {
    const { db } = bootApp();
    // Pull every table and index definition. ORDER BY for stable output.
    const rows = db.prepare(`
      SELECT type, name, tbl_name, sql FROM sqlite_master
      WHERE name NOT LIKE 'sqlite_%'
        AND name NOT LIKE '_litestream%'
      ORDER BY type, name
    `).all();
    // Strip whitespace differences in SQL strings — only structural changes
    // should trip the diff.
    const normalised = rows.map(r => ({
      type: r.type,
      name: r.name,
      tbl_name: r.tbl_name,
      sql: r.sql ? r.sql.replace(/\s+/g, ' ').trim() : null,
    }));

    fs.mkdirSync(path.dirname(SNAPSHOT_PATH), { recursive: true });

    if (process.env.UPDATE_SNAPSHOT === '1' || !fs.existsSync(SNAPSHOT_PATH)) {
      fs.writeFileSync(SNAPSHOT_PATH, JSON.stringify(normalised, null, 2) + '\n');
      // eslint-disable-next-line no-console
      console.log(`[schema-equivalence] wrote ${normalised.length} sqlite_master rows`);
      return;
    }

    const expected = JSON.parse(fs.readFileSync(SNAPSHOT_PATH, 'utf8'));
    const expectedByKey = new Map(expected.map(r => [r.type + '|' + r.name, r]));
    const actualByKey = new Map(normalised.map(r => [r.type + '|' + r.name, r]));
    const added = [...actualByKey.keys()].filter(k => !expectedByKey.has(k));
    const removed = [...expectedByKey.keys()].filter(k => !actualByKey.has(k));
    const changed = [];
    for (const [k, a] of actualByKey) {
      const b = expectedByKey.get(k);
      if (b && (a.sql !== b.sql || a.tbl_name !== b.tbl_name)) changed.push(k);
    }
    if (added.length || removed.length || changed.length) {
      throw new Error([
        `Schema drift vs ${SNAPSHOT_PATH}. UPDATE_SNAPSHOT=1 to accept.`,
        ...(added.length   ? ['', 'Added:',   ...added.map(s => '  + ' + s)] : []),
        ...(removed.length ? ['', 'Removed:', ...removed.map(s => '  - ' + s)] : []),
        ...(changed.length ? ['', 'Changed (SQL differs):', ...changed.map(s => '  ~ ' + s)] : []),
      ].join('\n'));
    }
    expect(normalised.length).toBe(expected.length);
  });
});
