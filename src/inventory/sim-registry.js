'use strict';

const ICCID_HEADERS = new Set(['iccid', 'sim', 'simid', 'sim_id', 'сим', 'симкарта', 'сим-карта']);
const PHONE_HEADERS = new Set(['phone', 'phone_number', 'msisdn', 'телефон', 'номер', 'номертелефона']);
const OPERATOR_HEADERS = new Set(['operator', 'carrier', 'оператор']);
const NOTES_HEADERS = new Set(['notes', 'note', 'comment', 'примечание', 'комментарий']);

function compactHeader(value) {
  return String(value || '').replace(/^\uFEFF/, '').trim().toLowerCase().replace(/[\s.-]+/g, '');
}

function normalizeIccid(value) {
  const digits = String(value == null ? '' : value).replace(/\D/g, '');
  return /^\d{15,24}$/.test(digits) ? digits : '';
}

function normalizePhone(value) {
  const raw = String(value == null ? '' : value).trim();
  const digits = raw.replace(/\D/g, '');
  if (!/^\d{5,20}$/.test(digits)) return '';
  return raw.startsWith('+') ? `+${digits}` : digits;
}

function detectDelimiter(line) {
  const candidates = ['\t', ';', ','];
  let best = ';';
  let max = -1;
  for (const delimiter of candidates) {
    const count = (String(line || '').match(new RegExp(delimiter === '\t' ? '\\t' : `\\${delimiter}`, 'g')) || []).length;
    if (count > max) { max = count; best = delimiter; }
  }
  return best;
}

function splitDelimitedLine(line, delimiter) {
  const cells = [];
  let current = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') { current += '"'; i += 1; }
      else quoted = !quoted;
    } else if (ch === delimiter && !quoted) {
      cells.push(current.trim()); current = '';
    } else {
      current += ch;
    }
  }
  cells.push(current.trim());
  return cells;
}

function headerIndex(cells, variants) {
  return cells.findIndex(cell => variants.has(compactHeader(cell)));
}

function parseSimRegistryText(text, { maxRows = 5000 } = {}) {
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
  const firstLine = lines.find(line => line.trim());
  if (!firstLine) return { rows: [], errors: [{ line: 1, error: 'Файл пуст' }] };
  const delimiter = detectDelimiter(firstLine);
  const firstCells = splitDelimitedLine(firstLine, delimiter);
  const header = {
    iccid: headerIndex(firstCells, ICCID_HEADERS),
    phone: headerIndex(firstCells, PHONE_HEADERS),
    operator: headerIndex(firstCells, OPERATOR_HEADERS),
    notes: headerIndex(firstCells, NOTES_HEADERS),
  };
  const hasHeader = header.iccid >= 0 || header.phone >= 0;
  if (!hasHeader) {
    header.iccid = 0; header.phone = 1; header.operator = 2; header.notes = 3;
  } else if (header.iccid < 0 || header.phone < 0) {
    return { rows: [], errors: [{ line: 1, error: 'В заголовке нужны колонки ICCID и Телефон' }] };
  }

  const rows = [];
  const errors = [];
  const seen = new Map();
  let skippedHeader = !hasHeader;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.trim()) continue;
    if (!skippedHeader) { skippedHeader = true; continue; }
    if (rows.length >= maxRows) {
      errors.push({ line: i + 1, error: `Лимит импорта — ${maxRows} строк` });
      break;
    }
    const cells = splitDelimitedLine(line, delimiter);
    const iccid = normalizeIccid(cells[header.iccid]);
    const phone = normalizePhone(cells[header.phone]);
    if (!iccid || !phone) {
      errors.push({
        line: i + 1,
        error: !iccid ? 'Некорректный ICCID (ожидается 15–24 цифры)' : 'Некорректный номер телефона',
      });
      continue;
    }
    const row = {
      iccid,
      phone,
      operator: header.operator >= 0 ? String(cells[header.operator] || '').trim().slice(0, 100) : '',
      notes: header.notes >= 0 ? String(cells[header.notes] || '').trim().slice(0, 500) : '',
    };
    if (seen.has(iccid)) rows[seen.get(iccid)] = row;
    else { seen.set(iccid, rows.length); rows.push(row); }
  }
  return { rows, errors, delimiter: delimiter === '\t' ? 'tab' : delimiter };
}

module.exports = { normalizeIccid, normalizePhone, parseSimRegistryText };

