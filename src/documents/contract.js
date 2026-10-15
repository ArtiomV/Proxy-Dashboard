'use strict';
//
// src/documents/contract.js — договор возмездного оказания услуг для юрлица/ИП из ЛК
// (шаблон — src/documents/templates/dogovor-uslugi.docx, редакция владельца 15.10.2026).
//
// Шаблон подставляется точечно: в docx остаются форматирование, колонтитулы и все
// пункты как в оригинале — меняются только строки-заготовки с подчёркиваниями
// (номер, дата, преамбула, реквизиты заказчика, подпись). Склонение должности и
// ФИО подписанта («в лице …») — по простым правилам, это лучшее приближение:
// менеджер просматривает договор перед отправкой по ЭДО.

const fs = require('fs');
const path = require('path');
const JSZip = require('jszip');

const TEMPLATE = path.join(__dirname, 'templates', 'dogovor-uslugi.docx');
const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];

const xmlEsc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// ── Склонение (родительный падеж) ────────────────────────────────────────────
const POS_NOUNS = { директор: 'директора', президент: 'президента', руководитель: 'руководителя', управляющий: 'управляющего', предприниматель: 'предпринимателя', представитель: 'представителя', учредитель: 'учредителя', председатель: 'председателя' };
function genWord(w) {
  const lw = w.toLowerCase();
  if (POS_NOUNS[lw]) return keepCase(w, POS_NOUNS[lw]);
  if (/ый$|ой$/i.test(w)) return w.slice(0, -2) + 'ого';
  if (/ий$/i.test(w)) return w.slice(0, -2) + 'его';
  if (/ая$/i.test(w)) return w.slice(0, -2) + 'ой';
  return w;
}
function keepCase(src, out) { return src[0] === src[0].toUpperCase() ? out[0].toUpperCase() + out.slice(1) : out; }
function genPosition(pos) { return String(pos || '').trim().split(/\s+/).filter(Boolean).map(genWord).join(' '); }

