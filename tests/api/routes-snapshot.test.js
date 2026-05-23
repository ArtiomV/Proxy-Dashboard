// Snapshot of every route registered on the Express app. The main safety
// net for Stage 3 — when routes get extracted into src/routes/*.js as
// Router factories, this test confirms the resulting URL/method set is
// identical to the pre-refactor monolith.
//
// To intentionally accept a change (new route added, route renamed, etc.)
// re-run with UPDATE_SNAPSHOT=1 and commit the updated JSON. The diff
// shows exactly what shifted.

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { bootApp } from '../_helpers/app.js';

const SNAPSHOT_PATH = path.join(__dirname, '__snapshots__', 'routes.json');

// Walk an Express app's internal router stack and emit every (method, path)
// pair. Express represents Router middleware as layer.handle.stack (recursive).
function collectRoutes(app) {
  const routes = [];
  const visit = (stack, prefix = '') => {
    for (const layer of stack) {
      if (layer.route && layer.route.path) {
        const methods = Object.keys(layer.route.methods).filter(m => layer.route.methods[m]);
        const fullPath = prefix + layer.route.path;
        for (const method of methods) {
          routes.push(`${method.toUpperCase()} ${fullPath}`);
        }
      } else if (layer.name === 'router' && layer.handle && layer.handle.stack) {
        // Sub-router mounted via app.use('/prefix', router)
        const mountPath = (layer.regexp && layer.regexp.source !== '^\\/?(?=\\/|$)')
          ? extractMountPath(layer.regexp)
          : '';
        visit(layer.handle.stack, prefix + mountPath);
      }
    }
  };
  visit(app._router ? app._router.stack : app.router.stack);
  return routes.sort();
}

// Express stores the mount path as a regex like `/^\/api\/?(?=\/|$)/i`.
// Extract back the literal path. Best-effort — if the regex doesn't match
// the expected shape, returns empty (caller treats as root mount).
function extractMountPath(re) {
  const m = re.source.match(/^\\\/([^\\?(]+)/);
  return m ? '/' + m[1].replace(/\\\//g, '/') : '';
}

describe('routes snapshot', () => {
  it('matches the locked-in set of (method, path) pairs', () => {
    const { app } = bootApp();
    const routes = collectRoutes(app);

    fs.mkdirSync(path.dirname(SNAPSHOT_PATH), { recursive: true });

    if (process.env.UPDATE_SNAPSHOT === '1' || !fs.existsSync(SNAPSHOT_PATH)) {
      fs.writeFileSync(SNAPSHOT_PATH, JSON.stringify(routes, null, 2) + '\n');
      // First run / explicit refresh — accept and report.
      console.log(`[routes-snapshot] wrote ${routes.length} routes to ${SNAPSHOT_PATH}`);
      return;
    }

    const expected = JSON.parse(fs.readFileSync(SNAPSHOT_PATH, 'utf8'));
    // Diffing as sets gives a clean "added"/"removed" report instead of a
    // wall-of-text array compare.
    const expectedSet = new Set(expected);
    const actualSet = new Set(routes);
    const added = routes.filter(r => !expectedSet.has(r));
    const removed = expected.filter(r => !actualSet.has(r));

    if (added.length || removed.length) {
      const msg = [
        `Route set drifted from snapshot at ${SNAPSHOT_PATH}.`,
        `If this is intentional, re-run with UPDATE_SNAPSHOT=1 to refresh.`,
        ...(added.length ? ['', 'Added:', ...added.map(r => '  + ' + r)] : []),
        ...(removed.length ? ['', 'Removed:', ...removed.map(r => '  - ' + r)] : []),
      ].join('\n');
      throw new Error(msg);
    }
    expect(routes.length).toBe(expected.length);
  });
});
