'use strict';

/**
 * Twenty CRM access for the AI sales bots (read clients, push companies +
 * decision-makers). Direct PostgreSQL — same approach as src/jobs/crm-sync.js.
 *
 * Connection: `crm_db_url` setting overrides env CRM_DB_URL (the env value can
 * go stale — Twenty's Postgres is a Docker container whose IP changes on
 * restart). Workspace schema from env CRM_WORKSPACE / CRM_WS.
 *
 * The `pg` module is optional; callers should handle a thrown error (e.g. CRM
 * unreachable) and surface it to the panel rather than crash.
 *
 * Tagging: everything written gets createdBySource='IMPORT',
 * createdByName='AI BizDev' so it is filterable / bulk-removable:
 *   DELETE FROM person  WHERE "createdByName"='AI BizDev';
 *   DELETE FROM company WHERE "createdByName"='AI BizDev';
 */

const TAG = 'AI BizDev';

function _conf(getSetting) {
  const url = (getSetting && getSetting('crm_db_url', '')) || process.env.CRM_DB_URL || '';
  const ws = process.env.CRM_WORKSPACE || process.env.CRM_WS || '';
  return { url, ws };
}

async function _connect(getSetting) {
  const { url, ws } = _conf(getSetting);
  if (!url) throw new Error('CRM_DB_URL не задан (env или настройка crm_db_url)');
  if (!ws) throw new Error('CRM_WORKSPACE не задан');
  const { Client } = require('pg');
  const c = new Client({ connectionString: url, connectionTimeoutMillis: 8000 });
  await c.connect();
  return { c, ws };
}

function _nn(v) { return (v && String(v).trim()) ? String(v).trim() : null; }
function _domainOf(url) {
  if (!url) return '';
  try { return new URL(url.includes('://') ? url : 'http://' + url).hostname.replace(/^www\./, '').toLowerCase(); }
  catch { return String(url).replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0].toLowerCase(); }
}
function _splitName(raw) {
  const s = String(raw || '').replace(/\([^)]*\)/g, '').replace(/\s+/g, ' ').trim();
  const p = s.split(' ');
  return { first: p[0] || '', last: p.slice(1).join(' ') };
}

/** Quick connectivity / config probe. Returns {ok, count, error}. */
async function ping(getSetting) {
  let conn;
  try {
    conn = await _connect(getSetting);
    const r = await conn.c.query(`SELECT COUNT(*) n FROM ${conn.ws}.company WHERE "deletedAt" IS NULL`);
    return { ok: true, companies: Number(r.rows[0].n) };
  } catch (e) {
    return { ok: false, error: e.message };
  } finally { if (conn) try { await conn.c.end(); } catch { /* ignore */ } }
}

/** List companies (optionally only clients) for seeds / context. */
async function listCompanies(getSetting, { clientOnly = false, limit = 500 } = {}) {
  let conn;
  try {
    conn = await _connect(getSetting);
    const where = ['"deletedAt" IS NULL', 'name IS NOT NULL', "name <> ''"];
    if (clientOnly) where.push(`lower("clientStatus"::text) LIKE '%client%' OR lower("clientStatus"::text) LIKE '%клиент%'`);
    const r = await conn.c.query(
      `SELECT id, name, COALESCE("domainNamePrimaryLinkUrl",'') AS domain,
              COALESCE("clientStatus"::text,'') AS status, COALESCE("businessSector"::text,'') AS sector
       FROM ${conn.ws}.company WHERE ${where.join(' AND ')} ORDER BY "createdAt" DESC LIMIT ${parseInt(limit, 10) || 500}`);
    return r.rows;
  } finally { if (conn) try { await conn.c.end(); } catch { /* ignore */ } }
}

/**
 * Push approved staging rows to Twenty: new companies → company table, their
 * decision-makers → person table (linked, deduped, tagged). Reads the local
 * sales_companies / sales_contacts (better-sqlite3 `db`).
 * @returns {Promise<{companiesInserted,peopleInserted,peopleRetried,peopleSkipped,errors}>}
 */
