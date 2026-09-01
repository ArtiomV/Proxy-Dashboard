'use strict';

// Russian Trusted CA (НУЦ Минцифры). С 20.08.2026 enter.tochka.com отдаёт
// цепочку *.tochka.com ← Russian Trusted Sub CA ← Russian Trusted Root CA,
// которой нет в корневом сторе Node (Mozilla) — все вызовы API Точки падали
// с «self-signed certificate in certificate chain» (акты/счета создавались
// только локально, инцидент 01.09). Отдаём Mozilla-roots + бандл НУЦ: так
// работает и текущая «русская» цепочка, и обычная, если Точка вернётся
// на международный УЦ. Бандл: certs/russian-trusted-ca-bundle.pem
// (источник: https://gu-st.ru/content/Other/doc/russian_trusted_*_ca.cer).

const fs = require('fs');
const path = require('path');
const tls = require('tls');
const logger = require('../logger');

const BUNDLE_PATH = path.join(__dirname, '..', '..', 'certs', 'russian-trusted-ca-bundle.pem');

let _ca;   // undefined = не пробовали; null = бандла нет, дефолтные корни
function getTochkaCA() {
  if (_ca !== undefined) return _ca;
  try {
    const pem = fs.readFileSync(BUNDLE_PATH, 'utf8');
    if (!pem.includes('BEGIN CERTIFICATE')) throw new Error('bundle пустой/битый');
    _ca = [...tls.rootCertificates, pem];
  } catch (e) {
    logger.warn('[Tochka CA] certs/russian-trusted-ca-bundle.pem недоступен (' + e.message + ') — только дефолтные корни Node');
    _ca = null;
  }
  return _ca;
}

module.exports = { getTochkaCA };
