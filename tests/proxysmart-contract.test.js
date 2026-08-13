// D7 (2026-08): shape-валидация ответов /apix/* по контракту
// (docs/PROXYSMART-CONTRACT.md). Чистые валидаторы src/api/proxysmart-contract.js
// + правило алерта (cooldown сутки, «один раз в сутки на бокс»).

import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const contract = require('../src/api/proxysmart-contract.js');
const alerts = require('../src/telegram/alerts.js');

// Формы взяты из реального server_cache.json (снимок прод-ответов).
const GOOD_BW = {
  portA: {
    port: 'portA', portName: 'Client1',
    bandwidth_bytes_day_in: '21.1 GB', bandwidth_bytes_day_out: '3.4 GB',
    bandwidth_bytes_month_in: '267.8 GB', bandwidth_bytes_month_out: '39.5 GB',
  },
};
const GOOD_STATUS = [{
  modem_details: { IMEI: '867389050342533', NICK: 'RO_1', MODEL: 'MF289' },
  net_details: { IS_ONLINE: 'yes', EXT_IP: '10.0.0.1', ICCID: '8970', SimStatus: 'OK' },
}];
const GOOD_PORTS = {
  '867389050342533': [{ HTTP_PORT: '8031', LOGIN: 'S54KDSog', PASSWORD: 'x', PROXY_VALID_BEFORE: '' }],
};

describe('D7: proxysmart-contract — валидные ответы проходят', () => {
  it('реальный снимок прод-ответов → нарушений нет', () => {
    expect(contract.validateBandwidthReportAll(GOOD_BW)).toEqual([]);
    expect(contract.validateShowStatusJson(GOOD_STATUS)).toEqual([]);
    expect(contract.validateListPortsJson(GOOD_PORTS)).toEqual([]);
    expect(contract.validateFetchResult({ bw: GOOD_BW, status: GOOD_STATUS, ports: GOOD_PORTS })).toEqual([]);
  });

  it('пустые коллекции — легальное состояние, не нарушение', () => {
    expect(contract.validateFetchResult({ bw: {}, status: [], ports: {} })).toEqual([]);
  });
});

describe('D7: proxysmart-contract — несоответствия ловятся', () => {
  it('верхнеуровневый тип изменился (HTML-заглушка распарсилась в строку)', () => {
    expect(contract.validateFetchResult({ bw: 'oops', status: GOOD_STATUS, ports: GOOD_PORTS })[0])
      .toMatch(/bandwidth_report_all/);
    expect(contract.validateShowStatusJson({ raw: '<html>auth wall</html>' })[0])
      .toMatch(/show_status_json/);
  });

  it('поля сменили тип/пропали — каждое фиксируется', () => {
    // bool — невалидный тип счётчика; number/null были бы легальны (см. соседние тесты)
    const v = contract.validateBandwidthReportAll({ portA: { port: 'portA', bandwidth_bytes_day_in: true } });
    expect(v.some(s => s.includes('portName'))).toBe(true);
    expect(v.some(s => s.includes('bandwidth_bytes_day_in'))).toBe(true);

    const vs = contract.validateShowStatusJson([{ modem_details: { NICK: 'X' } }]);
    expect(vs.some(s => s.includes('IMEI'))).toBe(true); // вся выборка без IMEI — парсер пропустит весь флот

    const vsNet = contract.validateShowStatusJson([{ modem_details: { IMEI: '867', NICK: 'X' } }]);
    expect(vsNet.some(s => s.includes('net_details'))).toBe(true);

    const vp = contract.validateListPortsJson({ imei1: [{ LOGIN: 'a' }] });
    expect(vp.some(s => s.includes('HTTP_PORT'))).toBe(true);
  });

  it('транзитный модем в добавлении (без IMEI) среди нормальных — НЕ нарушение', () => {
    const adding = { Added_EVENT_ID: 'px_add_dev_x', modem_details: { ADDED_TIME: '' }, MSGS: ['error, dev lanmodem12 is not yet processed, wait up to 5 min, '] };
    expect(contract.validateShowStatusJson([adding, GOOD_STATUS[0]])).toEqual([]);
  });

  it('null-счётчики (сброс на боксе) и числовой 0 (пустой день) — НЕ нарушение, парсер мапит в 0', () => {
    // Прод 13.08.2026: S1/S2 отдали bandwidth_bytes_day_in/out = null у части
    // портов в момент сброса суточных счётчиков (bandwidth_bytes_prevmonth_in: null
    // — вообще постоянное явление), а S1–S4 — числовой 0 у портов без трафика за день.
    const nullCounters = { portB: { port: 'portB', portName: 'Client2', bandwidth_bytes_day_in: null, bandwidth_bytes_day_out: null } };
    expect(contract.validateBandwidthReportAll({ ...nullCounters, ...GOOD_BW })).toEqual([]);
    const zeroCounters = { portC: { port: 'portC', portName: 'Client3', bandwidth_bytes_day_in: 0, bandwidth_bytes_day_out: 0 } };
    expect(contract.validateBandwidthReportAll({ ...zeroCounters, ...GOOD_BW })).toEqual([]);
    // даже ВСЯ выборка в null/0 — легально: ночной сброс счётчиков бьёт по всем портам сразу
    expect(contract.validateBandwidthReportAll({ ...nullCounters, ...zeroCounters })).toEqual([]);
  });

  it('ВСЯ выборка с невалидным типом day_in/day_out — нарушение (фид деградировал, трафик = 0)', () => {
    const dead = {
      portB: { port: 'portB', portName: 'C2', bandwidth_bytes_day_in: {}, bandwidth_bytes_day_out: {} },
      portC: { port: 'portC', portName: 'C3', bandwidth_bytes_day_in: [1], bandwidth_bytes_day_out: 'oops'.length ? undefined : null },
    };
    const v = contract.validateBandwidthReportAll(dead);
    expect(v.some(s => s.includes('все') && s.includes('day_in/day_out'))).toBe(true);
  });
});

describe('D7: правило алерта «бокс отвечает не по контракту»', () => {
  it('proxysmart_contract_mismatch: cooldown сутки, dedupe по боксу', () => {
    const rule = alerts.RULES.proxysmart_contract_mismatch;
    expect(rule).toBeTruthy();
    expect(rule.cooldownSec).toBe(86400);
    expect(rule.dedupeKey({ server: 'S2' })).toBe('pscontract_S2');
    expect(rule.dedupeKey({ server: 'S2' })).not.toBe(rule.dedupeKey({ server: 'S4' }));
    const text = rule.render({ server: 'S2', count: 2, sample: 'bw[portA]: нет portName' });
    expect(text).toContain('S2');
    expect(text).toContain('не по контракту');
  });
});
