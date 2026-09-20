// 2026-09-18 · Регрессии DEEP-25 / DEEP-27 (FIX-SPEC §15.3): транзакционные
// учётные записи и смена пароля. Настоящие SQLite repositories (clients,
// auth_tokens) и настоящее приложение (supertest); bcrypt заглушен
// (быстрый детерминированный хэш 'vh_<pwd>'), гонки — управляемые
// Promise-барьеры, без sleep.
// На коде до исправления падали:
//   • гонка register одного email — оба 200 и ДВА durable-клиента (UNIQUE по
//     lower(email) не было, push шёл до saveClients, pop сносил чужого);
//   • сбой bcrypt.hash в reset_password сжигал токен (consume до hash) —
//     повтор по той же ссылке давал 400;
//   • login, начавший bcrypt.compare со старым хэшем до reset, получал новую
//     сессию по уже сменённому паролю (проверки auth version не было).

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import { createRequire } from 'module';
import { bootApp } from './_helpers/app.js';

const cjsRequire = createRequire(import.meta.url);
const bcrypt = cjsRequire('bcrypt');
const stateMod = cjsRequire('../src/state/index.js');
const authTokensDb = cjsRequire('../src/db/auth-tokens.js');
const clientsDb = cjsRequire('../src/db/clients.js');

let app, db, saveClients;
const DOM = 'deep27.local';

function deferred() {
  let resolve, reject;
  const p = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { p, resolve, reject };
}

// Быстрый детерминированный хэш — чтобы тесты не зависели от rounds.
function stubHashFast() {
  return vi.spyOn(bcrypt, 'hash').mockImplementation((pwd) => Promise.resolve('vh_' + pwd));
}

function setRetail(on) {
  const row = db.prepare('SELECT value FROM kv_store WHERE key = ?').get('app_settings');
  const settings = row ? JSON.parse(row.value) : {};
  settings.retail_enabled = on;
  db.prepare("INSERT OR REPLACE INTO kv_store (key, value, updated_at) VALUES (?, ?, datetime('now'))")
    .run('app_settings', JSON.stringify(settings));
  stateMod.state.appSettings.retail_enabled = on;
}

function cleanup() {
  db.prepare('DELETE FROM clients WHERE email LIKE ?').run('%@' + DOM);
  db.prepare("DELETE FROM sessions WHERE login LIKE 'u_%'").run();
  db.prepare("DELETE FROM auth_tokens WHERE login LIKE 'u_%'").run();
  const arr = stateMod.state.clients;
  for (let i = arr.length - 1; i >= 0; i--) {
    if ((arr[i].email || '').endsWith('@' + DOM)) arr.splice(i, 1);
  }
  stateMod.rebuildMaps();
}

async function registerClient(email, password) {
  const hashSpy = stubHashFast();
  try {
    const res = await request(app).post('/api/register').send({ email, password, consent: true });
    expect(res.status).toBe(200);
    return res.body.login;
  } finally {
    hashSpy.mockRestore();
  }
}

function clientRow(login) {
  return db.prepare('SELECT password_hash, email_verified, auth_version FROM clients WHERE login = ?').get(login);
}
function clientMem(login) {
  return stateMod.state.clients.find(c => c.login === login);
}

beforeAll(() => {
  const ctx = bootApp();
  app = ctx.app;
  db = ctx.db;
  saveClients = ctx.saveClients;
  cleanup();
  setRetail(true);
  stateMod.state.appSettings.retail_max_accounts_per_ip = 0; // лимит IP не мешает
});

afterAll(() => {
  setRetail(false);
  stateMod.state.appSettings.retail_max_accounts_per_ip = 2;
  cleanup();
});

