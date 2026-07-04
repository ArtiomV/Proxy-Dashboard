'use strict';

/**
 * Tavily-backed web tools for outbound BizDev research.
 *   web_search  — find prospects / communities / resellers by query
 *   web_extract — pull readable content from a specific URL for enrichment
 *
 * Key: TAVILY_API_KEY (.env). This file is the provider boundary — swap it to
 * change search provider; the agent only ever sees the two tool names.
 */

const { fetch } = require('undici');

const TAVILY = 'https://api.tavily.com';

async function _tavily(path, body) {
  const key = process.env.TAVILY_API_KEY;
  if (!key) throw new Error('TAVILY_API_KEY не задан');
  // Hard timeout so a hung request can't stall the agent loop.
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 25000);
  let res;
  try {
    res = await fetch(`${TAVILY}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${key}`,
      },
      body: JSON.stringify(body),
      signal: ctl.signal,
    });
  } catch (e) {
    throw new Error(`Tavily ${path} request failed: ${e.name === 'AbortError' ? 'timeout 25s' : e.message}`);
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`Tavily ${path} ${res.status}: ${t.slice(0, 200)}`);
  }
  return res.json();
}

const webSearch = {
  name: 'web_search',
  description:
    'Поиск в интернете для аутбаунд-разведки: найти потенциальных клиентов, ' +
    'сообщества, каналы, форумы, reseller\'ов, команды. Возвращает заголовки, URL ' +
    'и сниппеты. Делай несколько разных запросов под сегмент. Вызывай, когда нужно ' +
    'найти лиды или проверить нишу/компанию.',
  input_schema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Поисковый запрос (рус/англ)' },
      max_results: { type: 'integer', description: '1..10, по умолчанию 6' },
    },
    required: ['query'],
  },
  async run({ query, max_results = 6 }) {
    const data = await _tavily('/search', {
      query,
      max_results: Math.max(1, Math.min(10, max_results)),
      search_depth: 'basic',
    });
    return {
      query,
      answer: data.answer || '',
      results: (data.results || []).map(r => ({
        title: r.title,
        url: r.url,
        content: (r.content || '').slice(0, 500),
      })),
    };
  },
};

const webExtract = {
  name: 'web_extract',
  description:
    'Достать читаемый текст с конкретного URL для обогащения карточки prospect\'а ' +
    '(контакты, ниша, сигналы). Вызывай для 1-2 самых перспективных ссылок из web_search.',
  input_schema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'URL для извлечения' },
    },
    required: ['url'],
  },
  async run({ url }) {
    const data = await _tavily('/extract', { urls: [url] });
    const r = (data.results || [])[0];
    return { url, content: (r?.raw_content || '').slice(0, 4000) };
  },
};

module.exports = { webSearch, webExtract, _tavily };
