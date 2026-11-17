export function parseCsv (text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') { field += '"'; index++; }
      else if (character === '"') { quoted = false; }
      else { field += character; }
    } else if (character === '"' && field.length === 0) { quoted = true; }
    else if (character === ',') { row.push(field); field = ''; }
    else if (character === '\n' || character === '\r') {
      if (character === '\r' && text[index + 1] === '\n') { index++; }
      row.push(field); field = '';
      if (row.some(value => value !== '')) { rows.push(row); }
      row = [];
    } else { field += character; }
  }
  if (quoted) { throw new Error('The CSV contains an unterminated quoted field.'); }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  if (!rows.length) { return []; }
  const headers = rows.shift().map(value => value.replace(/^\uFEFF/, '').trim());
  if (!headers.length || headers.some(header => !header)) { throw new Error('The CSV is missing column names.'); }
  return rows.map(values => Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ''])));
}
