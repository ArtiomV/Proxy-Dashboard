'use strict';
//
// src/jobs/speedtest-gate.js — 2026-09-27: глобальный ограничитель
// параллелизма спидтестов НА ОДИН БОКС (server name).
//
// Боксы ProxySmart (ARM-хабы) захлёбываются, когда на одном боксе идёт
// несколько спидтестов параллельно: панель отдаёт HTML вместо JSON
// (инциденты speedtest_box_outage). Спидтесты вызываются из трёх мест
// независимо — почасовой монитор (speed-monitor), пробы исчерпания пакета
// (sim-exhaustion) и ручной замер из UI (routes/proxies-speedtest). Все три
// проходят через этот гейт: на бокс одновременно не больше limit (дефолт 2)
// спидтестов. Слот занят дольше waitMs (дефолт 60с) → GATE_BUSY: вызывающий
// скипает замер и переносит его (для монитора — раунд перезамеров, для
// sim-exhaustion — следующая проба по кулдауну), это НЕ ошибка бокса.
//
// Состояние — module-level: все потребители живут в одном процессе.

const DEFAULT_LIMIT = 2;        // максимум параллельных спидтестов на бокс
const DEFAULT_WAIT_MS = 60000;  // сколько ждём свободный слот, дальше — GATE_BUSY

const gates = new Map();   // serverName → { running, queue: [{ resolve, timer }] }

function _key(serverName) { return String(serverName || ''); }

function _gate(serverName) {
  const key = _key(serverName);
  let g = gates.get(key);
  if (!g) { g = { running: 0, queue: [] }; gates.set(key, g); }
  return g;
}

function _makeRelease(serverName) {
  const key = _key(serverName);
  let released = false;
  return function release() {
    if (released) return;
    released = true;
    const g = gates.get(key);
    if (!g) return;
    const next = g.queue.shift();
    if (next) {
      // Слот передаётся первому ждущему (FIFO) — счётчик running не меняется.
      clearTimeout(next.timer);
      next.resolve(_makeRelease(key));
      return;
    }
    g.running--;
    if (g.running <= 0) gates.delete(key);
  };
}

// Ждёт свободный слот на боксе до waitMs. Возвращает функцию release()
// (идемпотентную) либо null — гейт был занят дольше waitMs, вызывающий
// скипает/переносит замер. limit/waitMs — на вызов (лимит может читаться
// из настройки на каждый прогон).
function acquire(serverName, { limit = DEFAULT_LIMIT, waitMs = DEFAULT_WAIT_MS } = {}) {
  const g = _gate(serverName);
  if (g.running < limit) {
    g.running++;
    return Promise.resolve(_makeRelease(serverName));
  }
  if (!(waitMs > 0)) return Promise.resolve(null);
  return new Promise(resolve => {
    const waiter = { resolve, timer: null };
    waiter.timer = setTimeout(() => {
      const cur = gates.get(_key(serverName));
      const i = cur ? cur.queue.indexOf(waiter) : -1;
      if (i >= 0) cur.queue.splice(i, 1);
      resolve(null);
    }, waitMs);
    if (typeof waiter.timer.unref === 'function') waiter.timer.unref();
    g.queue.push(waiter);
  });
}

class GateBusyError extends Error {
  constructor(serverName) {
    super(`speedtest gate busy: ${_key(serverName)}`);
    this.code = 'GATE_BUSY';
  }
}

// Обёртка: слот занят дольше waitMs → бросает GateBusyError (code GATE_BUSY).
// Слот освобождается и при ошибке fn (finally) — гейт не «залипает».
async function runWithGate(serverName, fn, opts = {}) {
  const release = await acquire(serverName, opts);
  if (!release) throw new GateBusyError(serverName);
  try {
    return await fn();
  } finally {
    release();
  }
}

// Параметры из настроек (читаются вызывающим на каждый прогон):
//   speedtest_gate_max_per_server (дефолт 2, 1..5) — слотов на бокс;
//   speedtest_gate_wait_sec (дефолт 60, 1..600) — сколько ждём слот.
function optsFromSettings(getSetting) {
  let limit = DEFAULT_LIMIT, waitMs = DEFAULT_WAIT_MS;
  if (typeof getSetting === 'function') {
    const l = parseInt(getSetting('speedtest_gate_max_per_server', DEFAULT_LIMIT));
    if (Number.isInteger(l) && l >= 1 && l <= 5) limit = l;
    const w = parseInt(getSetting('speedtest_gate_wait_sec', DEFAULT_WAIT_MS / 1000));
    if (Number.isInteger(w) && w >= 1 && w <= 600) waitMs = w * 1000;
  }
  return { limit, waitMs };
}

// Сброс состояния — для тестов (ждущие разрешаются в null, таймеры сняты).
function _reset() {
  for (const g of gates.values()) {
    for (const w of g.queue.splice(0)) { clearTimeout(w.timer); w.resolve(null); }
  }
  gates.clear();
}

module.exports = { acquire, runWithGate, GateBusyError, optsFromSettings, DEFAULT_LIMIT, DEFAULT_WAIT_MS, _reset };
