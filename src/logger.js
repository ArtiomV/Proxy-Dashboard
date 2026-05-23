const pino = require('pino');
const path = require('path');
const fs = require('fs');

const LOG_DIR = path.join(__dirname, '..', 'logs');
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

const logFile = path.join(LOG_DIR, 'dashboard.log');

// Always log to file (append mode) + pretty console in dev
const streams = [
  { stream: fs.createWriteStream(logFile, { flags: 'a' }) },
];
if (process.env.NODE_ENV !== 'production') {
  streams.push({ stream: process.stdout });
}

const base = pino({
  level: process.env.LOG_LEVEL || 'info',
  timestamp: pino.stdTimeFunctions.isoTime,
}, pino.multistream(streams));

// The codebase has a long-standing pattern of `logger.error('[tag] msg:', e.message)`.
// Pino's signature is `.error(obj, msg)` — with two strings, the second is silently dropped.
// Wrap each level so extra args (strings / Errors / primitives) are merged into the msg.
// This keeps every existing call site working without mass edits.
function mergeArgs(args) {
  if (args.length === 0) return ['(no message)'];
  const first = args[0];
  // Preserve pino semantics when 1st arg is an object (data) — concatenate extras into msg
  if (first && typeof first === 'object' && !(first instanceof Error)) {
    const rest = args.slice(1).map(fmt).filter(Boolean).join(' ');
    return rest ? [first, rest] : [first];
  }
  // All-string (or Error) path: concatenate everything into a single message
  return [args.map(fmt).filter(Boolean).join(' ')];
}
function fmt(v) {
  if (v == null) return '';
  if (v instanceof Error) return v.stack || v.message || String(v);
  if (typeof v === 'object') { try { return JSON.stringify(v); } catch (_) { return '[object]'; } }
  return String(v);
}

const logger = Object.create(base);
for (const lvl of ['trace','debug','info','warn','error','fatal']) {
  logger[lvl] = function(...args) { return base[lvl](...mergeArgs(args)); };
}
// child() should inherit the same wrapping
logger.child = function(bindings) {
  const c = base.child(bindings);
  const wrapped = Object.create(c);
  for (const lvl of ['trace','debug','info','warn','error','fatal']) {
    wrapped[lvl] = function(...args) { return c[lvl](...mergeArgs(args)); };
  }
  return wrapped;
};

module.exports = logger;
