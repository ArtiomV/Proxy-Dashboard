'use strict';

/**
 * D7 (2026-08): shape-валидация ответов ключевых эндпоинтов ProxySmart /apix/*.
 *
 * Контракт зафиксирован в docs/PROXYSMART-CONTRACT.md — это проверка того, что
 * бокс отвечает именно в том виде, который код парсит. Чистые функции:
 * на вход — распарсенный JSON ответа, на выход — массив нарушений (строки).
 * Пустой массив = ответ по контракту.
 *
 * Лёгкие проверки (не JSON-Schema): тип верхнего уровня + наличие полей,
 * которые реально читает код, в выборке первых N записей. Пустые коллекции
 * (0 модемов/портов) нарушением НЕ считаются — это легальное состояние бокса.
 */

const SAMPLE = 5;

function _sampleEntries(obj, mapFn) {
  // obj: plain object → первые SAMPLE значений
  const keys = Object.keys(obj);
  const out = [];
  for (let i = 0; i < Math.min(keys.length, SAMPLE); i++) out.push(mapFn(keys[i], obj[keys[i]]));
  return out;
}

// /apix/bandwidth_report_all → { portId: { port, portName, bandwidth_bytes_day_in, ... } }
// Код читает: b.port, b.portName, b.bandwidth_bytes_day_in/out (строки вида "21.1 GB",
// src/traffic/hourly.js parseBwToBytes), *_month_* (сверка), *_yesterday_*.
function validateBandwidthReportAll(bw) {
  const v = [];
  if (!bw || typeof bw !== 'object' || Array.isArray(bw)) return ['bandwidth_report_all: ожидался object, получен ' + (Array.isArray(bw) ? 'array' : typeof bw)];
  _sampleEntries(bw, (key, b) => {
    if (!b || typeof b !== 'object') { v.push(`bw[${key}]: не object`); return null; }
    if (typeof b.port !== 'string' || !b.port) v.push(`bw[${key}]: нет port (string)`);
    if (typeof b.portName !== 'string') v.push(`bw[${key}]: нет portName (string)`);
    if (typeof b.bandwidth_bytes_day_in !== 'string') v.push(`bw[${key}]: bandwidth_bytes_day_in не string ("N.N GB")`);
    if (typeof b.bandwidth_bytes_day_out !== 'string') v.push(`bw[${key}]: bandwidth_bytes_day_out не string`);
    return null;
  });
  return v;
}

// /apix/show_status_json → [ { modem_details: { IMEI, NICK, ... }, net_details: { IS_ONLINE, ... } } ]
// Код читает: m.modem_details.IMEI/NICK/MODEL, m.net_details.IS_ONLINE/EXT_IP/ICCID/SimStatus…
// Записи БЕЗ IMEI — легальны: ProxySmart так показывает модем в процессе
// добавления ("dev … is not yet processed"), парсер их пропускает
// (modem-tracking.js: `if (!imei) continue`). Нарушение — когда без IMEI
// ВСЯ выборка (парсер пропустит весь флот) или битая запись С IMEI.
function validateShowStatusJson(status) {
  const v = [];
  if (!Array.isArray(status)) return ['show_status_json: ожидался array, получен ' + typeof status];
  const sample = status.slice(0, SAMPLE);
  let skippedNoImei = 0;
  for (const m of sample) {
    if (!m || typeof m !== 'object') { v.push('status[]: элемент не object'); continue; }
    const md = m.modem_details;
    if (!md || typeof md !== 'object') { v.push('status[]: нет modem_details'); continue; }
    if (typeof md.IMEI !== 'string' || !md.IMEI) { skippedNoImei++; continue; }
    if (typeof md.NICK !== 'string') v.push(`status[${md.IMEI}]: нет modem_details.NICK`);
    if (!m.net_details || typeof m.net_details !== 'object') v.push(`status[${md.IMEI}]: нет net_details`);
  }
  if (sample.length > 0 && skippedNoImei === sample.length) {
    v.push(`show_status_json: все ${sample.length} эл-тов выборки без modem_details.IMEI — парсер пропустит весь флот`);
  }
  return v;
}

// /apix/list_ports_json → { imei: [ { HTTP_PORT, LOGIN, PASSWORD, ... } ] }
// Код читает: p.HTTP_PORT, p.LOGIN, p.PASSWORD, p.PROXY_VALID_BEFORE, p.IS_EXPIRED.
function validateListPortsJson(ports) {
  const v = [];
  if (!ports || typeof ports !== 'object' || Array.isArray(ports)) return ['list_ports_json: ожидался object, получен ' + (Array.isArray(ports) ? 'array' : typeof ports)];
  _sampleEntries(ports, (imei, list) => {
    if (!Array.isArray(list)) { v.push(`ports[${imei}]: не array`); return null; }
    for (const p of list.slice(0, 2)) {
      if (!p || typeof p !== 'object') { v.push(`ports[${imei}][]: не object`); continue; }
      if (p.HTTP_PORT == null || p.HTTP_PORT === '') v.push(`ports[${imei}][]: нет HTTP_PORT`);
      if (typeof p.LOGIN !== 'string') v.push(`ports[${imei}][]: нет LOGIN (string)`);
    }
    return null;
  });
  return v;
}

// Агрегат для fetchServerData ({ bw, status, ports }).
function validateFetchResult(result) {
  if (!result || typeof result !== 'object') return ['fetch result: не object'];
  return [
    ...validateBandwidthReportAll(result.bw),
    ...validateShowStatusJson(result.status),
    ...validateListPortsJson(result.ports),
  ];
}

module.exports = {
  validateBandwidthReportAll,
  validateShowStatusJson,
  validateListPortsJson,
  validateFetchResult,
};
