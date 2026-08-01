// fetchApiPanel (2026-08-01): /apix/reboot_server sits behind the ProxySmart
// WEB PANEL session auth — plain basic-auth GET gets a 302 to /modem/login.
// The helper must log in (POST /modem/login), cache the Flask session cookie,
// call the endpoint with it, and relogin once if the session dies mid-way.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const http = require('http');
const proxySmart = require('../src/api/proxy-smart.js');

let srv, base, hits;

beforeAll(async () => {
  hits = { login: 0, action: 0 };
  srv = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url.startsWith('/modem/login')) {
      hits.login++;
      let body = '';
      req.on('data', c => body += c);
      req.on('end', () => {
        if (body.includes('username=proxy') && body.includes('password=secret')) {
          res.writeHead(302, { 'Set-Cookie': 'session=testcookie123; HttpOnly; Path=/', 'Location': '/' });
          return res.end();
        }
        res.writeHead(403); res.end('bad creds');
      });
      return;
    }
    if (req.method === 'GET' && req.url.startsWith('/apix/reboot_server')) {
      hits.action++;
      if ((req.headers.cookie || '').includes('session=testcookie123')) {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        return res.end('OK');
      }
      res.writeHead(302, { 'Location': '/modem/login?next=%2Fapix%2Freboot_server' });
      return res.end('<!DOCTYPE HTML><html>login</html>');
    }
    res.writeHead(404); res.end();
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${srv.address().port}`;
  proxySmart.init({
    http, https: require('https'),
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    apiServers: [], safeWriteFile: () => {},
  });
});

afterAll(() => new Promise(r => srv.close(r)));

describe('fetchApiPanel', () => {
  it('логинится в панель, зовёт gated endpoint с кукой, кэширует сессию', async () => {
    const server = { name: 'T', url: base, user: 'proxy', pass: 'secret' };
    const r1 = await proxySmart.fetchApiPanel(server, '/apix/reboot_server');
    expect(r1.raw).toBe('OK');
    expect(hits.login).toBe(1);
    expect(hits.action).toBe(1);
    // Второй вызов — без повторного логина (кука закэширована).
    const r2 = await proxySmart.fetchApiPanel(server, '/apix/reboot_server');
    expect(r2.raw).toBe('OK');
    expect(hits.login).toBe(1);
    expect(hits.action).toBe(2);
  });
});
