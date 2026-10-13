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
 *     Строка подключения (с паролем) задаётся ТОЛЬКО настройкой crm_db_url
 *     (Настройки → CRM, хранится зашифрованной) или env CRM_DB_URL — в коде
 *     пароля нет (был зашит до 2026-10-12, из истории git ротирован).
 *   - Имя workspace-схемы (workspace_xxx) тоже нестабильно — после
 *     переустановки Twenty оно другое. Схему авто-определяем: ищем
 *     workspace_* схему, в которой есть таблица person. Кэшируем в память.
 *
 * Что создаём в Twenty:
 *   - person: nameFirstName='Лид с сайта', nameLastName=<контакт>, телефон —
 *     в phonesPrimaryPhoneNumber (для TG-контакта телефона нет — handle
 *     остаётся в nameLastName и теле заметки). Дедуп по телефону / контакту:
 *     если персона уже есть — только добавляем заметку.
 *   - opportunity (раздел «Сделки»): «Заявка: <контакт>», стартовая стадия
 *     воронки (NEW_LEAD/NEW/первое значение enum'а — определяется из базы),
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

let _wsSchema = null;   // кэш авто-определённой workspace-схемы
let _leadStage = null;  // кэш валидной стартовой стадии сделки

/** Стартовая стадия воронки: читаем enum из самой базы (15.08: хардкод 'NEW'
 *  упал — в воронке владельца стадия называется 'NEW_LEAD'). Предпочитаем
 *  NEW_LEAD → NEW → первое значение enum'а. */
async function _stage(c, ws) {
  if (_leadStage) return _leadStage;
  const r = await c.query(
    `SELECT e.enumlabel FROM pg_enum e
       JOIN pg_type t ON e.enumtypid = t.oid
       JOIN pg_namespace n ON t.typnamespace = n.oid
     WHERE n.nspname = $1 AND t.typname = 'opportunity_stage_enum'
     ORDER BY e.enumsortorder`, [ws]);
  const labels = r.rows.map(x => x.enumlabel);
  _leadStage = labels.includes('NEW_LEAD') ? 'NEW_LEAD'
             : labels.includes('NEW') ? 'NEW' : labels[0];
  if (!_leadStage) throw new Error('Twenty: opportunity_stage_enum пуст — задайте стадии воронки в CRM');
  return _leadStage;
}

function _dbUrl(getSetting) {
  const url = (getSetting && getSetting('crm_db_url', '')) || process.env.CRM_DB_URL || '';
  if (!url) {
    throw new Error('crm_db_url не задан (Настройки → CRM или env CRM_DB_URL): '
      + 'postgresql://twenty:<пароль>@127.0.0.1:5432/default');
  }
  return url;
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

/** Сброс кэша схемы и стадии (после переустановки Twenty / смены воронки). */
function resetCache() { _wsSchema = null; _leadStage = null; }

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

/** Telegram-ник из контакта заявки: «@name», «t.me/name», «https://t.me/name?x» → name (нижний регистр);
 *  не ник (телефон, мусор) → ''. Нужен, чтобы заявка и последующий чат склеились в ОДИН контакт. */
function tgUsername(contact, contactType) {
  let v = String(contact || '').trim();
  if (!v) return '';
  if (contactType !== 'telegram' && !/t\.me\/|^@/i.test(v)) return '';
  v = v.replace(/^https?:\/\//i, '').replace(/^(www\.)?t\.me\//i, '').replace(/^@/, '').split(/[/?#]/)[0];
  return /^[A-Za-z0-9_]{4,32}$/.test(v) ? v.toLowerCase() : '';
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

    const username = tgUsername(contact, lead.contact_type);

    // Дедуп: телефон — по phonesPrimaryPhoneNumber, TG — по telegramUsername (контакт мог уже
    // создать импортёр из чата), затем по nameLastName.
    let personId = null;
    if (username) {
      const r = await c.query(
        `SELECT id FROM ${ws}.person WHERE "deletedAt" IS NULL AND lower("telegramUsername") = $1 LIMIT 1`, [username]);
      if (r.rows.length) personId = r.rows[0].id;
    }
    if (!personId && phone) {
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
           ("nameFirstName","nameLastName","phonesPrimaryPhoneNumber","telegramUsername","importSource","createdBySource","createdByName")
         VALUES ($1,$2,$3,$4,'site-lead','IMPORT',$5) RETURNING id`,
        ['Лид с сайта', contact, phone || null, username || null, TAG]);
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
      // входящая заявка помечает «входящий поток» и у ранее созданной (чатом/вручную) сделки
      await c.query(`UPDATE ${ws}.opportunity SET "leadSource" = 'INBOUND' WHERE id = $1 AND "leadSource" IS NULL`,
        [opportunityId]);
    } else {
      const opp = await c.query(
        `INSERT INTO ${ws}.opportunity ("name","stage","pointOfContactId","leadSource","createdBySource","createdByName")
         VALUES ($1,$2,$3,'INBOUND','IMPORT',$4) RETURNING id`,
        [`Заявка: ${contact}`, await _stage(c, ws), personId, TAG]);
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

module.exports = { ping, pushLead, resetCache, tgUsername, TAG };
