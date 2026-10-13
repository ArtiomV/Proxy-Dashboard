'use strict';
//
// src/routes/cto.js — API ИИ-директора (админ).
//   GET  /api/admin/cto/proposals?status=pending|all  — список предложений
//   POST /api/admin/cto/proposals/:id/decide {decision:'approve'|'reject'|'later'}
//   POST /api/admin/cto/proposals/:id/rollback
//   GET  /api/admin/cto/runs                           — журнал осмотров и расход токенов
//   POST /api/admin/cto/run                            — внеочередной осмотр
const express = require('express');

module.exports = function createCtoRouter({ db, logger, authMiddleware, adminMiddleware, cto }) {
  const r = express.Router();
  const guard = [authMiddleware, adminMiddleware];
  const login = (req) => (req.user && req.user.login) || 'admin';

  r.get('/api/admin/cto/proposals', ...guard, (req, res) => {
    const status = String(req.query.status || 'pending');
    const rows = status === 'all'
      ? db.prepare('SELECT * FROM cto_proposals ORDER BY id DESC LIMIT 100').all()
      : db.prepare('SELECT * FROM cto_proposals WHERE status = ? ORDER BY id DESC LIMIT 100').all(status);
    res.json({ proposals: rows.map(p => ({ ...p, evidence: JSON.parse(p.evidence_json || '[]'), action: JSON.parse(p.action_json || '{}') })) });
  });

  r.post('/api/admin/cto/proposals/:id/decide', ...guard, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const decision = String((req.body || {}).decision || '');
    if (!Number.isInteger(id) || !['approve', 'reject', 'later'].includes(decision)) return res.status(400).json({ error: 'bad request' });
    try {
      const out = await cto.decide(id, decision, login(req));
      res.status(out.ok ? 200 : (out.error === 'not_found' ? 404 : 409)).json(out);
    } catch (e) { logger.error('[CTO] decide: ' + e.message); res.status(500).json({ error: e.message }); }
  });

  r.post('/api/admin/cto/proposals/:id/rollback', ...guard, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'bad request' });
    const out = await cto.rollback(id, login(req));
    res.status(out.ok ? 200 : 409).json(out);
  });

  r.get('/api/admin/cto/runs', ...guard, (req, res) => {
    res.json({ runs: db.prepare('SELECT * FROM cto_runs ORDER BY id DESC LIMIT 30').all() });
  });

  r.post('/api/admin/cto/run', ...guard, async (req, res) => {
    const out = await cto.runCycle('manual');
    res.json(out);
  });

  return r;
};
