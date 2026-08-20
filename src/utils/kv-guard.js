// Pure logic for kv_store loss-prevention:
//   - shape descriptors per critical key
//   - shape-regression detection
//   - env↔DB server metadata merge
//
// Extracted from server.js so it can be unit-tested without spinning up SQLite.
// The DB-bound wrapper (kvSetCritical) stays in server.js.

// Fields that env declares on api_servers entries (connection-level identity).
// url/publicIp: env still wins (network topology lives in .env).
// user/pass — НЕ env-owned: UI-редактирование (Настройки → серверы) пишет их в
// DB, и они обязаны переживать pm2-рестарт. До 2026-08-17 env выигрывал и при
// каждом рестарте затирал пароль, введённый через админку, — «меняю пароль,
// а он через время сбрасывается». env теперь лишь bootstrap-дефолт для первого
// запуска (когда в DB ещё пусто).
const ENV_OWNED_FIELDS = ['url', 'publicIp'];
const DB_CRED_FIELDS = ['user', 'pass'];

// Fields that DB owns (set via the admin UI). These must be merged INTO env
// entries on startup, otherwise the next saveApiServersToDb() persists the
// impoverished env-only version and wipes them. See incident 2026-05-20.
const DB_META_FIELDS = ['osLogin', 'osPassword', 'sshPort', 'hardware', 'address', 'country', 'countryName', 'tz'];

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
  // D1: tochka_config переехал из tochka_config.json в kv_store (см. server.js
  // saveTochkaConfig). Формат: JSON-объект, каждое непустое значение —
  // 'enc1:' + AES-256-GCM (per-field, как SENSITIVE_SETTINGS). Shape считает
  // только число полей: затирание конфига пустым/усечённым объектом ловится
  // как регресс, а легальная очистка отдельного поля через админку — нет.
  tochka_config: (raw) => {
    let obj;
    try { obj = JSON.parse(raw); } catch (_) { return { invalid: true, keys: 0 }; }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { invalid: true, keys: 0 };
    return { keys: Object.keys(obj).length };
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
// populated from DB only where they're currently absent. Credentials
// (user/pass) are DB-wins-if-nonempty: the Settings UI is the primary edit
// path and its values must survive restarts (see DB_CRED_FIELDS note above).
function mergeDbMetadataIntoEnvServers(envServers, dbServers, metaFields) {
  const fields = metaFields || DB_META_FIELDS;
  for (const s of dbServers) {
    const existing = envServers.find(e => e.name === s.name);
    if (!existing) {
      envServers.push(s);
      continue;
    }
    for (const k of DB_CRED_FIELDS) {
      if (s[k] !== undefined && s[k] !== '') existing[k] = s[k];
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
  DB_CRED_FIELDS,
  DB_META_FIELDS,
  KV_CRITICAL_SHAPES,
  shapeRegressions,
  mergeDbMetadataIntoEnvServers,
};
