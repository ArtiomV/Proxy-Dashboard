'use strict';
// AST inventory, not a proof of exception safety. No application code is executed.
const fs = require('node:fs');
const path = require('node:path');
const espree = require('espree');
const ROOT = path.resolve(__dirname, '../..');
const files = ['server.js', ...fs.readdirSync(path.join(ROOT, 'src/routes')).filter(f => f.endsWith('.js')).map(f => 'src/routes/' + f)];
const rows = [];
function children(node) {
  return Object.values(node).flatMap(v => Array.isArray(v) ? v.filter(x => x && typeof x.type === 'string') : v && typeof v.type === 'string' ? [v] : []);
}
function isFunction(n) { return /^(?:FunctionDeclaration|FunctionExpression|ArrowFunctionExpression)$/.test(n.type); }
for (const file of files) {
  const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const ast = espree.parse(source, { ecmaVersion: 'latest', sourceType: 'script', loc: true });
  function visit(node) {
    if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression') {
      const method = node.callee.property.name;
      const route = node.arguments[0];
      if (['get', 'post', 'put', 'patch', 'delete', 'all', 'use'].includes(method) && route && route.type === 'Literal' && typeof route.value === 'string') {
        for (const fn of node.arguments.slice(1).filter(n => isFunction(n) && n.async)) {
          const unguardedAwaits = [];
          function inspect(n, guarded) {
            if (isFunction(n)) return;
            if (n.type === 'AwaitExpression' && !guarded) unguardedAwaits.push(n.loc.start.line);
            if (n.type === 'TryStatement') {
              inspect(n.block, guarded || !!n.handler);
              if (n.handler) inspect(n.handler, guarded);
              if (n.finalizer) inspect(n.finalizer, guarded);
              return;
            }
            children(n).forEach(c => inspect(c, guarded));
          }
          inspect(fn.body, false);
          rows.push({ file, line: fn.loc.start.line, method: method.toUpperCase(), route: route.value, unguardedAwaits });
        }
      }
    }
    children(node).forEach(visit);
  }
  visit(ast);
}
const risky = rows.filter(r => r.unguardedAwaits.length);
const out = [
  '# Инвентаризация прямых async HTTP handlers', '',
  'Статический AST-разбор server.js и src/routes/*.js. Код приложения не исполняется.', '',
  `Прямых async callback: ${rows.length}; с await вне лексического try/catch: ${risky.length}.`, '',
  'Это список для проверки DEEP-60, а не число новых багов. Promise.catch у самого await может обрабатывать ошибку; напротив, синхронный throw внутри async тоже создаёт rejection. Callback по имени, обёртки и динамические пути не разрешаются. Catch/finally сами могут бросить ошибку. Отсутствие строки в первой группе не доказывает безопасность.', '',
  '## Приоритет проверки: await вне try/catch', '',
  '| Файл:строка | Метод | Путь | Строки await |', '|---|---|---|---|',
  ...risky.map(r => `| ${r.file}:${r.line} | ${r.method} | ${r.route} | ${r.unguardedAwaits.join(', ')} |`), '',
  '## Остальные прямые async callbacks — требуют проверки остальных исключений', '',
  ...rows.filter(r => !r.unguardedAwaits.length).map(r => `- ${r.file}:${r.line} — ${r.method} ${r.route}`), '',
].join('\n');
fs.writeFileSync(path.join(__dirname, 'ASYNC-ROUTES.md'), out);
console.log(JSON.stringify({ scannedFiles: files.length, directAsyncCallbacks: rows.length, withAwaitOutsideTryCatch: risky.length, artifact: 'docs/audit-2026-09-13/ASYNC-ROUTES.md' }));
