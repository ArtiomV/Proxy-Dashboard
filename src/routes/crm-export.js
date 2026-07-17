'use strict';

// Экспорт данных Twenty CRM в «нормальный» CSV для Excel.
//
// Родной экспорт Twenty отдаёт UTF-8 без BOM с запятыми — русский Excel
// показывает кракозябры одной колонкой. Внутрь iframe Twenty влезть нельзя,
// поэтому экспортируем сами, напрямую из его Postgres (тот же доступ, что у
// ИИ-отдела продаж, см. src/agents/twenty.js):
//   • UTF-8 c BOM (﻿) — Excel сразу видит кириллицу;
//   • разделитель «;» + CRLF — русская локаль Excel открывает как таблицу;
//   • все поля в кавычках с RFC4180-экранированием;
//   • колонки — как в таблицах CRM, включая кастомные поля (ИНН, сектор,
//     тип прокси, статус клиента…).
//
// Docker-грабля: Postgres Twenty живёт в контейнере, его IP меняется при
// пересоздании (172.18.0.x). URL берём из настройки crm_db_url (приоритет)
// или env CRM_DB_URL; при ECONNREFUSED сами узнаём свежий IP через
// `docker inspect twenty-db-1`, повторяем коннект и персистим рабочий URL
// обратно в настройку — экспорт самовосстанавливается после рестарта CRM.

const express = require('express');
const { execFile } = require('child_process');

