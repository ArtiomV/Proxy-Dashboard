// Stage 5 ph.2 / Stage 11: инлайн-обработчики событий переведены на
// data-on-* + глобальная делегация (public/js/delegation.js), CSP
// script-src-attr 'none'. Этот тест — регрессионный замок:
//   1) юнит-семантика парсера (вызовы, аргументы, присваивания, if);
//   2) ПОКРЫТИЕ: каждый data-on-* в HTML/JS файлах парсится безопасной
//      грамматой (та же предобработка шаблонных интерполяций);
//   3) инвариант: в файлах НЕТ инлайн-атрибутов on*.

import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';

const require = createRequire(import.meta.url);

// Стабы окружения для загрузки delegation.js в node
global.window = {};
global.document = { addEventListener() {}, getElementById: () => null, querySelector: () => null, querySelectorAll: () => [] };
const D = require('../public/js/delegation.js');

const FILES = [
  'public/admin.html', 'public/index.html', 'public/js/admin.js',
  'public/js/admin/modems.js', 'public/js/admin/settings.js',
  'public/js/admin/finance.js', 'public/js/admin/analytics.js',
  'public/js/client.js',
];
const EL = { style: {}, dataset: {}, checked: true, closest: () => null, click() {}, focus() {}, blur() {}, remove() {} };
const EV = { target: { tagName: 'DIV' }, stopPropagation() {}, preventDefault() {} };

function preprocess(src) {
  return src
    .replace(/'\+(?:(?!\+').)*\+'/g, 'X')      // интерполяции '+...+' в шаблонах
    .replace(/"\+(?:(?!\+").)*\+"/g, 'X');
}
function parseOk(code) {
  try {
    for (const stmt of D.splitStatements(code)) {
      const st = stmt.trim();
      if (!st) continue;
      if (st === 'return false' || st === 'return true') continue;
      if (st.startsWith('return ')) { D.evalValue(st.slice(7), EL, EV); continue; }
      if (/^(['"]).*\1$/.test(st)) continue;    // плейсхолдер-строка
      const ifm = st.match(/^if\s*\((.+)\)\s*(.+)$/s);
      if (ifm) {
        try { D.execStatement(ifm[2], EL, EV); }
        catch (e) { if (!/no global fn|no global obj/.test(e.message)) throw e; }
        continue;
      }
      try {
        if (D.isAssign(st)) D.execAssign(st, EL, EV);
        else D.execCall(st, EL, EV);
      } catch (e) {
        if (!/no global fn|no global obj/.test(e.message)) throw e;
      }
    }
    return true;
  } catch (e) {
    return e.message;
  }
}

describe('delegation.js — парсер (юнит)', () => {
  beforeEach(() => {
    global.window = { fn: (a, b) => [a, b], obj: { arr: [{ v: 0 }] }, _simState: { urls: [{}] } };
  });
  it('вызовы с литералами и this/event', () => {
    expect(D.execCall("fn('a', 1, this)", EL, EV)).toEqual(['a', 1]);
    expect(() => D.execCall("unknownFn(1)", EL, EV)).toThrow(/no global fn/);
    expect(D.execCall("this.closest('div').remove()", EL, EV)).toBeUndefined();
    expect(D.execCall("event.stopPropagation()", EL, EV)).toBeUndefined();
  });
  it('аргументы: литералы/this/dataset/getElementById/конкат', () => {
    expect(D.evalValue("'str'", EL, EV)).toBe('str');
    expect(D.evalValue('this.checked', EL, EV)).toBe(true);
    expect(D.evalValue('this.dataset.c', EL, EV)).toBeUndefined();
    expect(D.evalValue("API+'/x/'+id", EL, EV)).toBe('/x/');
  });
  it('присваивания: window/this.style/obj[key].prop', () => {
    D.execAssign("proto='http'", EL, EV);
    expect(global.window.proto).toBe('http');
    D.execAssign("this.style.background='var(--bg-2)'", EL, EV);
    expect(EL.style.background).toBe('var(--bg-2)');
    D.execAssign("obj.arr[0].v='x'", EL, EV);
    expect(global.window.obj.arr[0].v).toBe('x');
    D.execAssign("_simState.urls[0].method=this.value", EL, EV);
    expect(global.window._simState.urls[0].method).toBeUndefined();
  });
  it('if-гварды по event.target', () => {
    expect(D.execStatement('if(event.target===this)return false', EL, { target: EL })).toBe(false);
    expect(D.execStatement("if(event.target.tagName!=='INPUT')fn(1)", EL, EV)).toEqual([1, undefined]);
    expect(D.execStatement("if(event.target.tagName==='DIV')return false", EL, EV)).toBe(false);
  });
});

describe('delegation — покрытие data-on-* (Stage 11 lock)', () => {
  beforeEach(() => {
    global.window = { _simState: { urls: { X: {}, 0: {} } }, API: '', authToken: '', X: 0, open: () => {} };
  });
  const ATTR = /data-on-(click|change|input|submit|keydown|keyup|focus|blur|mouseover|mouseout|mouseenter|mouseleave)="((?:[^"\\]|\\.)*)"/g;
  it('все data-on-* парсятся грамматой', () => {
    let total = 0;
    const fails = [];
    for (const f of FILES) {
      const src = preprocess(fs.readFileSync(path.join(__dirname, '..', f), 'utf8'));
      let m;
      while ((m = ATTR.exec(src))) {
        total++;
        const code = m[2].replace(/\\'/g, "'");
        const r = parseOk(code);
        if (r !== true) fails.push(`${f} [${m[1]}] ${code.slice(0, 100)} → ${r}`);
      }
    }
    expect(fails).toEqual([]);
    expect(total).toBeGreaterThan(400);
  });
  it('инлайн-атрибутов on* в разметке не осталось', () => {
    const INLINE = /\son(click|change|input|submit|mouseenter|mouseleave)="/;
    for (const f of FILES) {
      const src = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
      expect(INLINE.test(src), f).toBe(false);
    }
  });
});

describe('delegation: селектор в closest/getElementById/querySelector передаётся контентом, а не кавычкой', () => {
  // Регрессия 2026-08-02: parseString("'"+m[1]+"'") отдавал символ кавычки
  // вместо текста селектора — крестики попапов (closest('...').remove()) и
  // все getElementById('...').click() ветки молча умирали в try/catch.
  it("this.closest('div[style*=fixed]').remove() — селектор доходит до closest", () => {
    const seen = [];
    const el = { closest: (sel) => { seen.push(sel); return { remove() {} }; } };
    D.execStatement("this.closest('div[style*=fixed]').remove()", el, {});
    expect(seen).toEqual(['div[style*=fixed]']);
  });
  it("document.getElementById('confirmOverlay').click() — id доходит", () => {
    const seen = [];
    const orig = global.document.getElementById;
    global.document.getElementById = (id) => { seen.push(id); return { click() {} }; };
    D.execStatement("document.getElementById('confirmOverlay').click()", EL, EV);
    global.document.getElementById = orig;
    expect(seen).toEqual(['confirmOverlay']);
  });
  it("document.querySelector('.modal-close').click() — селектор доходит", () => {
    const seen = [];
    const orig = global.document.querySelector;
    global.document.querySelector = (s) => { seen.push(s); return { click() {} }; };
    D.execStatement("document.querySelector('.modal-close').click()", EL, EV);
    global.document.querySelector = orig;
    expect(seen).toEqual(['.modal-close']);
  });
});
