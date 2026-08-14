'use strict';

/**
 * src/crm/twenty-leads.js — push входящих заявок с лендинга в Twenty CRM.
 *
 * Twenty крутится на этом же сервере в Docker (twenty-server/twenty-db).
 * Пишем напрямую в её PostgreSQL — так же, как это делала старая
 * AI-лидген интеграция (выпилена в c202481): официальный REST API Twenty
 * требует ручного выпуска API-ключа в UI, а прямой доступ к БД у нас уже
 * есть и не зависит от сессий/токенов.
 *
 * Подводные камни, учтённые здесь:
 *   - CRM_DB_URL в .env содержал IP контейнера (172.18.0.x) — он МЕНЯЕТСЯ
 *     при пересоздании контейнера. Поэтому используем host-mapped порт
 *     127.0.0.1:5432 (docker-compose twenty-db публикует 127.0.0.1:5432→5432).
 *     Значение можно переопределить настройкой crm_db_url / env CRM_DB_URL.
 *   - Имя workspace-схемы (workspace_xxx) тоже нестабильно — после
 *     переустановки Twenty оно другое. Схему авто-определяем: ищем
 *     workspace_* схему, в которой есть таблица person. Кэшируем в память.
 *
 * Что создаём в Twenty:
 *   - person: nameFirstName='Лид с сайта', nameLastName=<контакт>, телефон —
 *     в phonesPrimaryPhoneNumber (для TG-контакта телефона нет — handle
 *     остаётся в nameLastName и теле заметки). Дедуп по телефону / контакту:
 *     если персона уже есть — только добавляем заметку.
 *   - opportunity (раздел «Сделки»): «Заявка: <контакт>», стадия NEW,
 *     pointOfContactId → person. Для повторной заявки того же контакта новую
 *     сделку НЕ плодим, если открытая уже есть — только заметку.
 *   - note + noteTarget → person: полный текст заявки, продукт, оффер,
 *     страница, UTM-метки.
 *
 * Тегирование: createdBySource='IMPORT', createdByName='Сайт arendaproxy.ru' —
 * записи фильтруются/удаляются массово:
 *   DELETE FROM <ws>."noteTarget" WHERE "createdByName"='Сайт arendaproxy.ru';
 *   DELETE FROM <ws>.note        WHERE "createdByName"='Сайт arendaproxy.ru';
 *   DELETE FROM <ws>.opportunity WHERE "createdByName"='Сайт arendaproxy.ru';
 *   DELETE FROM <ws>.person      WHERE "createdByName"='Сайт arendaproxy.ru';
 */

const TAG = 'Сайт arendaproxy.ru';
const DEFAULT_DB_URL = 'postgresql://twenty:TwentyCRM2026x@127.0.0.1:5432/default';

let _wsSchema = null;   // кэш авто-определённой workspace-схемы

function _dbUrl(getSetting) {
  return (getSetting && getSetting('crm_db_url', '')) || process.env.CRM_DB_URL || DEFAULT_DB_URL;
}

async function _connect(getSetting) {
  const { Client } = require('pg');
  const c = new Client({ connectionString: _dbUrl(getSetting), connectionTimeoutMillis: 8000 });
  await c.connect();
  return c;
}

/** Находит (и кэширует) workspace-схему Twenty — ту, где есть таблица person. */
async function _workspace(c) {
  if (_wsSchema) return _wsSchema;
  const r = await c.query(
    `SELECT table_schema AS s FROM information_schema.tables
     WHERE table_schema LIKE 'workspace%' AND table_name = 'person' LIMIT 1`);
  if (!r.rows.length) throw new Error('Twenty: workspace-схема с таблицей person не найдена');
  _wsSchema = r.rows[0].s;
  return _wsSchema;
}

/** Сброс кэша схемы (после переустановки Twenty / смены workspace). */
function resetCache() { _wsSchema = null; }

/** Проверка связи: {ok, workspace, persons} или {ok:false, error}. */
async function ping(getSetting) {
  let c;
  try {
    c = await _connect(getSetting);
    const ws = await _workspace(c);
    const r = await c.query(`SELECT COUNT(*) n FROM ${ws}.person WHERE "deletedAt" IS NULL`);
    return { ok: true, workspace: ws, persons: Number(r.rows[0].n) };
  } catch (e) {
    return { ok: false, error: e.message };
  } finally { if (c) try { await c.end(); } catch { /* ignore */ } }
}

