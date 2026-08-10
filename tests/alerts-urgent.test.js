// D4 (2026-08): URGENT_ACTIONS-контур logActivity переведён в rules-движок
// alerts.js. Регрессионные проверки:
//   - каждое urgent-событие — правило RULES с cooldownSec 900 (прежние 15 мин);
//   - немедленность: trigger() шлёт TG сразу (без батчинга/дайджеста);
//   - кулдаун по (rule, target) — как старый (action, target);
//   - долговые сигналы — общий dedupeKey-family debt_<client_id>_<signal>.

import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';

const alerts = require('../src/telegram/alerts.js');

const URGENT_RULE_IDS = [
  'billing_failed', 'billing_unique_conflict', 'tochka_sync_failed',
  'tochka_unverified_webhook', 'uncaught_exception', 'unhandled_rejection',
  'telegram_summary_failed', 'system_critical',
];

let sendMessage;
beforeAll(() => {
  sendMessage = vi.fn().mockResolvedValue({});
  alerts.init({
    logger: { warn: () => {}, info: () => {}, error: () => {} },
    getSetting: (k, d) => d,
    appSettings: { telegram_bot_token: 'tok', telegram_chat_id: '123' },
    kvSetCritical: () => ({ ok: true }),
    kvGet: { get: () => undefined },
    db: { prepare: () => ({ run: () => ({ lastInsertRowid: 1 }), get: () => undefined }) },
    tgBot: { sendMessage },
  });
  // trigger() молчит первые 5 минут после загрузки модуля (boot grace) —
  // переносим «сейчас» за пределы окна.
  vi.useFakeTimers();
  vi.setSystemTime(Date.now() + 10 * 60 * 1000);
});

beforeEach(() => { sendMessage.mockClear(); });

afterAll(() => { vi.useRealTimers(); });   // процесс общий (fileParallelism=false)

describe('D4: URGENT_ACTIONS → RULES', () => {
  it('все urgent-события стали правилами с кулдауном 15 мин (900 сек)', () => {
    for (const id of URGENT_RULE_IDS) {
      const rule = alerts.RULES[id];
      expect(rule, id).toBeTruthy();
      expect(rule.cooldownSec, id).toBe(900);
      expect(rule.priority, id).toBe('critical');
      expect(rule.defaultOn, id).toBe(true);
      expect(typeof rule.render, id).toBe('function');
      expect(typeof rule.dedupeKey, id).toBe('function');
    }
  });

  it('critical шлёт TG немедленно и в старом формате', () => {
    const sent = alerts.trigger('system_critical', {
      level: 'critical', action: 'integrity_regression', target: 'api_servers', message: 'metadata regressed',
    });
    expect(sent).toBe(true);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const [token, chatId, text] = sendMessage.mock.calls[0];
    expect(token).toBe('tok');
    expect(chatId).toBe('123');
    expect(text).toContain('🚨');
    expect(text).toContain('CRITICAL');
    expect(text).toContain('integrity_regression');
    expect(text).toContain('api_servers');
    expect(text).toContain('metadata regressed');
  });

  it('кулдаун по (rule, target): повтор глушится, другой target проходит', () => {
    const p = { level: 'error', action: 'billing_failed', target: 'DailyBilling', message: 'boom' };
    expect(alerts.trigger('billing_failed', p)).toBe(true);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(alerts.trigger('billing_failed', p)).toBe(false);   // тот же (rule,target) — кулдаун
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(alerts.trigger('billing_failed', { ...p, target: 'ShadowBilling' })).toBe(true);
    expect(sendMessage).toHaveBeenCalledTimes(2);
  });

  it('error-правило рендерит ⚠️ ERROR (не critical-иконку)', () => {
    alerts.trigger('uncaught_exception', { level: 'error', action: 'uncaught_exception', message: 'x' });
    const text = sendMessage.mock.calls[0][2];
    expect(text).toContain('⚠️');
    expect(text).toContain('ERROR');
  });
});

describe('D4: долговые сигналы — общий dedupeKey-family', () => {
  it('debt_<client_id>_<signal> у всех долговых правил', () => {
    const p = { client_id: 'cl_1' };
    expect(alerts.RULES.client_charge_failed.dedupeKey(p)).toBe('debt_cl_1_charge_failed');
    expect(alerts.RULES.client_balance_negative.dedupeKey(p)).toBe('debt_cl_1_balance_negative');
    expect(alerts.RULES.client_debt.dedupeKey(p)).toBe('debt_cl_1_debt');
    expect(alerts.RULES.client_blocked_debt.dedupeKey(p)).toBe('debt_cl_1_blocked');
    expect(alerts.RULES.client_unblocked_debt.dedupeKey(p)).toBe('debt_cl_1_unblocked');
    expect(alerts.RULES.client_block_warning.dedupeKey(p)).toBe('debt_cl_1_block_warning');
  });

  it('частоты не изменились: кулдауны долговых правил прежние', () => {
    expect(alerts.RULES.client_charge_failed.cooldownSec).toBe(86400);
    expect(alerts.RULES.client_balance_negative.cooldownSec).toBe(86400);
    expect(alerts.RULES.client_debt.cooldownSec).toBe(86400);
    expect(alerts.RULES.client_debt.channel).toBe('bell');
    expect(alerts.RULES.client_block_warning.cooldownSec).toBe(259200);
  });
});
