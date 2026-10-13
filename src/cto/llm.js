'use strict';
//
// src/cto/llm.js — вызов Claude для осмотра: принудительный tool-call
// submit_review (структурированный ответ без разбора текста). Ключ — как у
// ИИ-анализа сводки: env ANTHROPIC_API_KEY или настройка anthropic_api_key.

let Anthropic;
try { Anthropic = require('@anthropic-ai/sdk'); } catch (_) { Anthropic = null; }

function create({ getSetting }) {
  let client = null, clientKey = null;
  function getClient() {
    const key = process.env.ANTHROPIC_API_KEY || getSetting('anthropic_api_key', '');
    if (!key || !Anthropic) return null;
    if (client && clientKey === key) return client;
    client = new Anthropic({ apiKey: key }); clientKey = key;
    return client;
  }

  async function callModel({ model, system, user, schema }) {
    const c = getClient();
    if (!c) throw new Error('нет ANTHROPIC_API_KEY (env или настройка anthropic_api_key)');
    const resp = await c.messages.create({
      model, max_tokens: 8000, system,
      tools: [{ name: 'submit_review', description: 'Отправить итог осмотра и предложения', input_schema: schema }],
      tool_choice: { type: 'tool', name: 'submit_review' },
      messages: [{ role: 'user', content: user }],
    });
    const block = (resp.content || []).find(b => b.type === 'tool_use' && b.name === 'submit_review');
    if (!block) throw new Error(`модель не вернула submit_review (stop=${resp.stop_reason})`);
    return { input: block.input, usage: resp.usage || {} };
  }
  return { callModel, getClient };
}

module.exports = { create };
