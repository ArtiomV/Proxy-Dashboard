// 2026-10-13: страж исходящих HTTP-сокетов (src/boot/http-client-guard.js).
// Внутренний ассерт Node в socketOnData дважды ронял прод посреди
// http-check. Страж обязан: опознать именно этот ассерт, закрыть сломанный
// сокет, назвать запрос (без query-строки) и не валить процесс.

import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import { execFileSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const guard = require('../src/boot/http-client-guard.js');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('http-client-guard', () => {
  it('ассерт socketOnData гасится: сокет закрыт, запрос назван, процесс жив', () => {
    const outRaw = execFileSync(process.execPath, [
      path.join(root, 'tests/fixtures/http-guard-child.cjs'),
      path.join(root, 'src/boot/http-client-guard.js'),
    ], { encoding: 'utf8', timeout: 20000 });
    const out = JSON.parse(outRaw.trim().split('\n').pop());
    expect(out.handled).toBeGreaterThanOrEqual(1);
    expect(out.socketDestroyed).toBe(true);
    expect(out.otherRequestOk).toBe(true);
    expect(out.info).toContain('GET 127.0.0.1');
    expect(out.info).toContain('/apix/test');
    expect(out.info).not.toContain('secret');
    expect(out.info).toContain('parser=null');
  });

  it('пассивность: на сокетах нет слушателей данных от стража (иначе ломаются длинные HTTPS-ответы)', () => {
    const outRaw = execFileSync(process.execPath, ['-e', `
      const guard = require(${JSON.stringify(path.join(root, 'src/boot/http-client-guard.js'))});
      guard.install();
      const http = require('http');
      const srv = http.createServer((q, r) => r.end('ok')).listen(0, () => {
        const req = http.get({ port: srv.address().port, agent: false }, (res) => {
          const before = req.socket.listenerCount('data');
          res.resume(); res.on('end', () => { console.log(JSON.stringify({ before, live: guard._liveCount() })); process.exit(0); });
        });
      });
    `], { encoding: 'utf8', timeout: 20000 });
    const o = JSON.parse(outRaw.trim().split('\n').pop());
    expect(o.before).toBe(1);        // только парсер Node
    expect(o.live).toBe(1);
  });

  it('прочие исключения не перехватывает', () => {
    expect(guard.handleUncaught(new Error('boom'))).toBe(false);
    const e = new Error('x'); e.code = 'ERR_INTERNAL_ASSERTION'; e.stack = 'at other (node:internal/foo)';
    expect(guard.handleUncaught(e)).toBe(false);
  });
});
