// 01.09.2026: enter.tochka.com перешёл на цепочку НУЦ Минцифры (Russian
// Trusted Root/Sub CA), которой нет в корневом сторе Node — все вызовы API
// Точки падали с «self-signed certificate in certificate chain», акты и счета
// создавались только локально. getTochkaCA обязан отдавать Mozilla-roots +
// бандл НУЦ из certs/russian-trusted-ca-bundle.pem.

import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import tls from 'tls';
import { X509Certificate } from 'crypto';

const require = createRequire(import.meta.url);
const { getTochkaCA } = require('../src/tochka/ca.js');

describe('Tochka CA: бандл НУЦ Минцифры', () => {
  it('отдаёт дефолтные корни + бандл с Russian Trusted Root CA', () => {
    const ca = getTochkaCA();
    expect(Array.isArray(ca)).toBe(true);
    expect(ca.length).toBeGreaterThan(tls.rootCertificates.length);
    const bundle = ca[ca.length - 1];
    const certs = bundle.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) || [];
    expect(certs.length).toBeGreaterThanOrEqual(2);
    const subjects = certs.map(c => new X509Certificate(c).subject);
    expect(subjects.some(s => s.includes('Russian Trusted Root CA'))).toBe(true);
    expect(subjects.some(s => s.includes('Russian Trusted Sub CA'))).toBe(true);
  });

  it('кэширует результат (повторный вызов — та же ссылка)', () => {
    expect(getTochkaCA()).toBe(getTochkaCA());
  });
});
