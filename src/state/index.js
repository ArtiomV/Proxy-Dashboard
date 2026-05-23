'use strict';
//
// src/state/index.js — process-wide mutable state (Stage 4 finish).
//
// Centralizes the "live state" of the system into a single module so that
// (a) tests can prime it without monkey-patching server.js globals, and
// (b) router factories can capture raw Map/Array references at mount time
// without lazy-wrapper getters (the previous Stage 3 workaround).
//
// Invariants worth defending:
//
//   1. Object identity is stable across reloads.
//      `state.clientById` is the SAME Map object for the entire process
//      lifetime. Routers can `const clientById = state.clientById` at
//      mount time and never need to rebind. The old Stage 3 trick of
//      passing `{ get: (k) => clientById.get(k) }` shims becomes
//      unnecessary.
//
//   2. setClients() replaces the array CONTENTS, not the array binding.
//      `state.clients.length = 0; state.clients.push(...arr)` rather than
//      `state.clients = arr`. Same reason — anyone holding a reference to
//      the array sees the new contents on the next iteration.
//
//   3. rebuildMaps() CLEARS + REPOPULATES the existing Maps. Same reason.
//
// What lives here:
//   Stage 4 scope — clients[] + 5 derived maps (clientById, clientByLogin,
//   clientByApiKey, clientByInn, clientByResetToken).
//
//   Stage 14.1 additions — the remaining object globals that previously
//   sat as `let` bindings in server.js. Each was a latent rebind bug:
//   server.js mutates `appSettings = {...}` on reload, and any router
//   that captured the old reference saw stale data. Moving them into
//   `state` and mutating in place via replaceObject() preserves the
//   reference for the entire process lifetime:
//   - dailyTraffic, ipTracking, uptimeTracking, ipHistory
//   - appSettings, knownModems, tochkaConfig, portKeyToPortName
//
// What still lives in server.js (intentional — single-binding):
//   - apiServers (Array), users (Map) — never rebound; safe as-is.
//
// Why this split matters: the clients + maps were the worst offender —
// every rebuildClientMaps() call rebound the bindings and required shim
// objects in 12+ route mount calls. The object globals here have the
// same shape of bug; replaceObject() makes the rebind impossible by
// construction.

// replaceObject(target, src) — mutate `target` in place so its keys
// equal `src`'s. Identity of `target` is preserved (no rebind), which
// is the entire point of this module's contract.
function replaceObject(target, src) {
  if (!target || typeof target !== 'object') throw new Error('replaceObject: target must be an object');
  for (const k of Object.keys(target)) delete target[k];
  if (src && typeof src === 'object') Object.assign(target, src);
}

const state = {
  // Stage 4
  clients: [],
  clientById: new Map(),
  clientByLogin: new Map(),
  clientByApiKey: new Map(),
  clientByInn: new Map(),
  clientByResetToken: new Map(),
  // Stage 14.1
  dailyTraffic: {},
  ipTracking: {},
  uptimeTracking: {},
  ipHistory: {},
  appSettings: {},
  knownModems: {},
  tochkaConfig: {},
  portKeyToPortName: {},
};

// Replace the clients array CONTENTS in place. Used both at boot
// (loadClients() result) and after persistent writes (saveClients →
// rehydrate from disk).
function setClients(arr) {
  state.clients.length = 0;
  for (const c of arr) state.clients.push(c);
}

// Clear + repopulate all derived maps in place. Run after any change
// to state.clients (push, splice, setClients).
function rebuildMaps() {
  state.clientById.clear();
  state.clientByLogin.clear();
  state.clientByApiKey.clear();
  state.clientByInn.clear();
  state.clientByResetToken.clear();
  for (const c of state.clients) {
    if (c.id) state.clientById.set(c.id, c);
    if (c.login) state.clientByLogin.set(c.login, c);
    if (c.apiKey) state.clientByApiKey.set(c.apiKey, c);
    if (c.inn) state.clientByInn.set(c.inn, c);
    if (c.resetToken) state.clientByResetToken.set(c.resetToken, c);
  }
}

// Convenience named setters for the Stage 14.1 globals. Each is a thin
// wrapper around replaceObject(state.X, src) — the named helpers exist
// so callsites read intent ("setAppSettings(...)" vs the generic
// "replaceObject(state.appSettings, ...)").
function setAppSettings(src)       { replaceObject(state.appSettings, src); }
function setTochkaConfig(src)      { replaceObject(state.tochkaConfig, src); }
function setKnownModems(src)       { replaceObject(state.knownModems, src); }
function setPortKeyToPortName(src) { replaceObject(state.portKeyToPortName, src); }
function setDailyTraffic(src)      { replaceObject(state.dailyTraffic, src); }
function setIpTracking(src)        { replaceObject(state.ipTracking, src); }
function setUptimeTracking(src)    { replaceObject(state.uptimeTracking, src); }
function setIpHistory(src)         { replaceObject(state.ipHistory, src); }

module.exports = {
  state, setClients, rebuildMaps, replaceObject,
  setAppSettings, setTochkaConfig, setKnownModems, setPortKeyToPortName,
  setDailyTraffic, setIpTracking, setUptimeTracking, setIpHistory,
};
