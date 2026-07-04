'use strict';

/**
 * Minimal crewAI-style agent runtime on the Anthropic SDK.
 *
 * An Agent is a role + goal + backstory (→ system prompt) plus a set of
 * function-calling tools. `run()` drives the manual tool-use loop: stream a
 * turn, execute any tool calls, feed results back, repeat until the model
 * stops asking for tools (stop_reason 'end_turn') or `maxSteps` is hit.
 *
 * Per-turn streaming via `.finalMessage()` is used so adaptive thinking +
 * effort don't trip the non-stream SDK timeout — the same proven approach as
 * src/telegram/ai_insights.js. SDK 0.39 forwards `thinking`/`output_config`.
 *
 * Tools are plain objects:
 *   { name, description, input_schema, async run(input, ctx) -> any }
 * Whatever run() returns is JSON-stringified back to the model as a
 * tool_result. Throwing inside run() is reported to the model as an error so
 * it can adapt, not crash the loop.
 */

let Anthropic;
try { Anthropic = require('@anthropic-ai/sdk').default; } catch { Anthropic = null; }

const DEFAULT_MODEL  = process.env.AGENTS_MODEL  || 'claude-opus-4-8';
const DEFAULT_EFFORT = process.env.AGENTS_EFFORT || 'high';

class Agent {
  /**
   * @param {object} o
   * @param {string} o.role      job title → "Ты — {role}."
   * @param {string} o.goal      what success looks like
   * @param {string} [o.backstory] expertise / rules / algorithm
   * @param {Array}  [o.tools]   tool objects (see file header)
   * @param {string} [o.model]   default claude-opus-4-8 (configurable, AGENTS_MODEL)
   * @param {string} [o.effort]  low|medium|high|max (AGENTS_EFFORT)
   * @param {number} [o.maxSteps] hard cap on tool-use turns
   * @param {number} [o.maxTokens] per-turn ceiling (room for adaptive thinking)
   * @param {string} [o.apiKey]  overrides process.env.ANTHROPIC_API_KEY
   * @param {object} [o.logger]
   */
  constructor({ role, goal, backstory = '', tools = [], model = DEFAULT_MODEL,
                effort = DEFAULT_EFFORT, maxSteps = 16, maxTokens = 24000,
                apiKey = null, logger = console } = {}) {
    this.role = role;
    this.system = `Ты — ${role}.\n\nЦель: ${goal}\n\n${backstory}`.trim();
    this.tools = tools;
    this.model = model;
    this.effort = effort;
    this.maxSteps = maxSteps;
    this.maxTokens = maxTokens;
    this.apiKey = apiKey;
    this.logger = logger;
    this.usage = { input_tokens: 0, output_tokens: 0, steps: 0, tool_calls: 0 };
  }

  _client() {
    if (!Anthropic) throw new Error('@anthropic-ai/sdk не установлен');
    const key = this.apiKey || process.env.ANTHROPIC_API_KEY;
    if (!key) throw new Error('ANTHROPIC_API_KEY не задан');
    // Bounded timeout + retries so a slow/hung call can't stall the loop.
    return new Anthropic({ apiKey: key, timeout: 120000, maxRetries: 2 });
  }

  _toolDefs() {
    return this.tools.map(({ name, description, input_schema }) =>
      ({ name, description, input_schema }));
  }

  /**
   * Run the agent on a task. `ctx` is passed verbatim to every tool's run()
   * (e.g. { db, runId, segment }).
   * @returns {Promise<{text:string, usage:object, messages:Array, truncated?:boolean}>}
   */
  async run(task, ctx = {}) {
    const client = this._client();
    const toolDefs = this._toolDefs();
    const messages = [{ role: 'user', content: task }];

    for (let step = 0; step < this.maxSteps; step++) {
      this.usage.steps++;
      const stream = await client.messages.stream({
        model: this.model,
        max_tokens: this.maxTokens,
        thinking: { type: 'adaptive' },
        output_config: { effort: this.effort },
        system: this.system,
        tools: toolDefs,
        messages,
      });
      const msg = await stream.finalMessage();
      this.usage.input_tokens  += msg.usage?.input_tokens  || 0;
      this.usage.output_tokens += msg.usage?.output_tokens || 0;

      // Always echo the assistant turn back (preserves thinking + tool_use).
      messages.push({ role: 'assistant', content: msg.content });

      if (msg.stop_reason !== 'tool_use') {
        const text = msg.content
          .filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
        return { text, usage: this.usage, messages, stop_reason: msg.stop_reason };
      }

      // Execute every requested tool, collect results for one user turn.
      const toolUses = msg.content.filter(b => b.type === 'tool_use');
      const results = [];
      for (const tu of toolUses) {
        this.usage.tool_calls++;
        const tool = this.tools.find(t => t.name === tu.name);
        let content, is_error = false;
        try {
          if (!tool) throw new Error(`неизвестный инструмент ${tu.name}`);
          const out = await tool.run(tu.input || {}, ctx);
          content = typeof out === 'string' ? out : JSON.stringify(out);
        } catch (e) {
          content = `Error: ${e.message}`;
          is_error = true;
          this.logger.warn?.(`[agent:${this.role}] tool ${tu.name} failed: ${e.message}`);
        }
        results.push({ type: 'tool_result', tool_use_id: tu.id, content, is_error });
      }
      messages.push({ role: 'user', content: results });
    }

    this.logger.warn?.(`[agent:${this.role}] maxSteps (${this.maxSteps}) reached`);
    return { text: '', usage: this.usage, messages, truncated: true };
  }
}

module.exports = { Agent, DEFAULT_MODEL, DEFAULT_EFFORT };
