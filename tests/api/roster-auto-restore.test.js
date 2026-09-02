// Auto-restore of soft-deleted modems (2026-08-04): a reconnected modem must
// reappear on its own — but only after N CONSECUTIVE online polls, so a
// flapping modem's one-poll blip never clears the deleted flag.
// Гейт «реального возврата» (2026-09-01, MD1): восстановление только если
// модем после удаления хоть раз был замечен ОФФЛАЙН — удалённый «на живую»
// (непрерывно онлайн) модем не воскресает.

import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const modemsSvc = require('../../src/services/modems.js');

const SRV = 'S4', IMEI = 'IMEI_DEL_1', PID = 'portDEL1';

function makeFeed(isOnline, portName = 'WildBox') {
  return {
    serverName: SRV,
    bw: { [PID]: { portName } },
    ports: { [IMEI]: [{ portID: PID, portName }] },
    status: [{
      modem_details: { IMEI, NICK: 'MD_01', MODEL: 'E3372' },
      net_details: { IS_ONLINE: isOnline ? 'yes' : 'no' },
    }],
  };
}

function makeSvc(appSettings = {}) {
  const deletedModemSet = new Set([SRV + '|' + IMEI]);
  const knownModems = {};
  const calls = { undelete: 0, saves: 0 };
  const svc = modemsSvc.create({
    db: { prepare: () => ({ all: () => [] }) },
    logger: { info() {}, warn() {}, error() {} },
    knownModems,
    saveKnownModems: () => { calls.saves++; },
    deletedModemSet,
    appSettings,
    trackingDb: {
      metaNickByImeiStmt: () => ({ get: () => ({ nick: 'MD_01' }) }),
      metaUndeleteStmt: () => ({ run: () => { calls.undelete++; return { changes: 1 }; } }),
    },
  });
  return { svc, deletedModemSet, knownModems, calls };
}

describe('roster auto-restore (hysteresis)', () => {
  it('restores a deleted modem only on the 3rd consecutive online poll', () => {
    const { svc, deletedModemSet, knownModems, calls } = makeSvc();

    svc.updateKnownModems(makeFeed(false));  // сначала модем реально ушёл в оффлайн (гейт 2026-09-01)
    svc.updateKnownModems(makeFeed(true));
    svc.updateKnownModems(makeFeed(true));
    expect(deletedModemSet.has(SRV + '|' + IMEI)).toBe(true);   // ещё удалён
    expect(calls.undelete).toBe(0);
    expect((knownModems[SRV] || {})[PID]).toBeUndefined();       // порт не в ростере

    svc.updateKnownModems(makeFeed(true));
    expect(calls.undelete).toBe(1);                              // DB-флаг снят
    expect(deletedModemSet.has(SRV + '|' + IMEI)).toBe(false);   // set очищен
    expect(knownModems[SRV][PID].portName).toBe('WildBox');      // порт в ростере → в счётчик клиента
  });

  it('never restores a deleted modem that stays online (deleted «на живую», MD1 case)', () => {
    const { svc, deletedModemSet, knownModems, calls } = makeSvc();
    for (let i = 0; i < 6; i++) svc.updateKnownModems(makeFeed(true));
    expect(calls.undelete).toBe(0);                            // оффлайна не было — не «возврат»
    expect(deletedModemSet.has(SRV + '|' + IMEI)).toBe(true);
    expect((knownModems[SRV] || {})[PID]).toBeUndefined();
  });

  it('never restores a deleted modem that stays offline', () => {
    const { svc, deletedModemSet, knownModems, calls } = makeSvc();
    for (let i = 0; i < 5; i++) svc.updateKnownModems(makeFeed(false));
    expect(calls.undelete).toBe(0);
    expect(deletedModemSet.has(SRV + '|' + IMEI)).toBe(true);
    expect((knownModems[SRV] || {})[PID]).toBeUndefined();
  });

  it('a one-poll blip resets the streak (flapping modem stays deleted)', () => {
    const { svc, deletedModemSet, knownModems, calls } = makeSvc();
    svc.updateKnownModems(makeFeed(true));    // блип 1
    svc.updateKnownModems(makeFeed(false));   // сброс серии
    svc.updateKnownModems(makeFeed(true));    // 1 подряд
    svc.updateKnownModems(makeFeed(true));    // 2 подряд
    expect(calls.undelete).toBe(0);
    expect(deletedModemSet.has(SRV + '|' + IMEI)).toBe(true);
    svc.updateKnownModems(makeFeed(true));    // 3 подряд → восстановлен
    expect(calls.undelete).toBe(1);
    expect(knownModems[SRV][PID].portName).toBe('WildBox');
  });

  it('non-deleted modems are ingested on the first poll, no undelete call', () => {
    const { svc, deletedModemSet, knownModems, calls } = makeSvc();
    deletedModemSet.clear();
    svc.updateKnownModems(makeFeed(true));
    expect(calls.undelete).toBe(0);
    expect(knownModems[SRV][PID].portName).toBe('WildBox');
  });

  it('threshold is configurable via appSettings.modem_restore_online_polls', () => {
    const { svc, knownModems, calls } = makeSvc({ modem_restore_online_polls: 1 });
    svc.updateKnownModems(makeFeed(false));   // гейт: сначала оффлайн
    svc.updateKnownModems(makeFeed(true));
    expect(calls.undelete).toBe(1);
    expect(knownModems[SRV][PID]).toBeTruthy();
  });

  it('restores ONLY the returned IMEI — sibling IMEI under the same nick stays deleted (MD2_54/55/58, 2026-09-01)', () => {
    const OLD_IMEI = 'IMEI_OLD_SLOT';
    const { svc, deletedModemSet, knownModems, calls } = makeSvc();
    deletedModemSet.add(SRV + '|' + OLD_IMEI);   // старое железо того же слота, тоже удалено
    svc.updateKnownModems(makeFeed(false));
    svc.updateKnownModems(makeFeed(true));
    svc.updateKnownModems(makeFeed(true));
    svc.updateKnownModems(makeFeed(true));
    expect(calls.undelete).toBe(1);
    expect(deletedModemSet.has(SRV + '|' + IMEI)).toBe(false);       // вернувшийся восстановлен
    expect(deletedModemSet.has(SRV + '|' + OLD_IMEI)).toBe(true);    // старый НЕ воскресает
  });
});
