// Pure logic for kv_store loss-prevention:
//   - shape descriptors per critical key
//   - shape-regression detection
//   - env↔DB server metadata merge
//
// Extracted from server.js so it can be unit-tested without spinning up SQLite.
// The DB-bound wrapper (kvSetCritical) stays in server.js.

// Fields that env declares on api_servers entries (connection-level identity).
// DB-stored values for these fields are ignored at merge time (env wins).
const ENV_OWNED_FIELDS = ['url', 'user', 'pass', 'publicIp'];

// Fields that DB owns (set via the admin UI). These must be merged INTO env
// entries on startup, otherwise the next saveApiServersToDb() persists the
// impoverished env-only version and wipes them. See incident 2026-05-20.
const DB_META_FIELDS = ['osLogin', 'osPassword', 'hardware', 'address', 'country', 'countryName', 'tz'];

// Per-key shape descriptors. Each function receives the raw JSON string and
// returns a numeric "fill level" object. Shape comparison flags any numeric
// field that decreased — that's our silent-data-loss signal.
const KV_CRITICAL_SHAPES = {
  api_servers: (raw) => {
    let arr;
    try { arr = JSON.parse(raw); } catch (_) { return { invalid: true, count: 0 }; }
    if (!Array.isArray(arr)) return { invalid: true, count: 0 };
    const counts = {
      count: arr.length,
      address: 0, hardware: 0, country: 0,
      osLogin: 0, osPassword: 0,
      panelUser: 0, panelPassword: 0,
    };
    for (const s of arr) {
      if (s.address)    counts.address++;
      if (s.hardware)   counts.hardware++;
      if (s.country)    counts.country++;
      if (s.osLogin)    counts.osLogin++;
      if (s.osPassword) counts.osPassword++;
      if (s.user || s.panelUser)     counts.panelUser++;
      if (s.pass || s.panelPassword) counts.panelPassword++;
    }
    return counts;
  },
  app_settings: (raw) => {
    let obj;
    try { obj = JSON.parse(raw); } catch (_) { return { invalid: true, keys: 0 }; }
    return { keys: obj && typeof obj === 'object' ? Object.keys(obj).length : 0 };
  },
};

// Compare two shape descriptors. Returns array of regressions
// ({field, before, after}). Empty array = no regression.
// Invalid shapes are skipped (treated as "we can't reason about them").
function shapeRegressions(before, after) {
  if (!before || before.invalid || !after || after.invalid) return [];
  const regs = [];
  for (const k of Object.keys(before)) {
    if (typeof before[k] !== 'number') continue;
    const b = before[k];
    const a = typeof after[k] === 'number' ? after[k] : 0;
    if (b > 0 && a < b) regs.push({ field: k, before: b, after: a });
  }
  return regs;
}

// Merge DB-stored server metadata into the env-defined servers list, IN PLACE.
// New servers (DB-only) get appended. Env-defined servers get metadata fields
// populated from DB only where they're currently absent (env owns connection).
function mergeDbMetadataIntoEnvServers(envServers, dbServers, metaFields) {
  const fields = metaFields || DB_META_FIELDS;
  for (const s of dbServers) {
    const existing = envServers.find(e => e.name === s.name);
    if (!existing) {
      envServers.push(s);
      continue;
    }
    for (const k of fields) {
      if (s[k] !== undefined && s[k] !== '' && existing[k] == null) {
        existing[k] = s[k];
      }
    }
  }
  return envServers;
}

module.exports = {
  ENV_OWNED_FIELDS,
  DB_META_FIELDS,
  KV_CRITICAL_SHAPES,
  shapeRegressions,
  mergeDbMetadataIntoEnvServers,
};
