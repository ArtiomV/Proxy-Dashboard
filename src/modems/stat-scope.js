'use strict';
//
// src/modems/stat-scope.js — какие модемы участвуют в сводной статистике.
//
// 2026-10-13: модем без клиента «мёртвый» — сеть часто не поднята (свободные
// SIM S3 MD_81–88), его пинги, HTTP-чеки и ротации сплошь неуспешные и
// портят проценты по серверу/оператору/флоту (S3: 11,3% неуспешных ротаций,
// из них 2/3 — свободные модемы). В агрегаты берём только модемы, на которых
// висит хотя бы один ростерный порт с непустым portName (не random*) — тот же
// критерий, что у офлайн-алертов и дайджеста застрявших симок.
//
// Ростер — state.knownModems (в нём только порты с клиентами). Пока он пуст
// (первые секунды после старта) фильтр не применяется: лучше показать всё,
// чем обнулить статистику.

const stateMod = require('../state');

function _roster(knownModems) {
  return knownModems || stateMod.state.knownModems || {};
}

// Ключи 'server|nick' (и 'server|imei' — ротации старых модемов писались
// под IMEI) модемов с клиентом.
function boundModemKeys(knownModems) {
  const out = new Set();
  for (const [srv, ports] of Object.entries(_roster(knownModems))) {
    for (const info of Object.values(ports || {})) {
      if (!info) continue;
      const pn = String(info.portName || '').trim();
      if (!pn || /^random/i.test(pn)) continue;
      if (info.nick) out.add(srv + '|' + info.nick);
      if (info.imei) out.add(srv + '|' + info.imei);
    }
  }
  return out;
}

function modemHasClient(serverName, nick, knownModems) {
  const ports = _roster(knownModems)[serverName];
  if (!ports) return false;
  for (const info of Object.values(ports)) {
    if (!info) continue;
    const pn = String(info.portName || '').trim();
    if (!pn || /^random/i.test(pn)) continue;
    if (info.nick === nick || info.imei === nick) return true;
  }
  return false;
}

// SQL-фрагмент «AND <модем с клиентом>» для запросов по rotation_log /
// modem_ping / modem_httpcheck. serverCol/nickCol — выражения колонок
// (с алиасом таблицы, если нужен). Один параметр — JSON-массив пар
// [server, nick]. Сравнение row-value — SQLite ведёт его по индексам
// (server, nick, ts/started_at), а не перебором. Пустой ростер → пустой
// фрагмент (fail-open).
function boundClause(serverCol, nickCol, knownModems) {
  const keys = boundModemKeys(knownModems);
  if (!keys.size) return { clause: '', params: [] };
  const pairs = [...keys].map(k => { const i = k.indexOf('|'); return [k.slice(0, i), k.slice(i + 1)]; });
  return {
    clause: ` AND (${serverCol}, ${nickCol}) IN (SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]') FROM json_each(?))`,
    params: [JSON.stringify(pairs)],
  };
}

// Единые критерии ротации для сводок (a — префикс алиаса, напр. 'r.').
// Учитывается ротация, у которой известен хоть один IP: оба пустых — модем
// был без сети всё время (это офлайн, он считается отдельно), а не «IP не
// сменился». Неуспешная — новый IP не получен или совпал со старым.
function rotCountedSql(a = '') {
  return `(COALESCE(${a}old_ip, '') <> '' OR COALESCE(${a}new_ip, '') <> '')`;
}
function rotFailedSql(a = '') {
  return `(COALESCE(${a}new_ip, '') = '' OR ${a}new_ip = ${a}old_ip)`;
}

module.exports = { boundModemKeys, modemHasClient, boundClause, rotCountedSql, rotFailedSql };
