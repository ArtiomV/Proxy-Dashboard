'use strict';
// src/db/billing-runs.js — repository для `billing_runs`/`billing_jobs`
// (миграция 099).
//
// 2026-09-18 · DEEP-23 (§ FIX-SPEC): durable-учёт суточного биллинга.
// Прогон за дату фиксируется в billing_runs; каждое списание — заданием
// client/date в billing_jobs с тарифным контекстом (цена, тип, days_in_month)
// на момент расчёта. Крах между списанием и отметкой оставляет задание
// 'pending' — recovery доводит его (atomicDebit идемпотентен по
// ключу client+date). Retry НЕ пересчитывает «вчера»: дата и контекст
// читаются из durable-строки.

let S = {};

function init(db) {
  S.runFor = db.prepare('SELECT * FROM billing_runs WHERE billing_date = ? AND kind = ?');
  S.beginRun = db.prepare(`INSERT INTO billing_runs (billing_date, kind, status, started_at, finished_at)
    VALUES (?, ?, 'running', datetime('now'), NULL)
    ON CONFLICT(billing_date, kind)
    DO UPDATE SET status='running', started_at=datetime('now'), finished_at=NULL`);
  S.completeRun = db.prepare(
    "UPDATE billing_runs SET status='completed', finished_at=datetime('now'), summary=? WHERE billing_date = ? AND kind = ?"
  );
  S.failRun = db.prepare(
    "UPDATE billing_runs SET status='failed', finished_at=datetime('now'), summary=? WHERE billing_date = ? AND kind = ?"
  );
  S.lastCompletedDate = db.prepare(
    "SELECT MAX(billing_date) AS d FROM billing_runs WHERE kind = ? AND status = 'completed'"
  );
  S.ensureJob = db.prepare(`INSERT OR IGNORE INTO billing_jobs
    (billing_date, client_id, kind, status, context) VALUES (?, ?, ?, 'pending', ?)`);
  S.markJob = db.prepare(`UPDATE billing_jobs
    SET status=?, amount=?, attempts=attempts+1, last_error=?, updated_at=datetime('now')
    WHERE billing_date = ? AND client_id = ? AND kind = ?`);
  S.jobFor = db.prepare('SELECT * FROM billing_jobs WHERE billing_date = ? AND client_id = ? AND kind = ?');
  S.openJobsForDate = db.prepare(
    "SELECT * FROM billing_jobs WHERE billing_date = ? AND kind = ? AND status IN ('pending','failed','no_data')"
  );
  S.openJobs = db.prepare(
    "SELECT * FROM billing_jobs WHERE kind = ? AND billing_date <= ? AND status IN ('pending','failed','no_data') ORDER BY billing_date, client_id"
  );
}

function runFor(billingDate, kind = 'daily') { return S.runFor.get(billingDate, kind); }
function beginRun(billingDate, kind = 'daily') { S.beginRun.run(billingDate, kind); }
function completeRun(billingDate, summary, kind = 'daily') {
  S.completeRun.run(JSON.stringify(summary || {}), billingDate, kind);
}
function failRun(billingDate, error, kind = 'daily') {
  S.failRun.run(JSON.stringify({ error: String(error || 'unknown').slice(0, 300) }), billingDate, kind);
}
function lastCompletedDate(kind = 'daily') { const r = S.lastCompletedDate.get(kind); return r ? r.d : null; }
// Контекст расчёта фиксируется ОДИН раз (INSERT OR IGNORE): повтор прогона
// не перезаписывает тарифный снимок первой попытки.
function ensureJob(billingDate, clientId, context, kind = 'daily') {
  S.ensureJob.run(billingDate, clientId, kind, JSON.stringify(context || {}));
}
function markJob(billingDate, clientId, status, { amount = null, error = null } = {}, kind = 'daily') {
  S.markJob.run(status, amount, error ? String(error).slice(0, 300) : null, billingDate, clientId, kind);
}
function jobFor(billingDate, clientId, kind = 'daily') { return S.jobFor.get(billingDate, clientId, kind); }
function openJobsForDate(billingDate, kind = 'daily') { return S.openJobsForDate.all(billingDate, kind); }
// Все незавершённые задания до даты включительно — источник recovery
// вместо эвристики «snapshot старше 26 часов» (DEEP-23).
function openJobs(upToDate, kind = 'daily') { return S.openJobs.all(kind, upToDate); }

module.exports = {
  init, runFor, beginRun, completeRun, failRun, lastCompletedDate,
  ensureJob, markJob, jobFor, openJobsForDate, openJobs,
};