module.exports = function createCrmExportRouter(deps) {
  const { logger, authMiddleware, adminMiddleware, appSettings, setSettings } = deps;
  const r = express.Router();

  function _conf() {
    return {
      url: (appSettings && appSettings.crm_db_url) || process.env.CRM_DB_URL || '',
      ws: process.env.CRM_WORKSPACE || process.env.CRM_WS || '',
    };
  }

  function _dockerDbIp() {
    return new Promise((resolve) => {
      execFile('docker', ['inspect', 'twenty-db-1', '--format',
        '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}'],
      { timeout: 5000 }, (err, stdout) => {
        const ip = String(stdout || '').trim();
        resolve(!err && /^\d+\.\d+\.\d+\.\d+$/.test(ip) ? ip : null);
      });
    });
  }

  async function _connect() {
    const { url, ws } = _conf();
    if (!url) throw new Error('CRM_DB_URL не задан (env или настройка crm_db_url)');
    if (!ws) throw new Error('CRM_WORKSPACE не задан');
    const { Client } = require('pg');
    const tryUrl = async (u) => {
      const c = new Client({ connectionString: u, connectionTimeoutMillis: 8000 });
      await c.connect();
      return c;
    };
    try {
      return { c: await tryUrl(url), ws };
    } catch (e) {
      // Самолечение: контейнер Twenty пересоздали → IP уехал.
      const ip = await _dockerDbIp();
      if (!ip) throw e;
      const healed = url.replace(/@[^:@/]+:/, '@' + ip + ':');
      if (healed === url) throw e;
      const c = await tryUrl(healed);
      logger.info(`[CRM-export] db IP сменился, новый URL закреплён (${ip})`);
      try { if (setSettings) setSettings({ crm_db_url: healed }); } catch (_) { /* best-effort */ }
      return { c, ws };
    }
  }

  // ── CSV: BOM + «;» + CRLF + все поля в кавычках ──
  function _cell(v) {
    if (v == null) return '""';
    let s = String(v);
    // многозначные поля Twenty приходят как '{a,b}' / JSON-массивы — чистим до "a, b"
    if (/^\{.*\}$/.test(s)) s = s.slice(1, -1).replace(/"/g, '').split(',').filter(Boolean).join(', ');
    else if (/^\[.*\]$/.test(s)) { try { s = JSON.parse(s).join(', '); } catch (_) { /* как есть */ } }
    return '"' + s.replace(/"/g, '""') + '"';
  }
  function _csv(headers, rows) {
    const lines = [headers.map(_cell).join(';')];
    for (const row of rows) lines.push(row.map(_cell).join(';'));
    return '\uFEFF' + lines.join('\r\n') + '\r\n';
  }
  function _dt(v) {
    if (!v) return '';
    const d = new Date(v);
    return isNaN(d) ? '' : d.toISOString().slice(0, 16).replace('T', ' ');
  }

  const OBJECTS = {
    people: {
      file: 'crm-people',
      headers: ['Имя', 'Фамилия', 'Компания', 'Email', 'Телефон', 'Telegram', 'Должность',
        'Город', 'LinkedIn', 'Источник', 'Кем создан', 'Создано', 'Обновлено'],
      query: (ws) => `
        SELECT p."nameFirstName" f, p."nameLastName" l, COALESCE(c."name",'') co,
               COALESCE(p."emailsPrimaryEmail",'') em,
               TRIM(COALESCE(p."phonesPrimaryPhoneCallingCode",'') || ' ' || COALESCE(p."phonesPrimaryPhoneNumber",'')) ph,
               COALESCE(p."telegram",'') tg, COALESCE(p."jobTitle",'') jt, COALESCE(p."city",'') ci,
               COALESCE(p."linkedinLinkPrimaryLinkUrl",'') li,
               COALESCE(p."createdBySource"::text,'') src, COALESCE(p."createdByName",'') cb,
               p."createdAt" ca, p."updatedAt" ua
        FROM ${ws}.person p LEFT JOIN ${ws}.company c ON c.id = p."companyId" AND c."deletedAt" IS NULL
        WHERE p."deletedAt" IS NULL
        ORDER BY co, l, f`,
      row: (x, dt) => [x.f, x.l, x.co, x.em, x.ph, x.tg, x.jt, x.ci, x.li, x.src, x.cb, dt(x.ca), dt(x.ua)],
    },
    companies: {
      file: 'crm-companies',
      headers: ['Название', 'Домен', 'ИНН', 'Email', 'Сектор', 'Тип прокси', 'Кейс',
        'Страны прокси', 'Ожид. объём', 'Источник лида', 'Статус клиента', 'Сотрудников',
        'Город', 'Страна', 'LinkedIn', 'ICP', 'Кем создано', 'Создано', 'Обновлено'],
      query: (ws) => `
        SELECT "name" nm, COALESCE("domainNamePrimaryLinkUrl",'') dom, COALESCE("inn",'') inn,
               COALESCE("companyEmail",'') em, COALESCE("businessSector"::text,'') bs,
               COALESCE("proxyType"::text,'') pt, COALESCE("useCase"::text,'') uc,
               COALESCE("proxyCountries"::text,'') pc, COALESCE("prospectiveVolume"::text,'') pv,
               COALESCE("leadSource"::text,'') ls, COALESCE("clientStatus"::text,'') cs,
               COALESCE("employees"::text,'') emp,
               COALESCE("addressAddressCity",'') ci, COALESCE("addressAddressCountry",'') ctr,
               COALESCE("linkedinLinkPrimaryLinkUrl",'') li,
               CASE WHEN "idealCustomerProfile" THEN 'да' ELSE '' END icp,
               COALESCE("createdByName",'') cb, "createdAt" ca, "updatedAt" ua
        FROM ${ws}.company
        WHERE "deletedAt" IS NULL
        ORDER BY nm`,
      row: (x, dt) => [x.nm, x.dom, x.inn, x.em, x.bs, x.pt, x.uc, x.pc, x.pv, x.ls, x.cs,
        x.emp, x.ci, x.ctr, x.li, x.icp, x.cb, dt(x.ca), dt(x.ua)],
    },
  };

  r.get('/api/admin/crm/export', authMiddleware, adminMiddleware, async (req, res) => {
    const obj = OBJECTS[String(req.query.object || 'people')];
    if (!obj) return res.status(400).json({ error: 'object должен быть people или companies' });
    let conn;
    try {
      conn = await _connect();
      const q = await conn.c.query(obj.query(conn.ws));
      const csv = _csv(obj.headers, q.rows.map((x) => obj.row(x, _dt)));
      const fname = `${obj.file}-${new Date().toISOString().slice(0, 10)}.csv`;
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
      res.send(csv);
    } catch (e) {
      logger.error('[CRM-export] ' + e.message);
      res.status(502).json({ error: 'CRM недоступна: ' + e.message });
    } finally {
      if (conn) try { await conn.c.end(); } catch (_) { /* ignore */ }
    }
  });

  return r;
};