/**
 * Пуш заявки в Twenty. lead: {contact, contact_type, message, product, offer,
 * page, cta_position, utm}. Возвращает { personId, created } — created=true,
 * если персона новая (иначе только заметка к существующей).
 */
async function pushLead(getSetting, lead) {
  let c;
  try {
    c = await _connect(getSetting);
    const ws = await _workspace(c);

    const contact = String(lead.contact || '').trim();
    const phone = lead.contact_type === 'phone' ? contact.replace(/[^\d+]/g, '') : '';

    // Дедуп: телефон — по phonesPrimaryPhoneNumber, TG — по nameLastName.
    let personId = null;
    if (phone) {
      const r = await c.query(
        `SELECT id FROM ${ws}.person WHERE "deletedAt" IS NULL AND "phonesPrimaryPhoneNumber" = $1 LIMIT 1`, [phone]);
      if (r.rows.length) personId = r.rows[0].id;
    }
    if (!personId) {
      const r = await c.query(
        `SELECT id FROM ${ws}.person WHERE "deletedAt" IS NULL AND "nameLastName" = $1 LIMIT 1`, [contact]);
      if (r.rows.length) personId = r.rows[0].id;
    }

    let created = false;
    if (!personId) {
      const ins = await c.query(
        `INSERT INTO ${ws}.person
           ("nameFirstName","nameLastName","phonesPrimaryPhoneNumber","createdBySource","createdByName")
         VALUES ($1,$2,$3,'IMPORT',$4) RETURNING id`,
        ['Лид с сайта', contact, phone || null, TAG]);
      personId = ins.rows[0].id;
      created = true;
    }

    // Сделка (раздел «Сделки» в Twenty): одна открытая на контакт — повторная
    // заявка добавляет заметку, а не плодит дубли сделок.
    let opportunityId = null;
    const exOpp = await c.query(
      `SELECT id FROM ${ws}.opportunity WHERE "deletedAt" IS NULL AND "pointOfContactId" = $1 LIMIT 1`, [personId]);
    if (exOpp.rows.length) {
      opportunityId = exOpp.rows[0].id;
    } else {
      const opp = await c.query(
        `INSERT INTO ${ws}.opportunity ("name","stage","pointOfContactId","createdBySource","createdByName")
         VALUES ($1,'NEW',$2,'IMPORT',$3) RETURNING id`,
        [`Заявка: ${contact}`, personId, TAG]);
      opportunityId = opp.rows[0].id;
    }

    // Заметка с полным контекстом заявки. Привязываем и к персоне, и к сделке,
    // чтобы в карточке сделки была вся переписка заявок.
    const utm = lead.utm && typeof lead.utm === 'object' ? lead.utm : {};
    const lines = [
      `**Контакт:** ${contact}`,
      lead.message ? `**Сообщение:** ${lead.message}` : null,
      lead.product ? `**Продукт:** ${lead.product}` : null,
      lead.offer ? `**Оффер:** ${lead.offer}` : null,
      lead.page ? `**Страница:** ${lead.page}` : null,
      lead.cta_position ? `**Точка CTA:** ${lead.cta_position}` : null,
      utm.utm_source ? `**UTM:** ${[utm.utm_source, utm.utm_medium, utm.utm_campaign].filter(Boolean).join(' / ')}` : null,
    ].filter(Boolean);
    const note = await c.query(
      `INSERT INTO ${ws}.note ("title","bodyV2Markdown","createdBySource","createdByName")
       VALUES ($1,$2,'IMPORT',$3) RETURNING id`,
      [`Заявка с сайта ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`, lines.join('\n'), TAG]);
    await c.query(
      `INSERT INTO ${ws}."noteTarget" ("noteId","targetPersonId","targetOpportunityId","createdBySource","createdByName")
       VALUES ($1,$2,$3,'IMPORT',$4)`, [note.rows[0].id, personId, opportunityId, TAG]);

    return { personId: String(personId), opportunityId: String(opportunityId), created };
  } finally { if (c) try { await c.end(); } catch { /* ignore */ } }
}

module.exports = { ping, pushLead, resetCache, TAG };
