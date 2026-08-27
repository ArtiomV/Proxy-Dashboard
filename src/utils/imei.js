'use strict';
//
// src/utils/imei.js — нормализация IMEI с серверным префиксом.
//
// В кэшах дашборда IMEI хранится с префиксом "<serverName>_" (см. proxy-data.js:
// prefix = data.serverName + '_'). Раньше префикс срезали регэкспом /^S\d+_/,
// который знал только сервера вида S1..S4. Для сервера с любым другим именем
// (RO1-MF289 и т.п.) префикс НЕ срезался, и на бокс улетал IMEI вида
// "RO1-MF289_867389050591949" — ProxySmart молча отклонял формы add_port/edit
// (инцидент 27.08: «ProxySmart отклонил порт» при живом боксе).
//
// stripServerPrefix(imei, serverName):
//   - если известно имя сервера и строка начинается с "<serverName>_" — срезаем его;
//   - иначе (легаси-вызовы без имени) — старый регэксп /^S\d+_/.
//
function stripServerPrefix(imei, serverName) {
  let s = String(imei || '');
  if (serverName) {
    const p = String(serverName) + '_';
    if (s.startsWith(p)) return s.slice(p.length);
  }
  return s.replace(/^S\d+_/, '');
}

module.exports = { stripServerPrefix };
