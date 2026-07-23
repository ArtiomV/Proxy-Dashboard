// 2026-07-22: «выключил ротацию, а она ротируется» — корень: /conf/* на S2
// закрыт логин-стеной (302 → /modem/login), а дашборд парсил страницу логина
// как «нет поля → 0» (ложный «Выкл» в UI) и считал POST в стену успехом.
// Тесты: cookie-логин, честный AUTH_WALLED, parseRotation без подмены нулём.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'module';
import http from 'http';

const require = createRequire(import.meta.url);
const proxyConf = require('../../src/api/proxysmart-conf.js');
proxyConf.init({ logger: { info() {}, warn() {}, error() {}, debug() {} } });

const FORM = (rot) => `<html><body><form>
<p><label>Auto IP rotation</label><input class=crud type="text" name="AUTO_IP_ROTATION" value="${rot}"></p>
<p><label>Nick</label><input class=crud type="text" name="name" value="RO2_49"></p>
</form></body></html>`;

// Режимы стаба: 'open' — /conf открыт по basic; 'walled' — 302 на логин без cookie;
// 'wall-forever' — логин не выдаёт cookie.
let mode = 'open';
let loginHits = 0;
let lastPostedFields = null;

let srv, baseUrl;
beforeAll(async () => {
  srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const hasSession = String(req.headers.cookie || '').includes('session=abc123');
    if (u.pathname === '/modem/login' && req.method === 'POST') {
      loginHits++;
      if (mode === 'wall-forever') { res.writeHead(200); res.end('nope'); return; }
      // ДВЕ cookie: служебная первой, сессионная второй (как у реального S2)
      res.writeHead(302, { Location: '/', 'Set-Cookie': ['allowCGP=yes', 'session=abc123'] });
      res.end(); return;
    }
    if (u.pathname.startsWith('/conf/delete_port/')) {
      const walledOut = mode !== 'open' && !hasSession;
      if (walledOut) {
        res.writeHead(302, { Location: '/modem/login?next=' + encodeURIComponent(u.pathname) });
        res.end('<a href="/modem/login">login</a>'); return;
      }
      res.writeHead(302, { Location: '/conf' });   // ProxySmart: 302 → /conf = действие выполнено
      res.end(); return;
    }
    if (u.pathname.startsWith('/conf/edit/')) {
      const walledOut = mode !== 'open' && !hasSession;
      if (walledOut) {
        res.writeHead(302, { Location: '/modem/login?next=' + encodeURIComponent(u.pathname) });
        res.end('<a href="/modem/login">login</a>'); return;
      }
      if (req.method === 'POST') {
        let body = '';
        req.on('data', (c) => body += c);
        req.on('end', () => {
          lastPostedFields = Object.fromEntries(new URLSearchParams(body));
          res.writeHead(302, { Location: '/conf' });
          res.end();
        });
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(FORM('10'));
      return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${srv.address().port}`;
});
afterAll(() => srv && srv.close());

const server = (name) => ({ name, url: baseUrl, user: 'proxy', pass: 'secret' });

describe('proxysmart-conf: обход логин-стены /conf/*', () => {
  it('open-сервер: форма читается напрямую, ротация парсится', async () => {
    mode = 'open';
    const form = await proxyConf.getConfForm(server('T_open'), '/conf/edit/531737907724202');
    expect(form.ok).toBe(true);
    expect(form.fields.AUTO_IP_ROTATION).toBe('10');
    expect(proxyConf.parseRotation(form.html)).toBe(10);
  });

  it('walled-сервер: логинится и читает форму; сессия кэшируется', async () => {
    mode = 'walled'; loginHits = 0;
    const s = server('T_walled');
    const f1 = await proxyConf.getConfForm(s, '/conf/edit/531737907724202');
    expect(f1.ok).toBe(true);
    expect(f1.fields.AUTO_IP_ROTATION).toBe('10');
    expect(loginHits).toBe(1);
    const f2 = await proxyConf.getConfForm(s, '/conf/edit/531737907724202');
    expect(f2.ok).toBe(true);
    expect(loginHits).toBe(1);   // повторный логин не понадобился
  });

  it('стена не пробивается → честный AUTH_WALLED (а не молчаливый 0)', async () => {
    mode = 'wall-forever';
    const form = await proxyConf.getConfForm(server('T_wallf'), '/conf/edit/531737907724202');
    expect(form.ok).toBe(false);
    expect(form.reason).toBe('AUTH_WALLED');
  });

  it('POST через стену: логин + ретрай с cookie, поля доходят', async () => {
    mode = 'walled'; lastPostedFields = null;
    const r = await proxyConf.postConfForm(server('T_walled'), '/conf/edit/531737907724202', { AUTO_IP_ROTATION: '0', name: 'RO2_49' });
    expect(r.ok).toBe(true);
    expect(lastPostedFields.AUTO_IP_ROTATION).toBe('0');
    expect(lastPostedFields.name).toBe('RO2_49');
  });

  it('parseRotation: пустое value → 0 (выкл), нет поля → null (неизвестно)', () => {
    expect(proxyConf.parseRotation(FORM(''))).toBe(0);
    expect(proxyConf.parseRotation(FORM('1440'))).toBe(1440);
    expect(proxyConf.parseRotation('<html><body>no form</body></html>')).toBe(null);
    expect(proxyConf.parseRotation('<a href="/modem/login">login</a>')).toBe(null);
  });

  it('getConfAction: open-сервер — GET-действие проходит напрямую', async () => {
    mode = 'open';
    const r = await proxyConf.getConfAction(server('T_act_open'), '/conf/delete_port/portXYZ');
    expect(r.ok).toBe(true);
  });

  it('getConfAction: walled-сервер — логин + ретрай, успех', async () => {
    mode = 'walled';
    const r = await proxyConf.getConfAction(server('T_act_walled'), '/conf/delete_port/portXYZ');
    expect(r.ok).toBe(true);
  });

  it('getConfAction: стена не пробивается → AUTH_WALLED', async () => {
    mode = 'wall-forever';
    const r = await proxyConf.getConfAction(server('T_act_wallf'), '/conf/delete_port/portXYZ');
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('AUTH_WALLED');
  });

  it('getConfAction: 404 от ProxySmart → HTTP_404, не «успех»', async () => {
    mode = 'open';
    const r = await proxyConf.getConfAction(server('T_act_404'), '/conf/nowhere');
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('HTTP_404');
  });
});
