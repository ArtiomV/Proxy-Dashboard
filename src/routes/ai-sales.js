'use strict';

const express = require('express');

/**
 * AI sales bots admin panel — backend.
 *
 * On-demand triggers for the lead-gen agents (src/agents/*), run as background
 * jobs (single-process → one at a time) tracked in sales_jobs. Results land in
 * the staging tables (sales_niches / sales_companies / sales_contacts) for
 * review, then get pushed to Twenty CRM via src/agents/twenty.js.
 *
 * Bots:
 *   lookalikes — seed company → infer niche → find similar companies → их ЛПР
 *   contacts   — find decision-makers for staged companies that have none yet
 *   push       — push staged companies + contacts to Twenty
 *
 * All endpoints are admin-only. Keys: anthropic_api_key + tavily_api_key
 * (settings or env). CRM: crm_db_url setting overrides env CRM_DB_URL.
 */
module.exports = function createAiSalesRouter(deps) {
  const { db, logger, authMiddleware, adminMiddleware, getSetting, logActivity } = deps;
  const r = express.Router();

  // Recover from a restart that left a job mid-flight.
  try {
    db.prepare(`UPDATE sales_jobs SET status='error', error='прервано рестартом сервера', finished_at=strftime('%Y-%m-%d %H:%M:%S','now') WHERE status='running'`).run();
  } catch { /* table may not exist yet on a very old db */ }

  let RUNNING = false; // single-job guard (single-process app)

  function updJob(id, fields) {
    const keys = Object.keys(fields);
    if (!keys.length) return;
    const set = keys.map(k => `"${k}"=@${k}`).join(', ');
    db.prepare(`UPDATE sales_jobs SET ${set} WHERE id=@id`).run({ ...fields, id });
  }
  function finishJob(id, patch) {
    updJob(id, { ...patch, finished_at: null }); // placeholder; set ts below
    db.prepare(`UPDATE sales_jobs SET finished_at=strftime('%Y-%m-%d %H:%M:%S','now') WHERE id=?`).run(id);
  }

  async function runJob(id, bot, params) {
    try {
      if (!process.env.ANTHROPIC_API_KEY) process.env.ANTHROPIC_API_KEY = getSetting('anthropic_api_key', '');
      if (!process.env.TAVILY_API_KEY) process.env.TAVILY_API_KEY = getSetting('tavily_api_key', '');
      const apiKey = getSetting('anthropic_api_key', '') || process.env.ANTHROPIC_API_KEY;

      if (bot === 'lookalikes') {
        const { profileSeed } = require('../agents/researcher');
        const { findContacts } = require('../agents/bizdev');
        updJob(id, { progress: `Исследую seed «${params.seed}»...` });
        const res = await profileSeed({ db, seed: params.seed, count: params.count, apiKey, logger });
        const comps = db.prepare(`SELECT id, company, website FROM sales_companies WHERE run_id=? AND is_seed=0`).all(res.runId);
        updJob(id, { progress: `Ниша: ${res.niche || '—'}. Компаний: ${comps.length}. Ищу ЛПР...`, total: comps.length, done: 0 });
        let done = 0;
        for (const co of comps) {
          await findContacts({ db, company: co.company, website: co.website, apiKey, logger, runId: `job${id}-${co.id}` });
          done++; updJob(id, { done, progress: `ЛПР: ${co.company} (${done}/${comps.length})` });
        }
        finishJob(id, { status: 'done', result: JSON.stringify({ niche: res.niche, companies: comps.length }) });
      } else if (bot === 'contacts') {
        const { findContacts } = require('../agents/bizdev');
        const comps = db.prepare(
          `SELECT id, company, website FROM sales_companies
            WHERE status='draft' AND id NOT IN (SELECT DISTINCT company_id FROM sales_contacts WHERE company_id IS NOT NULL)
            ORDER BY id LIMIT ?`).all(params.count);
        updJob(id, { total: comps.length, done: 0, progress: `Компаний к обработке: ${comps.length}` });
        let done = 0;
        for (const co of comps) {
          await findContacts({ db, company: co.company, website: co.website, apiKey, logger, runId: `job${id}-${co.id}` });
          done++; updJob(id, { done, progress: `${co.company} (${done}/${comps.length})` });
        }
        finishJob(id, { status: 'done', result: JSON.stringify({ processed: comps.length }) });
      } else if (bot === 'push') {
        const twenty = require('../agents/twenty');
        updJob(id, { progress: 'Пуш в Twenty CRM...' });
        const out = await twenty.pushStaging(getSetting, db, { onlyApproved: !!params.onlyApproved });
        finishJob(id, { status: 'done', result: JSON.stringify(out) });
      } else {
        finishJob(id, { status: 'error', error: 'неизвестный бот: ' + bot });
      }
    } catch (e) {
      finishJob(id, { status: 'error', error: String(e && e.message || e).slice(0, 500) });
      if (logger && logger.error) logger.error('[ai-sales] job ' + id + ' failed: ' + e.message);
    } finally {
      RUNNING = false;
    }
  }

  // ── status ────────────────────────────────────────────────────────────────
  r.get('/api/admin/ai_sales/status', authMiddleware, adminMiddleware, (req, res) => {
    const counts = {
      niches: db.prepare('SELECT COUNT(*) n FROM sales_niches').get().n,
      companies: db.prepare('SELECT COUNT(*) n FROM sales_companies').get().n,
      contacts: db.prepare('SELECT COUNT(*) n FROM sales_contacts').get().n,
      pushed: db.prepare("SELECT COUNT(*) n FROM sales_contacts WHERE status='pushed'").get().n,
    };
    const job = db.prepare("SELECT * FROM sales_jobs ORDER BY id DESC LIMIT 1").get() || null;
    res.json({
      keys: {
        anthropic: !!(process.env.ANTHROPIC_API_KEY || getSetting('anthropic_api_key', '')),
        tavily: !!(process.env.TAVILY_API_KEY || getSetting('tavily_api_key', '')),
      },
      crm: { configured: !!(getSetting('crm_db_url', '') || process.env.CRM_DB_URL) },
      counts, running: RUNNING, last_job: job,
    });
  });

  // ── review queue ────────────────────────────────────────────────────────────
  r.get('/api/admin/ai_sales/queue', authMiddleware, adminMiddleware, (req, res) => {
    const niches = db.prepare('SELECT * FROM sales_niches ORDER BY id DESC').all();
    const companies = db.prepare('SELECT * FROM sales_companies ORDER BY id DESC LIMIT 500').all();
    const contacts = db.prepare('SELECT * FROM sales_contacts ORDER BY company_id, id').all();
    const byCompany = {};
    for (const k of contacts) { (byCompany[k.company_id] = byCompany[k.company_id] || []).push(k); }
    for (const c of companies) c.contacts = byCompany[c.id] || [];
    res.json({ niches, companies });
  });

  // ── CRM connectivity probe ───────────────────────────────────────────────────
  r.get('/api/admin/ai_sales/crm_ping', authMiddleware, adminMiddleware, async (req, res) => {
    try {
      const twenty = require('../agents/twenty');
      res.json(await twenty.ping(getSetting));
    } catch (e) { res.json({ ok: false, error: e.message }); }
  });

  // ── start a bot run ──────────────────────────────────────────────────────────
  r.post('/api/admin/ai_sales/run', authMiddleware, adminMiddleware, (req, res) => {
    const bot = String(req.body.bot || '');
    if (!['lookalikes', 'contacts', 'push'].includes(bot)) return res.status(400).json({ error: 'bad bot' });
    if (RUNNING) return res.status(409).json({ error: 'Уже выполняется задача — дождитесь завершения' });
    if (bot !== 'push' && !(process.env.ANTHROPIC_API_KEY || getSetting('anthropic_api_key', ''))) return res.status(400).json({ error: 'Не задан Anthropic API key' });
    if (bot !== 'push' && !(process.env.TAVILY_API_KEY || getSetting('tavily_api_key', ''))) return res.status(400).json({ error: 'Не задан Tavily API key' });

    const params = {
      seed: String(req.body.seed || '').trim(),
      count: Math.max(1, Math.min(20, parseInt(req.body.count, 10) || 5)),
      onlyApproved: !!req.body.only_approved,
    };
    if (bot === 'lookalikes' && !params.seed) return res.status(400).json({ error: 'Укажите seed-компанию' });

    const info = db.prepare(
      `INSERT INTO sales_jobs (bot, params, status, started_by) VALUES (?,?,?,?)`
    ).run(bot, JSON.stringify(params), 'running', (req.user && req.user.login) || '');
    const id = Number(info.lastInsertRowid);
    RUNNING = true;
    logActivity('system', 'info', 'ai_sales_run', bot, `seed=${params.seed || '-'} count=${params.count}`);
    setImmediate(() => runJob(id, bot, params));
    res.json({ ok: true, jobId: id });
  });

  // ── job status ───────────────────────────────────────────────────────────────
  r.get('/api/admin/ai_sales/job/:id', authMiddleware, adminMiddleware, (req, res) => {
    const job = db.prepare('SELECT * FROM sales_jobs WHERE id=?').get(parseInt(req.params.id, 10));
    if (!job) return res.status(404).json({ error: 'not found' });
    res.json(job);
  });

  return r;
};
