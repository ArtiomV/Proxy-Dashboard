'use strict';
//
// src/db/simulator.js — repository for the load-simulator tables.
//
// Stage 2 of the refactor moves inline `db.prepare(...)` calls out of
// server.js into per-domain modules. This file owns:
//   - modem_meta.is_test_pool toggles (test-pool management)
//   - simulator_profiles CRUD
//   - simulator_runs reads (writes still live in src/simulator/engine.js
//     because they happen inside the engine's transaction scope)
//   - simulator_samples reads (writes also in engine.js)
//
// Prepared statements are module-private — callers use the named exports
// below. No `db.prepare()` should appear in server.js for these tables
// after this commit.

let db;
const S = {};   // private prepared statements, lazy-inited

function init(database) {
  db = database;
  S.testPoolKeys = db.prepare(
    "SELECT server_name || '|' || nick AS k FROM modem_meta WHERE is_test_pool = 1"
  );
  S.testPoolExists = db.prepare(
    'SELECT 1 FROM modem_meta WHERE server_name = ? AND nick = ? LIMIT 1'
  );
  S.testPoolInsert = db.prepare(
    "INSERT INTO modem_meta (server_name, nick, imei, operator, is_test_pool, updated_at) " +
    "VALUES (?, ?, ?, ?, ?, datetime('now'))"
  );
  S.testPoolUpdate = db.prepare(
    "UPDATE modem_meta SET is_test_pool = ?, updated_at = datetime('now') " +
    'WHERE server_name = ? AND nick = ?'
  );
  S.testPoolList = db.prepare(
    'SELECT server_name, nick, operator, model, phone FROM modem_meta ' +
    'WHERE is_test_pool = 1 ORDER BY server_name, nick'
  );

  S.profilesList = db.prepare(
    'SELECT id, name, description, config_json, created_at, created_by, updated_at ' +
    'FROM simulator_profiles ORDER BY name'
  );
  S.profileInsert = db.prepare(
    'INSERT INTO simulator_profiles (name, description, config_json, created_by) ' +
    'VALUES (?, ?, ?, ?) RETURNING id'
  );
  S.profileById = db.prepare('SELECT * FROM simulator_profiles WHERE id = ?');
  S.profileByIdForRun = db.prepare(
    'SELECT id, name, config_json FROM simulator_profiles WHERE id = ?'
  );
  S.profileUpdate = db.prepare(
    "UPDATE simulator_profiles SET name = ?, description = ?, config_json = ?, " +
    "updated_at = datetime('now') WHERE id = ?"
  );
  S.profileDelete = db.prepare('DELETE FROM simulator_profiles WHERE id = ?');

  S.runsList = db.prepare(
    'SELECT id, profile_id, profile_name, started_at, ended_at, status, ' +
    'summary_json, started_by, error_msg FROM simulator_runs ' +
    'ORDER BY started_at DESC LIMIT ? OFFSET ?'
  );
  S.runById = db.prepare('SELECT * FROM simulator_runs WHERE id = ?');
  S.runConfigById = db.prepare('SELECT config_json FROM simulator_runs WHERE id = ?');

  S.samplesPaginated = db.prepare(
    'SELECT ts_ms, worker_id, modem_nick, server_name, status, http_status, ' +
    'total_ms, connect_ms, ttfb_ms, bytes, url, error_msg ' +
    'FROM simulator_samples WHERE run_id = ? ORDER BY ts_ms LIMIT ? OFFSET ?'
  );
  S.samplesCount = db.prepare('SELECT COUNT(*) AS n FROM simulator_samples WHERE run_id = ?');
  S.samplesAll = db.prepare(
    'SELECT modem_nick, server_name, status, total_ms, connect_ms, ttfb_ms ' +
    'FROM simulator_samples WHERE run_id = ?'
  );
  S.samplesSeries = db.prepare(
    'SELECT ts_ms, status, total_ms, connect_ms, ttfb_ms FROM simulator_samples ' +
    'WHERE run_id = ? ORDER BY ts_ms'
  );
  S.samplesExport = db.prepare(
    'SELECT ts_ms, worker_id, modem_nick, server_name, status, http_status, ' +
    'total_ms, connect_ms, ttfb_ms, bytes, url, error_msg ' +
    'FROM simulator_samples WHERE run_id = ? ORDER BY ts_ms'
  );
  S.samplesBreakingPoint = db.prepare(
    'SELECT ts_ms, status, total_ms FROM simulator_samples ' +
    'WHERE run_id = ? ORDER BY ts_ms'
  );
}

// ─── Test pool ────────────────────────────────────────────────────────────────

function testPoolKeySet() {
  return new Set(S.testPoolKeys.all().map(r => r.k));
}

function setTestPoolFlag(server, nick, enabled) {
  const want = enabled ? 1 : 0;
  if (S.testPoolExists.get(server, nick)) {
    S.testPoolUpdate.run(want, server, nick);
  } else {
    S.testPoolInsert.run(server, nick, '', '', want);
  }
  return want;
}

function listTestPool() {
  return S.testPoolList.all();
}

// ─── Profiles ─────────────────────────────────────────────────────────────────

function listProfiles() {
  return S.profilesList.all();
}

function getProfile(id) {
  return S.profileById.get(id);
}

function getProfileForRun(id) {
  return S.profileByIdForRun.get(id);
}

function createProfile({ name, description, configJson, createdBy }) {
  return S.profileInsert.get(name, description || null, configJson, createdBy || null);
}

function updateProfile({ id, name, description, configJson }) {
  return S.profileUpdate.run(name, description, configJson, id);
}

function deleteProfile(id) {
  return S.profileDelete.run(id);
}

// ─── Runs + Samples ───────────────────────────────────────────────────────────

function listRuns({ limit, offset }) {
  return S.runsList.all(limit, offset);
}

function getRun(id) {
  return S.runById.get(id);
}

function getRunConfigJson(id) {
  return S.runConfigById.get(id);
}

function listSamples({ runId, limit, offset }) {
  return S.samplesPaginated.all(runId, limit, offset);
}

function countSamples(runId) {
  return S.samplesCount.get(runId).n;
}

function allSamplesForRun(runId) {
  return S.samplesAll.all(runId);
}

function samplesSeries(runId) {
  return S.samplesSeries.all(runId);
}

function exportSamples(runId) {
  return S.samplesExport.all(runId);
}

function samplesForBreakingPoint(runId) {
  return S.samplesBreakingPoint.all(runId);
}

module.exports = {
  init,
  // test pool
  testPoolKeySet, setTestPoolFlag, listTestPool,
  // profiles
  listProfiles, getProfile, getProfileForRun, createProfile, updateProfile, deleteProfile,
  // runs + samples
  listRuns, getRun, getRunConfigJson,
  listSamples, countSamples, allSamplesForRun, samplesSeries, exportSamples,
  samplesForBreakingPoint,
};