describe('DEEP-25: конкурентная регистрация одного email', () => {
  it('барьер перед завершением двух hash: один durable клиент, второй 409', async () => {
    const email = 'race@' + DOM;
    const entered = deferred();
    const gate = deferred();
    let calls = 0;
    // Оба запроса проходят in-memory проверку email и уходят в bcrypt.hash —
    // барьер удерживает их до готовности обоих (гонка без sleep).
    const hashSpy = vi.spyOn(bcrypt, 'hash').mockImplementation((pwd) => {
      calls++;
      if (calls === 2) entered.resolve();
      return gate.p.then(() => 'vh_' + pwd);
    });
    let r1, r2;
    try {
      // supertest Test ленив: запрос уходит только по .then()/await — иначе
      // оба «конкурентных» запроса даже не стартуют и барьер висит вечно.
      r1 = request(app).post('/api/register').send({ email, password: 'password1', consent: true }).then(x => x);
      r2 = request(app).post('/api/register').send({ email: 'Race@' + DOM, password: 'password2', consent: true }).then(x => x);
      await entered.p;
      gate.resolve();
      [r1, r2] = await Promise.all([r1, r2]);
    } finally {
      hashSpy.mockRestore();
    }
    expect([r1.status, r2.status].sort((a, b) => a - b)).toEqual([200, 409]);

    // Нормализованный email уникален на уровне БД: ровно одна строка,
    // и память не содержит неперсистентного клиента.
    const rows = db.prepare('SELECT id, login, email FROM clients WHERE lower(email) = ?').all(email);
    expect(rows.length).toBe(1);
    const mem = stateMod.state.clients.filter(c => (c.email || '').toLowerCase() === email);
    expect(mem.length).toBe(1);
    const winner = r1.status === 200 ? r1 : r2;
    expect(rows[0].login).toBe(winner.body.login);
    expect(mem[0].login).toBe(winner.body.login);

    // Приёмка: последующая регистрация другого email и общее сохранение
    // действующего клиента успешны (следующие saveClients не упираются в
    // конфликт «призрака»).
    const r3 = await request(app).post('/api/register')
      .send({ email: 'after@' + DOM, password: 'password3', consent: true });
    expect(r3.status).toBe(200);
    expect(saveClients(stateMod.state.clients)).toBe(true);
    expect(db.prepare('SELECT COUNT(*) c FROM clients WHERE lower(email) = ?').get('after@' + DOM).c).toBe(1);
  });

  it('повторная регистрация того же email (не гонка) — 409 быстрым путём', async () => {
    const res = await request(app).post('/api/register')
      .send({ email: 'RACE@' + DOM, password: 'password9', consent: true });
    expect(res.status).toBe(409);
    expect(db.prepare('SELECT COUNT(*) c FROM clients WHERE lower(email) = ?').get('race@' + DOM).c).toBe(1);
  });
});

