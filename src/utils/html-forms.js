'use strict';

// P2-2: extracted verbatim from server.js (monolith reduction). Pure, stateless.
//
// Tolerant <input name="..." value="..."> parser — handles either attribute
// order, multi-line tags, single/double quotes, and self-closing slashes. Also
// reads the selected (or first) <option> of a <select> and <textarea> bodies.
// Used by the move_port / edit_port flow that round-trips ProxySmart's HTML forms.
// Returns a plain object { name: value, ... }.
function parseHtmlInputFields(html) {
  const fields = {};
  if (!html) return fields;
  const inputRe = /<input\b[^>]*?>/gi;
  let m;
  while ((m = inputRe.exec(html)) !== null) {
    const tag = m[0];
    const nameMatch  = tag.match(/\bname\s*=\s*["']([^"']+)["']/i);
    const valueMatch = tag.match(/\bvalue\s*=\s*["']([^"']*)["']/i);
    if (nameMatch && valueMatch !== null) {
      fields[nameMatch[1]] = valueMatch ? valueMatch[1] : '';
    }
  }
  // <select> with selected <option> — keep selected value
  const selectRe = /<select\b[^>]*?\bname\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/select>/gi;
  while ((m = selectRe.exec(html)) !== null) {
    const name = m[1], body = m[2];
    const selOpt = body.match(/<option\b[^>]*\bselected\b[^>]*\bvalue\s*=\s*["']([^"']*)["']/i)
                || body.match(/<option\b[^>]*\bvalue\s*=\s*["']([^"']*)["'][^>]*\bselected\b/i);
    if (selOpt) {
      fields[name] = selOpt[1];
    } else {
      const first = body.match(/<option\b[^>]*\bvalue\s*=\s*["']([^"']*)["']/i);
      if (first) fields[name] = first[1];
    }
  }
  // <textarea name="...">body</textarea>
  const textareaRe = /<textarea\b[^>]*?\bname\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/textarea>/gi;
  while ((m = textareaRe.exec(html)) !== null) {
    fields[m[1]] = m[2].trim();
  }
  return fields;
}

module.exports = { parseHtmlInputFields };