async function pushStaging(getSetting, db, { onlyApproved = false } = {}) {
  let conn;
  const out = { companiesInserted: 0, peopleInserted: 0, peopleRetried: 0, peopleSkipped: 0, errors: 0 };
  try {
    conn = await _connect(getSetting);
    const { c, ws } = conn;

    // existing Twenty companies: domain/name → id
    const exCo = await c.query(`SELECT id, name, COALESCE("domainNamePrimaryLinkUrl",'') AS domain FROM ${ws}.company WHERE "deletedAt" IS NULL`);
    const byDomain = new Map(), byName = new Map();
    for (const r of exCo.rows) {
      const d = _domainOf(r.domain); if (d) byDomain.set(d, r.id);
      byName.set(String(r.name).trim().toLowerCase(), r.id);
    }
    // existing people for dedup: companyId|fullname
    const exP = await c.query(`SELECT "companyId", lower(trim(coalesce("nameFirstName",'')||' '||coalesce("nameLastName",''))) AS nm FROM ${ws}.person`);
    const exPeople = new Set(exP.rows.map(r => (r.companyId || '') + '|' + r.nm));

    const statusFilter = onlyApproved ? "AND c.status = 'approved'" : "AND c.status IN ('draft','approved')";
    const companies = db.prepare(`SELECT * FROM sales_companies c WHERE 1=1 ${statusFilter} ORDER BY c.id`).all();

    for (const co of companies) {
      const dom = _domainOf(co.website);
      let cid = (dom && byDomain.get(dom)) || byName.get(String(co.company).trim().toLowerCase()) || co.crm_company_id || '';

      // insert new look-alike company (skip seeds / already-in-CRM)
      if (!cid && !co.is_seed) {
        try {
          const ins = await c.query(
            `INSERT INTO ${ws}.company ("name","domainNamePrimaryLinkUrl","domainNamePrimaryLinkLabel","createdBySource","createdByName")
             VALUES ($1,$2,$3,'IMPORT',$4) RETURNING id`,
            [co.company, _nn(co.website), dom || null, TAG]);
          cid = ins.rows[0].id;
          out.companiesInserted++;
          if (dom) byDomain.set(dom, cid);
          byName.set(String(co.company).trim().toLowerCase(), cid);
        } catch { out.errors++; }
      }
      if (cid && !co.crm_company_id) {
        try { db.prepare('UPDATE sales_companies SET crm_company_id=?, status=? WHERE id=?').run(String(cid), 'pushed', co.id); } catch { /* ignore */ }
      }
      if (!cid) continue;

      const contacts = db.prepare(`SELECT * FROM sales_contacts WHERE company_id=? ORDER BY id`).all(co.id);
      for (const k of contacts) {
        const { first, last } = _splitName(k.name);
        const full = (first + ' ' + last).trim().toLowerCase();
        if (exPeople.has(cid + '|' + full)) { out.peopleSkipped++; continue; }
        exPeople.add(cid + '|' + full);
        const email = (String(k.contact || '').match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/) || [])[0] || '';
        let tg = ''; const tm = String(k.contact || '').match(/t\.me\/([A-Za-z0-9_]+)/i); if (tm) tg = 'https://t.me/' + tm[1];
        const phone = ((String(k.contact || '').match(/\+?\d[\d()\s.-]{7,}\d/) || [])[0] || '').replace(/[^\d+]/g, '');
        const SQL = `INSERT INTO ${ws}.person
            ("companyId","nameFirstName","nameLastName","jobTitle","linkedinLinkPrimaryLinkUrl","linkedinLinkPrimaryLinkLabel",
             "emailsPrimaryEmail","phonesPrimaryPhoneNumber","telegram","createdBySource","createdByName")
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'IMPORT',$10)`;
        const base = [cid, first, last, k.role || '', _nn(k.linkedin), k.linkedin ? 'LinkedIn' : null];
        try {
          await c.query(SQL, [...base, _nn(email), _nn(phone), _nn(tg), TAG]);
          out.peopleInserted++;
        } catch (e) {
          if (/duplicate key/i.test(e.message)) {
            try { await c.query(SQL, [...base, null, null, null, TAG]); out.peopleRetried++; }
            catch { out.errors++; }
          } else { out.errors++; }
        }
        try { db.prepare('UPDATE sales_contacts SET status=? WHERE id=?').run('pushed', k.id); } catch { /* ignore */ }
      }
    }
    return out;
  } finally { if (conn) try { await conn.c.end(); } catch { /* ignore */ } }
}

module.exports = { ping, listCompanies, pushStaging, TAG };