describe('DEEP-27: reset_password — токен сгорает только вместе с durable-сменой', () => {
  it('сбой bcrypt.hash: 500, токен НЕ погашен, пароль прежний; retry успешен', async () => {
    const login = await registerClient('hashfail@' + DOM, 'old-pass-1');
    const token = authTokensDb.issue(login, 'reset_password');
    const before = clientRow(login);

    const hashSpy = vi.spyOn(bcrypt, 'hash').mockRejectedValueOnce(new Error('bcrypt OOM'));
    const res = await request(app).post('/api/reset_password').send({ token, password: 'new-pass-1' });
    hashSpy.mockRestore();
    expect(res.status).toBe(500);

    // Токен жив (старый код погасил бы его ДО hash → повтор давал 400),
    // БД и память не тронуты.
    expect(authTokensDb.peek(token, 'reset_password')).toBeTruthy();
    expect(clientRow(login).password_hash).toBe(before.password_hash);
    expect(clientRow(login).auth_version).toBe(before.auth_version);
    expect(clientMem(login).passwordHash).toBe(before.password_hash);

    const fast = stubHashFast();
    const retry = await request(app).post('/api/reset_password').send({ token, password: 'new-pass-1' });
    fast.mockRestore();
    expect(retry.status).toBe(200);
    expect(clientRow(login).password_hash).toBe('vh_new-pass-1');
    expect(clientRow(login).auth_version).toBe(before.auth_version + 1);
    expect(clientMem(login).passwordHash).toBe('vh_new-pass-1');
    expect(authTokensDb.peek(token, 'reset_password')).toBeNull(); // теперь погашен
  });

  it('сбой UPDATE: транзакция откатывает consume — токен и пароль прежние', async () => {
    const login = await registerClient('updfail@' + DOM, 'old-pass-1');
    const token = authTokensDb.issue(login, 'reset_password');
    const before = clientRow(login);

    const fast = stubHashFast();
    const updSpy = vi.spyOn(clientsDb, 'updatePasswordHash')
      .mockImplementationOnce(() => { throw new Error('disk I/O'); });
    const res = await request(app).post('/api/reset_password').send({ token, password: 'new-pass-1' });
    updSpy.mockRestore();
    expect(res.status).toBe(500);
    expect(authTokensDb.peek(token, 'reset_password')).toBeTruthy();
    expect(clientRow(login).password_hash).toBe(before.password_hash);
    expect(clientRow(login).auth_version).toBe(before.auth_version);
    expect(clientMem(login).passwordHash).toBe(before.password_hash);

    const retry = await request(app).post('/api/reset_password').send({ token, password: 'new-pass-1' });
    fast.mockRestore();
    expect(retry.status).toBe(200);
    expect(clientRow(login).password_hash).toBe('vh_new-pass-1');
  });

  it('одновременный reset одним токеном: один 200, второй 400; пароль — победителя', async () => {
    const login = await registerClient('twice@' + DOM, 'old-pass-1');
    const token = authTokensDb.issue(login, 'reset_password');

    const entered = deferred();
    const gate = deferred();
    let calls = 0;
    const hashSpy = vi.spyOn(bcrypt, 'hash').mockImplementation((pwd) => {
      calls++;
      if (calls === 2) entered.resolve();
      return gate.p.then(() => 'vh_' + pwd);
    });
    let r1, r2;
    try {
      // См. выше: .then(x => x) стартует supertest-запрос сразу (Test ленив).
      r1 = request(app).post('/api/reset_password').send({ token, password: 'new-pass-a' }).then(x => x);
      r2 = request(app).post('/api/reset_password').send({ token, password: 'new-pass-b' }).then(x => x);
      await entered.p;   // оба прошли peek и ушли в hash
      gate.resolve();
      [r1, r2] = await Promise.all([r1, r2]);
    } finally {
      hashSpy.mockRestore();
    }
    expect([r1.status, r2.status].sort((a, b) => a - b)).toEqual([200, 400]);
    const winnerPwd = r1.status === 200 ? 'new-pass-a' : 'new-pass-b';
    expect(clientRow(login).password_hash).toBe('vh_' + winnerPwd);
    expect(clientMem(login).passwordHash).toBe('vh_' + winnerPwd);
    // Третья попытка по тому же токену — тоже 400 (однократность).
    const third = await request(app).post('/api/reset_password').send({ token, password: 'new-pass-c' });
    expect(third.status).toBe(400);
  });

  it('login, начавший compare до reset, НЕ получает сессию по старому паролю (auth version)', async () => {
    const login = await registerClient('loginrace@' + DOM, 'old-pass-1');
    const cmpEntered = deferred();
    const cmpGate = deferred();
    // compare входа удерживаем барьером: reset проходит, пока вход «считает».
    const cmpSpy = vi.spyOn(bcrypt, 'compare').mockImplementation((pwd, hash) => {
      cmpEntered.resolve();
      return cmpGate.p.then(() => hash === 'vh_' + pwd);
    });
    const fast = stubHashFast();
    try {
      // .then(x => x) — supertest Test ленив, запрос стартует немедленно.
      const loginReq = request(app).post('/api/login').send({ login, password: 'old-pass-1' }).then(x => x);
      await cmpEntered.p;   // compare со СТАРЫМ хэшем уже идёт
      const token = authTokensDb.issue(login, 'reset_password');
      const reset = await request(app).post('/api/reset_password').send({ token, password: 'new-pass-1' });
      expect(reset.status).toBe(200);
      cmpGate.resolve();    // compare завершается успехом (старый пароль верный...)
      const loginRes = await loginReq;
      expect(loginRes.status).toBe(401); // ...но auth_version сменился — сессии нет
      expect(db.prepare('SELECT COUNT(*) c FROM sessions WHERE login = ?').get(login).c).toBe(0);
    } finally {
      cmpSpy.mockRestore();
      fast.mockRestore();
    }
    // Контроль: новый пароль входит штатно.
    const cmp2 = vi.spyOn(bcrypt, 'compare').mockImplementation((pwd, hash) => Promise.resolve(hash === 'vh_' + pwd));
    const ok = await request(app).post('/api/login').send({ login, password: 'new-pass-1' });
    cmp2.mockRestore();
    expect(ok.status).toBe(200);
    expect(ok.body.token).toBeTruthy();
  });
});

describe('DEEP-27: verify_email — consume в одной транзакции с изменением', () => {
  it('однократный consume: гонка двух запросов → один 200; verified durable и в памяти', async () => {
    const login = await registerClient('verify@' + DOM, 'password1');
    const token = authTokensDb.issue(login, 'verify_email');
    const [r1, r2] = await Promise.all([
      request(app).post('/api/verify_email').send({ token }),
      request(app).post('/api/verify_email').send({ token }),
    ]);
    expect([r1.status, r2.status].sort((a, b) => a - b)).toEqual([200, 400]);
    expect(clientRow(login).email_verified).toBe(1);
    expect(clientMem(login).emailVerified).toBe(true);
  });

  it('сбой UPDATE: 500, токен не погашен, verified не выставлен; retry успешен', async () => {
    const login = await registerClient('verifyfail@' + DOM, 'password1');
    const token = authTokensDb.issue(login, 'verify_email');
    const updSpy = vi.spyOn(clientsDb, 'setEmailVerified')
      .mockImplementationOnce(() => { throw new Error('disk I/O'); });
    const res = await request(app).post('/api/verify_email').send({ token });
    updSpy.mockRestore();
    expect(res.status).toBe(500);
    expect(authTokensDb.peek(token, 'verify_email')).toBeTruthy();
    expect(clientRow(login).email_verified).toBe(0);
    expect(clientMem(login).emailVerified).toBe(false);

    const retry = await request(app).post('/api/verify_email').send({ token });
    expect(retry.status).toBe(200);
    expect(clientRow(login).email_verified).toBe(1);
    expect(clientMem(login).emailVerified).toBe(true);
  });
});