function genName(fio) {
  const parts = String(fio || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '';
  const female = parts.length >= 3 ? /(на|ая)$/i.test(parts[2]) : /(ова|ева|ёва|ина|ына|ая|ская|цкая)$/i.test(parts[0]);
  const isSurname = (i) => i === 0;
  return parts.map((w, i) => (female ? genFemale(w, i) : genMale(w, i))).join(' ');
}
function genMale(w, i) {
  if (/(ов|ев|ёв|ин|ын)$/i.test(w) && i === 0) return w + 'а';
  if (i === 1 && /ий$/i.test(w)) return w.slice(0, -2) + 'ия';          // Дмитрий → Дмитрия
  if (/(ий|ый|ой)$/i.test(w)) return w.slice(0, -2) + 'ого';           // фамилии: Жуковский → Жуковского
  if (/ич$/i.test(w)) return w + 'а';
  if (/й$/i.test(w)) return w.slice(0, -1) + 'я';
  if (/ь$/i.test(w)) return w.slice(0, -1) + 'я';
  if (/а$/i.test(w)) return w.slice(0, -1) + (/[гкхжчшщ]$/i.test(w.slice(0, -1)) ? 'и' : 'ы');
  if (/я$/i.test(w)) return w.slice(0, -1) + 'и';
  if (/[бвгджзклмнпрстфхцчшщ]$/i.test(w)) return w + 'а';
  return w;
}
function genFemale(w, i) {
  if (/(ова|ева|ёва|ина|ына)$/i.test(w) && i === 0) return w.slice(0, -1) + 'ой';
  if (/ая$/i.test(w)) return w.slice(0, -2) + 'ой';
  if (/на$/i.test(w) && i === 2) return w.slice(0, -1) + 'ы';
  if (/а$/i.test(w)) return w.slice(0, -1) + (/[гкхжчшщ]$/i.test(w.slice(0, -1)) ? 'и' : 'ы');
  if (/я$/i.test(w)) return w.slice(0, -1) + 'и';
  if (/ь$/i.test(w)) return w.slice(0, -1) + 'и';
  return w;   // несклоняемая фамилия
}
// «Иванов Иван Иванович» → «Иванов И. И.»
function shortName(fio) {
  const p = String(fio || '').trim().split(/\s+/).filter(Boolean);
  if (!p.length) return '';
  return [p[0], ...p.slice(1).map(x => x[0].toUpperCase() + '.')].join(' ');
}
const isIp = (r) => String(r.inn || '').replace(/\D/g, '').length === 12;
const rusDate = (d) => `«${String(d.getDate()).padStart(2, '0')}» ${MONTHS[d.getMonth()]} ${d.getFullYear()} г.`;

// Заменяет содержимое <w:t>, начинающегося с `startsWith`, на `text`; возвращает новый xml.
function setRun(xml, startsWith, text) {
  const re = new RegExp('(<w:t(?: [^>]*)?>)' + startsWith.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[^<]*(</w:t>)');
  if (!re.test(xml)) throw new Error('В шаблоне не найдена строка «' + startsWith + '»');
  return xml.replace(re, (m, a, b) => a + xmlEsc(text) + b);
}

function preamble(r) {
  const tail = ', именуемый в дальнейшем «Заказчик», с одной стороны, и Индивидуальный предприниматель Васильев Артем (ИНН 770208379261, ОГРНИП 321774600371372), именуемый в дальнейшем «Исполнитель», с другой стороны, вместе именуемые «Стороны», заключили настоящий договор (далее — Договор) о нижеследующем:';
  if (isIp(r)) {
    const nm = String(r.legal_name || r.signer_name || '').replace(/^\s*(ИП|Индивидуальный предприниматель)\s+/i, '').trim();
    return `Индивидуальный предприниматель ${nm}${r.ogrn ? ` (ОГРНИП ${r.ogrn})` : ''}${tail}`;
  }
  const lic = [genPosition(r.signer_position), genName(r.signer_name)].filter(Boolean).join(' ');
  const basis = String(r.signer_basis || 'Устава').trim();
  return `${r.legal_name}, в лице ${lic}, действующего на основании ${basis}${tail.replace('именуемый', 'именуемое')}`;
}

// → Buffer docx. r — анкета (requisites), number — номер договора, date — Date.
async function buildContract(r, number, date) {
  const zip = await JSZip.loadAsync(fs.readFileSync(TEMPLATE));
  let xml = await zip.file('word/document.xml').async('string');
  const ip = isIp(r);
  xml = setRun(xml, '№ ', `№ ${number}`);
  xml = setRun(xml, 'дата заключения:', `дата заключения: ${rusDate(date)}`);
  xml = setRun(xml, '____________________________________________________________________ (наименование организации)', preamble(r));
  xml = setRun(xml, 'Наименование:', `Наименование: ${r.legal_name || ''}`);
  xml = setRun(xml, 'ИНН:', `ИНН: ${r.inn || ''}`);
  xml = setRun(xml, 'КПП:', `КПП: ${ip ? '—' : (r.kpp || '')}`);
  xml = setRun(xml, 'ОГРН:', `${ip ? 'ОГРНИП' : 'ОГРН'}: ${r.ogrn || ''}`);
  xml = setRun(xml, 'Юридический адрес:', `Юридический адрес: ${r.legal_address || ''}`);
  xml = setRun(xml, 'Почтовый адрес:', `Почтовый адрес: ${r.postal_address || r.legal_address || ''}`);
  xml = setRun(xml, 'р/с:', `р/с: ${r.account || ''}`);
  xml = setRun(xml, 'Банк:', `Банк: ${r.bank_name || ''}`);
  xml = setRun(xml, 'к/с:', `к/с: ${r.corr_account || ''}`);
  xml = setRun(xml, 'БИК:', `БИК: ${r.bik || ''}`);
  xml = setRun(xml, 'email:', `email: ${r.contact_email || ''}`);
  xml = setRun(xml, 'Тел.:', `Тел.: ${r.contact_phone || ''}`);
  xml = setRun(xml, '________________ / ________________ /', `________________ / ${shortName(r.signer_name || (ip ? r.legal_name : ''))} /`);
  zip.file('word/document.xml', xml);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

module.exports = { buildContract, genName, genPosition, shortName, rusDate, isIp, preamble };
