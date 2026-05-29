// P2-2: locks the behaviour of parseHtmlInputFields after extraction from
// server.js. The move_port / edit_port flow depends on this exact parsing.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const cjsRequire = createRequire(import.meta.url);
const { parseHtmlInputFields } = cjsRequire('../src/utils/html-forms.js');

describe('parseHtmlInputFields', () => {
  it('returns {} for empty/null input', () => {
    expect(parseHtmlInputFields('')).toEqual({});
    expect(parseHtmlInputFields(null)).toEqual({});
  });

  it('parses <input name value> regardless of attribute order/quotes', () => {
    const html = `<input name="portName" value="WildBox">` +
                 `<input value='8001' name='http_port'/>`;
    expect(parseHtmlInputFields(html)).toEqual({ portName: 'WildBox', http_port: '8001' });
  });

  it('keeps the SELECTED option of a <select> (else the first)', () => {
    const sel = `<select name="op"><option value="a">A</option>` +
                `<option value="b" selected>B</option></select>`;
    expect(parseHtmlInputFields(sel).op).toBe('b');
    const noSel = `<select name="op2"><option value="x">X</option><option value="y">Y</option></select>`;
    expect(parseHtmlInputFields(noSel).op2).toBe('x');
  });

  it('reads <textarea> body (trimmed)', () => {
    expect(parseHtmlInputFields('<textarea name="note">  hi  </textarea>').note).toBe('hi');
  });
});
