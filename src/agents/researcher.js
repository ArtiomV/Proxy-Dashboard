'use strict';

/**
 * Researcher — ступень 1 self-expanding lead-engine.
 *
 * Берёт seed-компанию (добавленную вручную / реального клиента), исследует её,
 * выводит НИШУ (сегмент похожих покупателей прокси) и находит look-alike
 * компании в этой нише. Контакты не ищет — это делает bizdev (ступень 2).
 * Режим refresh добирает НОВЫЕ компании по уже известной нише.
 */

const { Agent } = require('./runtime');
const { webSearch, webExtract } = require('./tools/tavily');
const { productKnowledge } = require('./tools/product');
const { saveNiche, saveCompany } = require('./tools/leads');

const ROLE = 'Исследователь рынка отдела продаж proxies.rent';
const GOAL =
  'По seed-компании вывести нишу похожих покупателей мобильных прокси и собрать ' +
  'список реальных компаний-кандидатов из этой ниши.';
const BACKSTORY = `
Ты аналитик рынка proxies.rent. Знаешь, что мобильные прокси покупают компании, которым нужно много
чистых IP: парсинг/скрейпинг и data-extraction, мониторинг цен и competitor intelligence,
ad-verification/антифрод, SEO/rank-tracking, market research, performance/affiliate-маркетинг.

Жёсткие правила (важнее всего):
- Сохраняй ТОЛЬКО компании-ПОКУПАТЕЛИ. НЕ сохраняй: продавцов/провайдеров прокси, обзоры/листиклы/блоги
  ("топ-10 прокси"), маркетплейсы, агрегаторы вакансий, википедию. Если результат — статья, а не компания,
  это не компания.
- Не выдумывай названия и сайты — бери из реальной выдачи (web_search / web_extract).
- Качество выше количества. Ниша — это КЛАСС бизнеса, а не одна фирма.
`.trim();

function createResearcher(opts = {}) {
  return new Agent({
    role: ROLE, goal: GOAL, backstory: BACKSTORY,
    tools: [productKnowledge, webSearch, webExtract, saveNiche, saveCompany],
    maxSteps: opts.maxSteps || 20,
    maxTokens: opts.maxTokens || 24000,
    model: opts.model, effort: opts.effort, apiKey: opts.apiKey,
    logger: opts.logger || console,
  });
}

/** Profile a seed company → infer niche → save seed + N look-alikes. */
async function profileSeed({ db, seed, count = 6, logger = console, runId, ...o }) {
  const agent = createResearcher({ logger, ...o });
  const rid = (runId || `seed-${seed}-${Date.now()}`).replace(/\s+/g, '_');

  const task =
    `Seed-компания: «${seed}».\n` +
    `1) Сначала вызови product_knowledge — под кого наш продукт.\n` +
    `2) Изучи seed через web_search/web_extract: чем занимается, какой продукт, ПОЧЕМУ ей реально нужны мобильные прокси.\n` +
    `3) Вызови save_niche — определи нишу (сегмент похожих компаний-покупателей) и почему нише нужны прокси.\n` +
    `4) Вызови save_company для самой seed (is_seed=true, niche=<имя ниши>).\n` +
    `5) Найди ${count} ДРУГИХ реальных компаний этой же ниши (аналоги/конкуренты-покупатели). Делай несколько разных запросов. ` +
    `На каждую релевантную — save_company с honest fit_score, why_fit и niche=<имя ниши>.\n` +
    `В конце кратко: какая ниша и сколько компаний сохранил.`;

  const out = await agent.run(task, { db, runId: rid });
  const companies = db.prepare(
    `SELECT COUNT(*) AS n FROM sales_companies WHERE run_id = ? AND is_seed = 0`
  ).get(rid).n;
  const nr = db.prepare(
    `SELECT niche_name FROM sales_companies WHERE run_id = ? AND niche_name <> '' LIMIT 1`
  ).get(rid);
  return { runId: rid, niche: nr ? nr.niche_name : '', companies, summary: out.text, usage: out.usage };
}

/** Re-scan a known niche for NEW companies (skipping ones already staged). */
async function refreshNiche({ db, niche, count = 6, logger = console, runId, ...o }) {
  const agent = createResearcher({ logger, ...o });
  const rid = (runId || `refresh-${niche.name}-${Date.now()}`).replace(/\s+/g, '_');
  const known = db.prepare(`SELECT company FROM sales_companies WHERE niche_id = ?`).all(niche.id).map(r => r.company);

  const task =
    `Ниша: «${niche.name}» — ${niche.description}.\n` +
    `Уже известны (НЕ дублируй их): ${known.slice(0, 40).join(', ') || '—'}.\n` +
    `Найди ${count} НОВЫХ реальных компаний этой ниши (покупатели прокси, не продавцы/листиклы). ` +
    `На каждую — save_company с niche="${niche.name}", honest fit_score и why_fit.\n` +
    `В конце кратко: сколько новых компаний сохранил.`;

  const out = await agent.run(task, { db, runId: rid });
  const companies = db.prepare(
    `SELECT COUNT(*) AS n FROM sales_companies WHERE run_id = ? AND is_seed = 0`
  ).get(rid).n;
  return { runId: rid, companies, summary: out.text, usage: out.usage };
}

module.exports = { createResearcher, profileSeed, refreshNiche, ROLE };
