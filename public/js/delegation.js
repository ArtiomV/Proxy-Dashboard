'use strict';
//
// public/js/delegation.js — глобальная делегация обработчиков событий вместо
// инлайн-атрибутов (Stage 5 ph.2 / Stage 11: позволяет убрать
// script-src-attr 'unsafe-inline' из CSP).
//
// Контракт: вместо onclick="fn('a', this)" пишем data-on-click="fn('a', this)".
// Диспатчер парсит текст СТРОГОЙ грамматой (без eval / new Function — CSP
// unsafe-eval не разрешён) и вызывает глобальную функцию по имени с
// вычисленными аргументами. Что умеет грамматика:
//
//   statements  := stmt (";" stmt)*
//   stmt        := "return" ("false"|"true")
//                | "if" "(" cond ")" stmt                       (cond: event.target===this | event.target.tagName(==|!=)'TAG')
//                | lhs "=" value                                (lhs: ident | window.ident | this.style.ident | ident[key].ident | document.getElementById('lit').value)
//                | call
//   call        := fn(args)            — fn: глобальная функция (window[fn])
//                | this.METHOD(args)   — METHOD ∈ {remove, click, focus, blur}
//                | this.closest(sel).remove()
//                | event.(stopPropagation|preventDefault)()
//                | document.getElementById('lit').(remove|click|focus|scrollIntoView(args))
//                | document.querySelector('lit').click()
//                | window.open(args)
//                | localStorage.setItem(args)
//   args        := string | number | true | false | null | undefined
//                | this | this.checked | this.value | this.selectedIndex
//                | this.dataset.ident | this.textContent | this.innerText
//                | event | event.target | ident (глобальная переменная)
//                | window.ident
//                | document.getElementById('lit').(value|textContent)
//                | parseInt(arg) | parseFloat(arg) | encodeURIComponent(arg)
//                | arg "+" arg (конкатенация)
//                | "{" ident: value ("," ident: value)* "}"   (объект, напр. scrollIntoView)
//
// Не подходит под грамматику — выносить в именованные хелперы (список в
// tests/frontend-delegation.test.js держит покрытие на 100%).

