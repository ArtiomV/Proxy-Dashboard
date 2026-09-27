// 2026-09-27: подавление алертов нестабильности по модемам в состоянии
// «пакет исчерпан» УБРАНО по решению владельца (EXHAUST_SUPPRESSED_RULES и
// гейт в alerts.js удалены). Детекция и сами алерты sim_package_exhausted /
// sim_package_recovered / operator_package_throttled остаются — здесь их render.

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const alerts = require('../src/telegram/alerts.js');

beforeAll(() => {
  alerts.init({
    logger: { warn() {}, info() {}, error() {}, debug() {} },
    getSetting: (k, d) => d,
    appSettings: {},
    kvSetCritical: () => ({ ok: true }),
    kvGet: { get: () => undefined },
    db: null,
    tgBot: null,
  });
});
afterAll(() => { vi.useRealTimers(); });

describe('sim_package_exhausted: render различает сигнатуры', () => {
  it('kind=throttled — текст про урезанную скорость; без kind — про отсутствие IP', () => {
    const rule = alerts.RULES.sim_package_exhausted;
    const throttled = rule.render({ nick: 'MD_5', server: 'S1', kind: 'throttled', dl: 0.5, operator: 'Moldcell', used_gb: 28.4 });
    expect(throttled).toContain('урезана оператором');
    expect(throttled).toContain('0.5 Mbps');
    const classic = rule.render({ nick: 'MD_5', server: 'S1', mins: 20, operator: 'Moldcell' });
    expect(classic).toContain('кончился трафик');
    expect(classic).not.toContain('урезана оператором');
    // Операторский алерт существует и рендерится
    const opText = alerts.RULES.operator_package_throttled.render({ server: 'S1', operator: 'Moldcell', exhausted: 4, total: 4 });
    expect(opText).toContain('Moldcell');
    expect(opText).toContain('4 из 4');
  });
});

describe('sim_package_exhausted: render для сигнатуры «замороженный трафик»', () => {
  it('evidence «трафик заморожен N мин» — текст про заморозку', () => {
    const rule = alerts.RULES.sim_package_exhausted;
    const text = rule.render({ nick: 'MD_F', server: 'S1', kind: 'throttled', dl: 0.4, operator: 'Moldcell', evidence: 'трафик заморожен 25 мин' });
    expect(text).toContain('замерз');
    expect(text).toContain('25 мин');
    expect(text).toContain('0.4 Mbps');
  });
});
