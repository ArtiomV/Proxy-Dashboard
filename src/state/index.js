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
// What lives here (Stage 4 scope):
//   - clients[] + 5 derived maps (clientById, clientByLogin, clientByApiKey,
//     clientByInn, clientByResetToken)
//
// What still lives in server.js (deferred to a follow-up — these have
// 100s of callsites and migrating them safely needs a separate pass):
//   - dailyTraffic, ipTracking, uptimeTracking, ipHistory
//   - apiServers, appSettings, tochkaConfig
//   - portKeyToPortName, knownModems, users
//
// Why split this way: the clients + maps were the worst offender — every
// rebuildClientMaps() call rebound the bindings and required shim objects
// in 12+ route mount calls. Migrating them removes the most fragile bit
// of the Stage 3 plumbing.

const state = {
  clients: [],
  clientById: new Map(),
  clientByLogin: new Map(),
  clientByApiKey: new Map(),
  clientByInn: new Map(),
  clientByResetToken: new Map(),
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

module.exports = { state, setClients, rebuildMaps };