(function () {
  // ── Разбор строк на операторы по ';' вне строк ───────────────────────────
  function splitStatements(code) {
    const out = [];
    let cur = '', quote = null, esc = false;
    for (const ch of code) {
      if (esc) { cur += ch; esc = false; continue; }
      if (ch === '\\') { cur += ch; esc = true; continue; }
      if (quote) { if (ch === quote) quote = null; cur += ch; continue; }
      if (ch === "'" || ch === '"') { quote = ch; cur += ch; continue; }
      if (ch === ';') { out.push(cur); cur = ''; continue; }
      cur += ch;
    }
    if (cur.trim()) out.push(cur);
    return out;
  }

  function splitTop(s, sep) {
    const out = [];
    let cur = '', quote = null, esc = false, depth = 0;
    for (const ch of s) {
      if (esc) { cur += ch; esc = false; continue; }
      if (ch === '\\') { cur += ch; esc = true; continue; }
      if (quote) { if (ch === quote) quote = null; cur += ch; continue; }
      if (ch === "'" || ch === '"') { quote = ch; cur += ch; continue; }
      if (ch === '(' || ch === '[' || ch === '{') depth++;
      if (ch === ')' || ch === ']' || ch === '}') depth--;
      if (ch === sep && depth === 0) { out.push(cur); cur = ''; continue; }
      cur += ch;
    }
    out.push(cur);
    return out;
  }

  // splitTop по двум символам '||' (топ-уровень, вне строк и скобок).
  function splitTopOr(s) {
    const out = [];
    let cur = '', quote = null, esc = false, depth = 0;
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (esc) { cur += ch; esc = false; continue; }
      if (ch === '\\') { cur += ch; esc = true; continue; }
      if (quote) { if (ch === quote) quote = null; cur += ch; continue; }
      if (ch === "'" || ch === '"') { quote = ch; cur += ch; continue; }
      if (ch === '(' || ch === '[' || ch === '{') depth++;
      if (ch === ')' || ch === ']' || ch === '}') depth--;
      if (ch === '|' && s[i + 1] === '|' && depth === 0) { out.push(cur); cur = ''; i++; continue; }
      cur += ch;
    }
    out.push(cur);
    return out.filter(p => p.trim() !== '');
  }

  // Одиночное '=' на верхнем уровне вне строк — присваивание (не ==/===/!=/>=/<=/=>).
  function isAssign(stmt) {    let quote = null, esc = false, depth = 0;
    for (let i = 0; i < stmt.length; i++) {
      const ch = stmt[i];
      if (esc) { esc = false; continue; }
      if (ch === '\\') { esc = true; continue; }
      if (quote) { if (ch === quote) quote = null; continue; }
      if (ch === "'" || ch === '"') { quote = ch; continue; }
      if (ch === '(' || ch === '[' || ch === '{') depth++;
      else if (ch === ')' || ch === ']' || ch === '}') depth--;
      else if (ch === '=' && depth === 0) {
        const prev = stmt[i - 1], next = stmt[i + 1];
        if (next === '=' || next === '>') continue;
        if (prev === '=' || prev === '!' || prev === '<' || prev === '>') continue;
        return true;
      }
    }
    return false;
  }

  function parseString(s) {
    const q = s[0];
    if ((q !== "'" && q !== '"') || s[s.length - 1] !== q) return undefined;
    const body = s.slice(1, -1);
    return body.replace(/\\(.)/g, (m, c) => {
      if (c === 'n') return '\n';
      if (c === 't') return '\t';
      if (c === 'r') return '\r';
      return c;                       // \\', \", \\\\, \/
    });
  }

  // ── Значения ─────────────────────────────────────────────────────────────
  function evalValue(expr, el, event) {
    expr = expr.trim();
    if (!expr) return undefined;
    // fallback: a || b (топ-уровень)
    const orParts = splitTopOr(expr);
    if (orParts.length > 1) {
      for (const p of orParts) {
        const v = evalValue(p, el, event);
        if (v) return v;
      }
      return evalValue(orParts[orParts.length - 1], el, event);
    }
    // литералы
    if (expr[0] === "'" || expr[0] === '"') return parseString(expr);
    if (/^-?\d+(\.\d+)?$/.test(expr)) return parseFloat(expr);
    if (expr === 'true') return true;
    if (expr === 'false') return false;
    if (expr === 'null') return null;
    if (expr === 'undefined') return undefined;
    // this / event
    if (expr === 'this') return el;
    if (expr === 'this.checked') return el.checked;
    if (expr === 'this.value') return el.value;
    if (expr === 'this.selectedIndex') return el.selectedIndex;
    if (expr === 'this.files') return el.files;
    if (expr === 'this.textContent') return el.textContent;
    if (expr === 'this.innerText') return el.innerText;
    let m = expr.match(/^this\.dataset\.([A-Za-z_$][\w$]*)$/);
    if (m) return el.dataset ? el.dataset[m[1]] : undefined;
    if (expr === 'event') return event;
    if (expr === 'event.target') return event.target;
    // document.getElementById('lit').(value|textContent)
    m = expr.match(/^document\.getElementById\((['"])((?:[^'\\]|\\.)*)\1\)\.(value|textContent)$/);
    if (m) { const node = document.getElementById(parseString("'" + m[1] + "'")); return node ? node[m[3]] : undefined; }
    // parseInt/parseFloat/encodeURIComponent обёртки
    m = expr.match(/^(parseInt|parseFloat|encodeURIComponent)\((.*)\)$/);
    if (m) {
      const v = evalValue(m[2], el, event);
      if (m[1] === 'parseInt') return parseInt(v);
      if (m[1] === 'parseFloat') return parseFloat(v);
      return encodeURIComponent(v);
    }
    // window.ident / ident (глобальная переменная)
    m = expr.match(/^(?:window\.)?([A-Za-z_$][\w$]*)$/);
    if (m) return window[m[1]];
    // конкатенация: arg + arg (топ-уровень '+')
    const parts = splitTop(expr, '+');
    if (parts.length > 1) {
      return parts.map(p => String(evalValue(p, el, event) ?? '')).join('');
    }
    // объект {a: v, b: v}
    if (expr[0] === '{' && expr[expr.length - 1] === '}') {
      const inner = expr.slice(1, -1);
      const obj = {};
      for (const pair of splitTop(inner, ',')) {
        const kv = splitTop(pair, ':');
        if (kv.length < 2) throw new Error('delegation: bad object pair ' + pair);
        obj[kv[0].trim()] = evalValue(kv.slice(1).join(':'), el, event);
      }
      return obj;
    }
    throw new Error('delegation: unsupported arg: ' + expr);
  }

  function evalArgs(argStr, el, event) {
    if (!argStr || !argStr.trim()) return [];
    return splitTop(argStr, ',').map(a => evalValue(a, el, event));
  }

  // ── Условия if ───────────────────────────────────────────────────────────
  function evalCond(cond, el, event) {
    cond = cond.trim();
    if (cond === 'event.target===this') return event.target === el;
    if (cond === 'event.target!==this') return event.target !== el;
    let m = cond.match(/^event\.target\.tagName\s*(===|!==)\s*(['"])((?:[^'\\]|\\.)*)\2$/);
    if (m) {
      const tag = (event.target && event.target.tagName) || '';
      const want = m[3];
      return m[1] === '===' ? tag === want : tag !== want;
    }
    throw new Error('delegation: unsupported cond: ' + cond);
  }

  // ── Вызовы ───────────────────────────────────────────────────────────────
  function execCall(expr, el, event) {
    expr = expr.trim();
    let m;
    // this.closest('sel').remove()
    if ((m = expr.match(/^this\.closest\((['"])((?:[^'\\]|\\.)*)\1\)\.remove\(\)$/))) {
      const sel = parseString("'" + m[1] + "'");
      const anc = el.closest(sel);
      if (anc) anc.remove();
      return;
    }
    // this.METHOD(args)
    if ((m = expr.match(/^this\.(remove|click|focus|blur)\((.*)\)$/))) {
      const args = evalArgs(m[2], el, event);
      el[m[1]](...args);
      return;
    }
    // event.stopPropagation() / event.preventDefault()
    if (expr === 'event.stopPropagation()') { event.stopPropagation(); return; }
    if (expr === 'event.preventDefault()') { event.preventDefault(); return; }
    // document.getElementById('lit').METHOD(args)
    if ((m = expr.match(/^document\.getElementById\((['"])((?:[^'\\]|\\.)*)\1\)\.(remove|click|focus|scrollIntoView)\((.*)\)$/))) {
      const node = document.getElementById(parseString("'" + m[1] + "'"));
      if (node) node[m[3]](...evalArgs(m[4], el, event));
      return;
    }
    // document.querySelector('lit').click() / .classList.toggle('lit')
    if ((m = expr.match(/^document\.querySelector\((['"])((?:[^'\\]|\\.)*)\1\)\.click\(\)$/))) {
      const node = document.querySelector(parseString("'" + m[1] + "'"));
      if (node) node.click();
      return;
    }
    if ((m = expr.match(/^document\.querySelector\((['"])((?:[^'\\]|\\.)*)\1\)\.classList\.toggle\((['"])((?:[^'\\]|\\.)*)\3\)$/))) {
      const node = document.querySelector(parseString("'" + m[1] + "'"));
      if (node) node.classList.toggle(parseString("'" + m[2] + "'"));
      return;
    }
    // window.open(args) / localStorage.setItem(args)
    if ((m = expr.match(/^window\.open\((.*)\)$/))) { window.open(...evalArgs(m[1], el, event)); return; }
    if ((m = expr.match(/^localStorage\.setItem\((.*)\)$/))) { localStorage.setItem(...evalArgs(m[1], el, event)); return; }
    // fn(args) — глобальная функция
    if ((m = expr.match(/^([A-Za-z_$][\w$]*)\s*\((.*)\)$/))) {
      const fn = window[m[1]];
      if (typeof fn !== 'function') throw new Error('delegation: no global fn ' + m[1]);
      return fn.apply(el, evalArgs(m[2], el, event));
    }
    // голая ссылка fn — вызов с (event)
    if ((m = expr.match(/^([A-Za-z_$][\w$]*)$/))) {
      const fn = window[m[1]];
      if (typeof fn !== 'function') throw new Error('delegation: no global fn ' + m[1]);
      return fn.call(el, event);
    }
    throw new Error('delegation: unsupported call: ' + expr);
  }

  // ── Присваивания ─────────────────────────────────────────────────────────
  function execAssign(expr, el, event) {
    const kv = splitTop(expr, '=');
    if (kv.length !== 2) throw new Error('delegation: bad assign: ' + expr);
    const lhs = kv[0].trim(), rhs = evalValue(kv[1], el, event);
    let m;
    if ((m = lhs.match(/^this\.style\.([A-Za-z]+)$/))) { el.style[m[1]] = rhs; return; }
    if ((m = lhs.match(/^document\.getElementById\((['"])((?:[^'\\]|\\.)*)\1\)\.(value|textContent|innerHTML)$/))) {
      const node = document.getElementById(parseString("'" + m[1] + "'"));
      if (node) node[m[3]] = rhs;
      return;
    }
    if ((m = lhs.match(/^([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\[(.+)\]\.([A-Za-z_$][\w$]*)$/))) {
      const obj = m[1].split('.').reduce((o, k) => (o ? o[k] : undefined), window);
      if (!obj) throw new Error('delegation: no global obj ' + m[1]);
      obj[evalValue(m[2], el, event)][m[3]] = rhs;
      return;
    }
    if ((m = lhs.match(/^(?:window\.)?([A-Za-z_$][\w$]*)$/))) { window[m[1]] = rhs; return; }
    throw new Error('delegation: unsupported lhs: ' + lhs);
  }

  // ── Оператор ─────────────────────────────────────────────────────────────
  function execStatement(stmt, el, event) {
    stmt = stmt.trim();
    if (!stmt) return undefined;
    if (stmt === 'return false') return false;
    if (stmt === 'return true') return true;
    if (stmt.startsWith('return ')) return evalValue(stmt.slice(7), el, event);
    let m = stmt.match(/^if\s*\((.+)\)\s*(.+)$/s);
    if (m) { if (evalCond(m[1], el, event)) return execStatement(m[2], el, event); return undefined; }
    if (isAssign(stmt)) return execAssign(stmt, el, event);
    return execCall(stmt, el, event);
  }

  function dispatch(event, type) {
    let node = event.target;
    const attr = 'data-on-' + type;
    while (node && node.nodeType === 1) {
      if (node.hasAttribute && node.hasAttribute(attr)) {
        const code = node.getAttribute(attr);
        try {
          let ret;
          for (const stmt of splitStatements(code)) ret = execStatement(stmt, node, event);
          if (ret === false) { event.preventDefault(); event.stopPropagation(); }
        } catch (e) {
          console.error('[delegation]', e.message, '|', attr, '=', code);
        }
        return;
      }
      node = node.parentElement;
    }
  }

  const TYPES = ['click', 'change', 'input', 'submit', 'keydown', 'keyup', 'focus', 'blur', 'mouseover', 'mouseout', 'mouseenter', 'mouseleave'];
  for (const t of TYPES) {
    document.addEventListener(t, (ev) => dispatch(ev, t), true);
  }

  // Экспорт для node-тестов (паттерн public/js/utils.js)
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { splitStatements, splitTop, parseString, evalValue, execStatement, execCall, execAssign, isAssign, dispatch };
  }
})();
