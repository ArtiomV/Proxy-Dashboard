// Stage 14.1 invariant test.
//
// The TZ-stated invariant:
//   "После имитации «перезагрузки» состояния (повторный init/load)
//    роутер видит новые данные через ту же ссылку."
//
// Pre-fix: server.js held `let appSettings = {...}`, and reloading
// settings rebound the binding (`appSettings = JSON.parse(...)`). Any
// router that destructured `appSettings` at mount time pointed at the
// OLD object — same shape of bug as the original billingLedger /
// clientById issue that Stage 4 solved.
//
// Post-fix: replaceObject() mutates state.appSettings (and friends)
// in place. The object identity is the same for the process lifetime,
// so router-side `const appSettings = deps.appSettings` always sees
// the latest fields.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'module';
import { bootApp } from './_helpers/app.js';

const cjsRequire = createRequire(import.meta.url);
let stateMod;
// Tests in this file mutate state.appSettings + state.tochkaConfig +
// state.portKeyToPortName. The harness shares one process across files,
// so we snapshot + restore to keep the rest of the suite stable.
let _snapshot = null;

beforeAll(() => {
  bootApp();
  stateMod = cjsRequire('../src/state/index.js');
  _snapshot = {
    appSettings: { ...stateMod.state.appSettings },
    tochkaConfig: { ...stateMod.state.tochkaConfig },
    portKeyToPortName: { ...stateMod.state.portKeyToPortName },
  };
});

afterAll(() => {
  if (_snapshot) {
    stateMod.setAppSettings(_snapshot.appSettings);
    stateMod.setTochkaConfig(_snapshot.tochkaConfig);
    stateMod.setPortKeyToPortName(_snapshot.portKeyToPortName);
  }
});

describe('Stage 14.1: replaceObject preserves identity (stable references)', () => {
  it('replaceObject() mutates the target in place', () => {
    const t = { a: 1, b: 2 };
    const ref = t;
    stateMod.replaceObject(t, { c: 3, d: 4 });
    // Identity preserved
    expect(ref).toBe(t);
    // Contents replaced (old keys gone, new keys present)
    expect(t).toEqual({ c: 3, d: 4 });
    expect(t.a).toBeUndefined();
  });

  it('setAppSettings: a router that captured the reference sees new fields', () => {
    // Simulate the router mount: take the reference NOW.
    const capturedAtMount = stateMod.state.appSettings;
    // Imitate a reload: a totally different settings object replaces contents.
    stateMod.setAppSettings({ admin_password: 'NEW', some_new_key: 42 });
    // The captured reference observes the new contents.
    expect(capturedAtMount.admin_password).toBe('NEW');
    expect(capturedAtMount.some_new_key).toBe(42);
    // Identity STILL the same — would-be regression: rebinding would
    // break this expectation (the captured ref would point at the old obj).
    expect(capturedAtMount).toBe(stateMod.state.appSettings);
  });

  it('setTochkaConfig: same identity guarantee for the Tochka credentials', () => {
    const captured = stateMod.state.tochkaConfig;
    stateMod.setTochkaConfig({ jwt: 'TOKEN_X', clientId: 'CLI_X' });
    expect(captured.jwt).toBe('TOKEN_X');
    expect(captured.clientId).toBe('CLI_X');
    expect(captured).toBe(stateMod.state.tochkaConfig);
    // Replace again — old keys cleared
    stateMod.setTochkaConfig({ jwt: 'TOKEN_Y' });
    expect(captured.jwt).toBe('TOKEN_Y');
    expect(captured.clientId).toBeUndefined();
  });

  it('setPortKeyToPortName: routers see the freshest mapping via the same ref', () => {
    const captured = stateMod.state.portKeyToPortName;
    stateMod.setPortKeyToPortName({ 'S1_p1': 'Brandanalytics' });
    expect(captured['S1_p1']).toBe('Brandanalytics');
    stateMod.setPortKeyToPortName({ 'S2_p9': 'OtherClient' });
    expect(captured['S1_p1']).toBeUndefined();
    expect(captured['S2_p9']).toBe('OtherClient');
    expect(captured).toBe(stateMod.state.portKeyToPortName);
  });

  it('all Stage 14.1 globals exist as state properties with stable references', () => {
    const keys = ['dailyTraffic', 'ipTracking', 'uptimeTracking', 'ipHistory',
                  'appSettings', 'knownModems', 'tochkaConfig', 'portKeyToPortName'];
    for (const k of keys) {
      expect(stateMod.state).toHaveProperty(k);
      expect(typeof stateMod.state[k]).toBe('object');
    }
  });
});
