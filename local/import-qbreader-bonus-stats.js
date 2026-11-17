import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { importQbReaderBonusStats } from './sqlite-store.js';

function parseCsv (text) {
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
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  if (!rows.length) { return []; }
  const headers = rows.shift().map(value => value.replace(/^\uFEFF/, '').trim());
  return rows.map(values => Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ''])));
}

const filename = process.argv[2];
if (!filename) {
  console.error('Usage: node local/import-qbreader-bonus-stats.js /path/to/bonus-stats.csv');
  process.exitCode = 2;
} else {
  const resolved = path.resolve(filename);
  const content = readFileSync(resolved, 'utf8');
  const records = parseCsv(content);
  const required = ['created', 'bonus._id', 'set._id', 'difficulty', 'category', 'subcategory', 'part1', 'part2', 'part3'];
  if (!records.length || required.some(key => !(key in records[0]))) { throw new Error('This file does not have the expected QBReader bonus stats columns.'); }
  const fileHash = createHash('sha256').update(content).digest('hex');
  const result = importQbReaderBonusStats(records, fileHash, resolved);
  console.log(JSON.stringify({ filename: path.basename(resolved), rowsInFile: records.length, ...result }, null, 2));
}
