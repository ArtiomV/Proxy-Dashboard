'use strict';

/**
 * Staging writes for the self-expanding lead-gen engine. Three tools the
 * agents call; everything lands in SQLite (sales_niches / sales_companies /
 * sales_contacts) for human review, then gets pushed to Twenty CRM. Nothing
 * is sent anywhere — the salesperson is a human.
 *
 * ctx: { db (better-sqlite3), runId }.
 */

function domainOf(url) {
  if (!url) return '';
  try {
    const u = new URL(url.includes('://') ? url : 'http://' + url);
    return u.hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return String(url).replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0].toLowerCase();
  }
}

const saveNiche = {
  name: 'save_niche',
  description:
    'Сохранить/обновить НИШУ — сегмент похожих компаний-покупателей прокси, выведенный из seed-компании. ' +
    'Вызови один раз, определив, к какому классу бизнеса относится seed (напр. "SaaS мониторинга цен"). ' +
    'Возвращает niche_id.',
  input_schema: {
    type: 'object',
    properties: {
      name:         { type: 'string', description: 'Короткое имя ниши (класс бизнеса, не одна компания)' },
      description:  { type: 'string', description: 'Чем занимаются такие компании' },
      why_proxies:  { type: 'string', description: 'Почему этой нише нужны мобильные прокси' },
      seed_company: { type: 'string', description: 'Компания, по которой выведена ниша' },
    },
    required: ['name', 'description'],
  },
  async run(input, ctx) {
    const { db } = ctx || {};
    if (!db) throw new Error('нет db в контексте');
    const name = String(input.name || '').trim();
    if (!name) throw new Error('name обязателен');
    const ex = db.prepare(`SELECT id FROM sales_niches WHERE lower(name) = lower(?)`).get(name);
    if (ex) {
      db.prepare(
        `UPDATE sales_niches
           SET description = COALESCE(NULLIF(?, ''), description),
               why_proxies = COALESCE(NULLIF(?, ''), why_proxies)
         WHERE id = ?`
      ).run(String(input.description || ''), String(input.why_proxies || ''), ex.id);
      return { ok: true, niche_id: ex.id, existed: true };
    }
    const info = db.prepare(
      `INSERT INTO sales_niches (name, description, why_proxies, seed_company) VALUES (?, ?, ?, ?)`
    ).run(name, String(input.description || ''), String(input.why_proxies || ''), String(input.seed_company || ''));
    return { ok: true, niche_id: Number(info.lastInsertRowid), existed: false };
  },
};

const saveCompany = {
  name: 'save_company',
  description:
    'Сохранить КОМПАНИЮ-кандидата (потенциального покупателя прокси) в стейджинг. Вызывай по одной на каждую ' +
    'релевантную компанию. Дедуп по домену. НЕ сохраняй продавцов/провайдеров прокси, обзоры/листиклы, ' +
    'агрегаторы вакансий — только реальные компании-ПОКУПАТЕЛИ. Возвращает company_id.',
  input_schema: {
    type: 'object',
    properties: {
      company:    { type: 'string',  description: 'Название компании' },
      website:    { type: 'string',  description: 'Сайт / домен' },
      country:    { type: 'string',  description: 'Страна, если известна' },
      niche:      { type: 'string',  description: 'Имя ниши (как в save_niche)' },
      why_fit:    { type: 'string',  description: 'Почему ей нужны прокси (1-2 факта)' },
      fit_score:  { type: 'integer', description: 'Соответствие ICP, 0..100' },
      source_url: { type: 'string',  description: 'Где нашли' },
      is_seed:    { type: 'boolean', description: 'true если это исходная seed-компания' },
    },
    required: ['company', 'why_fit'],
  },
  async run(input, ctx) {
    const { db, runId } = ctx || {};
    if (!db) throw new Error('нет db в контексте');
    const company = String(input.company || '').trim();
    if (!company) throw new Error('company обязателен');
    const website = String(input.website || '').trim();
    const domain = domainOf(website);

    const dup = domain
      ? db.prepare(`SELECT id FROM sales_companies WHERE domain = ? LIMIT 1`).get(domain)
      : db.prepare(`SELECT id FROM sales_companies WHERE lower(company) = lower(?) LIMIT 1`).get(company);
    if (dup) return { ok: true, deduped: true, company_id: dup.id };

    let niche_id = null;
    const niche_name = String(input.niche || '');
    if (niche_name) {
      const n = db.prepare(`SELECT id FROM sales_niches WHERE lower(name) = lower(?)`).get(niche_name);
      if (n) niche_id = n.id;
    }

    const info = db.prepare(
      `INSERT INTO sales_companies
         (niche_id, niche_name, company, website, domain, country, why_fit, fit_score, source_url, is_seed, run_id)
       VALUES (@niche_id, @niche_name, @company, @website, @domain, @country, @why_fit, @fit_score, @source_url, @is_seed, @run_id)`
    ).run({
      niche_id, niche_name, company, website, domain,
      country:    String(input.country || ''),
      why_fit:    String(input.why_fit || ''),
      fit_score:  Math.max(0, Math.min(100, parseInt(input.fit_score, 10) || 0)),
      source_url: String(input.source_url || ''),
      is_seed:    input.is_seed ? 1 : 0,
      run_id:     runId || '',
    });
    return { ok: true, company_id: Number(info.lastInsertRowid) };
  },
};

const saveContact = {
  name: 'save_contact',
  description:
    'Сохранить контакт ЛПР (CEO / основатель / топ-менеджмент) для компании. Имя и роль обязательны; ' +
    'LinkedIn-URL ищи обязательно; общий контакт (email/форма/телега) — если найден. Дедуп по компании+имени. ' +
    'НЕ выдумывай людей и ссылки. Возвращает contact_id.',
  input_schema: {
    type: 'object',
    properties: {
      company:    { type: 'string', description: 'Компания (как в save_company)' },
      name:       { type: 'string', description: 'Имя человека' },
      role:       { type: 'string', description: 'Должность (CEO/Founder/CMO/Head of Growth/CTO…)' },
      linkedin:   { type: 'string', description: 'URL профиля LinkedIn, если найден' },
      contact:    { type: 'string', description: 'Email / форма / телега, если найдено' },
      source_url: { type: 'string', description: 'Где нашли' },
    },
    required: ['company', 'name', 'role'],
  },
  async run(input, ctx) {
    const { db, runId } = ctx || {};
    if (!db) throw new Error('нет db в контексте');
    const company = String(input.company || '').trim();
    const name = String(input.name || '').trim();
    if (!company || !name) throw new Error('company и name обязательны');

    const c = db.prepare(`SELECT id FROM sales_companies WHERE lower(company) = lower(?) LIMIT 1`).get(company);
    const company_id = c ? c.id : null;

    const dup = db.prepare(
      `SELECT id FROM sales_contacts WHERE lower(company) = lower(?) AND lower(name) = lower(?) LIMIT 1`
    ).get(company, name);
    if (dup) return { ok: true, deduped: true, contact_id: dup.id };

    const info = db.prepare(
      `INSERT INTO sales_contacts (company_id, company, name, role, linkedin, contact, source_url, run_id)
       VALUES (@company_id, @company, @name, @role, @linkedin, @contact, @source_url, @run_id)`
    ).run({
      company_id, company, name,
      role:       String(input.role || ''),
      linkedin:   String(input.linkedin || ''),
      contact:    String(input.contact || ''),
      source_url: String(input.source_url || ''),
      run_id:     runId || '',
    });
    return { ok: true, contact_id: Number(info.lastInsertRowid) };
  },
};

module.exports = { saveNiche, saveCompany, saveContact, domainOf };
