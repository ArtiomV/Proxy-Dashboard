'use strict';

/**
 * BizDev — ступень 2 lead-engine. По компании находит контакты ЛПР
 * (CEO / основатель / топ-менеджмент): имя + роль + LinkedIn (+ общий контакт,
 * если попадётся). Платные email-finder'ы не используются — только Tavily
 * (бесплатно). Продавец (человек) дальше выходит на этих людей сам.
 */

const { Agent } = require('./runtime');
const { webSearch, webExtract } = require('./tools/tavily');
const { saveContact } = require('./tools/leads');

const ROLE = 'BizDev отдела продаж proxies.rent (поиск ЛПР)';
const GOAL =
  'Найти лиц, принимающих решения, в целевой компании и сохранить их контакты ' +
  '(имя, роль, LinkedIn) для менеджера-человека.';
const BACKSTORY = `
Ты биздев proxies.rent. Твоя работа — по компании найти ЛПР: кто принимает решение о закупке
инфраструктуры/инструментов (обычно CEO/основатель; в более крупных — CMO/Head of Marketing,
Head of Growth, CTO/Head of Data — выбери релевантных профилю компании).

Алгоритм:
1. web_search по «<компания> CEO / founder / Head of Growth LinkedIn»; при необходимости web_extract
   страниц About / Team / LinkedIn.
2. На каждого найденного — save_contact: имя, роль, ссылку на LinkedIn (ищи обязательно),
   общий контакт (email/форма/телега), если попадётся, и source_url.

Правила:
- Не выдумывай людей и ссылки — только из реальной выдачи. Лучше меньше, но достоверно.
- 1–3 человека на компанию (ключевые ЛПР, не весь штат).
- Если LinkedIn по человеку не нашёл — всё равно сохрани имя+роль с источником.
`.trim();

function createContactFinder(opts = {}) {
  return new Agent({
    role: ROLE, goal: GOAL, backstory: BACKSTORY,
    tools: [webSearch, webExtract, saveContact],
    maxSteps: opts.maxSteps || 12,
    maxTokens: opts.maxTokens || 20000,
    model: opts.model, effort: opts.effort, apiKey: opts.apiKey,
    logger: opts.logger || console,
  });
}

/** Find decision-maker contacts for one company. */
async function findContacts({ db, company, website, perCompany = 2, logger = console, runId, ...o }) {
  const agent = createContactFinder({ logger, ...o });
  const rid = (runId || `contacts-${company}-${Date.now()}`).replace(/\s+/g, '_');

  const task =
    `Компания: «${company}»${website ? ` (${website})` : ''}.\n` +
    `Найди до ${perCompany} ключевых ЛПР (CEO/основатель/CMO/Head of Growth/CTO/Head of Data).\n` +
    `Для каждого вызови save_contact: имя, роль, LinkedIn-URL (ищи обязательно), общий контакт если найдётся.\n` +
    `Не выдумывай. В конце кратко: кого нашёл.`;

  const out = await agent.run(task, { db, runId: rid });
  const found = db.prepare(`SELECT COUNT(*) AS n FROM sales_contacts WHERE run_id = ?`).get(rid).n;
  return { runId: rid, found, summary: out.text, usage: out.usage };
}

module.exports = { createContactFinder, findContacts, ROLE };
