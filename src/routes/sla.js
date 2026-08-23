'use strict';
//
// src/routes/sla.js — C1 (ТЗ мониторинга v2, этап 4, 23.08): SLA/uptime-отчёт.
// Расчёт — чистые функции src/sla.js.
//
//   GET /api/admin/sla_report?month=YYYY-MM[&format=csv]

const express = require('express');
const sla = require('../sla');

module.exports = function (deps) {
  const { db, logger, authMiddleware, adminMiddleware } = deps;
  const r = express.Router();

  r.get('/api/admin/sla_report', authMiddleware, adminMiddleware, (req, res) => {
    const month = String(req.query.month || '').trim();
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
      return res.status(400).json({ error: 'month: ожидается YYYY-MM' });
    }
    try {
      const report = sla.buildReport(db, month);
      if (req.query.format === 'csv') {
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="sla-${month}.csv"`);
        return res.send(sla.toCsv(report));
      }
      res.json(report);
    } catch (e) {
      logger.error('[SLA] report: ' + e.message);
      res.status(500).json({ error: e.message });
    }
  });

  return r;
};
