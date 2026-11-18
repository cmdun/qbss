import { DatabaseSync } from 'node:sqlite';
import { createReadStream, existsSync } from 'node:fs';
import { mkdir, open, rename, rm, stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { EJSON } from '../qbreader-source/node_modules/bson/lib/bson.node.mjs';

const COLLECTIONS = ['sets', 'packets', 'tossups', 'bonuses'];

function decode (value) {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(decode);
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') {
    if (value._bsontype === 'ObjectId') return value.toHexString();
    if (value._bsontype === 'Long') return value.toNumber();
    if (value._bsontype === 'Decimal128') return value.toString();
    if (value._bsontype === 'Double' || value._bsontype === 'Int32') return value.value;
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, decode(item)]));
  }
  return value;
}

async function * documents (filename) {
  const lines = createInterface({ input: createReadStream(filename, { encoding: 'utf8' }), crlfDelay: Infinity });
  let lineNumber = 0;
  for await (const line of lines) {
    lineNumber++;
    if (!line.trim()) continue;
    let doc;
    try { doc = decode(EJSON.parse(line)); } catch (error) {
      throw new Error(`Invalid JSON in ${path.basename(filename)} at line ${lineNumber}: ${error.message}`);
    }
    if (!doc || typeof doc !== 'object' || Array.isArray(doc) || typeof doc._id !== 'string') {
      throw new Error(`Unexpected document in ${path.basename(filename)} at line ${lineNumber}.`);
    }
    yield doc;
  }
}

async function countJson (filename, onProgress = () => {}) {
  let count = 0;
  for await (const _doc of documents(filename)) {
    count++;
    if (count % 10000 === 0) onProgress(`${path.basename(filename)}: checked ${count.toLocaleString()} records`);
  }
  return count;
}

async function countBson (filename, onProgress = () => {}) {
  const file = await open(filename, 'r');
  const { size } = await file.stat();
  let offset = 0;
  let count = 0;
  let lastProgressAt = 0;
  const header = Buffer.alloc(4);
  try {
    while (offset < size) {
      const { bytesRead } = await file.read(header, 0, 4, offset);
      if (bytesRead !== 4) throw new Error(`Truncated BSON length in ${path.basename(filename)}.`);
      const length = header.readInt32LE(0);
      if (length < 5 || offset + length > size) throw new Error(`Invalid BSON document in ${path.basename(filename)}.`);
      offset += length;
      count++;
      if (offset - lastProgressAt >= 32 * 1024 * 1024) {
        lastProgressAt = offset;
        onProgress(`${path.basename(filename)}: checked ${Math.round((offset / Math.max(size, 1)) * 100)}%`);
      }
    }
  } finally { await file.close(); }
  return count;
}

function createSchema (db) {
  db.exec(`
    CREATE TABLE sets (id TEXT PRIMARY KEY, name TEXT NOT NULL, year INTEGER, difficulty INTEGER, standard INTEGER NOT NULL DEFAULT 0, doc_json TEXT NOT NULL);
    CREATE TABLE packets (id TEXT PRIMARY KEY, name TEXT NOT NULL, set_id TEXT, set_name TEXT NOT NULL, number INTEGER NOT NULL, doc_json TEXT NOT NULL);
    CREATE TABLE tossups (id TEXT PRIMARY KEY, packet_id TEXT, set_id TEXT, set_name TEXT NOT NULL, packet_number INTEGER NOT NULL, number INTEGER NOT NULL, set_year INTEGER, difficulty INTEGER, category TEXT, subcategory TEXT, alternate_subcategory TEXT, standard INTEGER NOT NULL DEFAULT 0, question_sanitized TEXT NOT NULL, answer_sanitized TEXT NOT NULL, doc_json TEXT NOT NULL);
    CREATE TABLE bonuses (id TEXT PRIMARY KEY, packet_id TEXT, set_id TEXT, set_name TEXT NOT NULL, packet_number INTEGER NOT NULL, number INTEGER NOT NULL, set_year INTEGER, difficulty INTEGER, category TEXT, subcategory TEXT, alternate_subcategory TEXT, standard INTEGER NOT NULL DEFAULT 0, leadin_sanitized TEXT NOT NULL, parts_sanitized_json TEXT NOT NULL, answers_sanitized_json TEXT NOT NULL, part_count INTEGER NOT NULL, doc_json TEXT NOT NULL);
    CREATE VIRTUAL TABLE question_search USING fts5(question_id UNINDEXED, field UNINDEXED, value, tokenize='trigram');
  `);
}

function json (value) { return JSON.stringify(value ?? null); }

function insertStatements (db) {
  return {
    sets: db.prepare('INSERT INTO sets VALUES (?, ?, ?, ?, ?, ?)'),
    packets: db.prepare('INSERT INTO packets VALUES (?, ?, ?, ?, ?, ?)'),
    tossups: db.prepare('INSERT INTO tossups VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'),
    bonuses: db.prepare('INSERT INTO bonuses VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'),
    search: db.prepare('INSERT INTO question_search (question_id, field, value) VALUES (?, ?, ?)')
  };
}

function addQuestion (statements, collection, doc) {
  const packet = doc.packet || {};
  const questionSet = doc.set || {};
  const common = [doc._id, packet._id ?? null, questionSet._id ?? null, questionSet.name || '', packet.number ?? 0, doc.number ?? 0, questionSet.year ?? null, doc.difficulty ?? null, doc.category ?? null, doc.subcategory ?? null, doc.alternate_subcategory ?? null, questionSet.standard ? 1 : 0];
  if (collection === 'tossups') {
    statements.tossups.run(...common, doc.question_sanitized || '', doc.answer_sanitized || '', json(doc));
    statements.search.run(doc._id, 'question', doc.question_sanitized || '');
    statements.search.run(doc._id, 'answer', doc.answer_sanitized || '');
  } else {
    const parts = doc.parts_sanitized || [];
    const answers = doc.answers_sanitized || [];
    statements.bonuses.run(...common, doc.leadin_sanitized || '', json(parts), json(answers), parts.length, json(doc));
    statements.search.run(doc._id, 'question', doc.leadin_sanitized || '');
    for (const text of parts) statements.search.run(doc._id, 'question', text);
    for (const text of answers) statements.search.run(doc._id, 'answer', text);
  }
}

export async function validateBackupFolder (folder) {
  const backup = path.resolve(folder);
  if (!existsSync(backup) || !(await stat(backup)).isDirectory()) throw new Error('Choose the extracted QBReader backup folder.');
  for (const name of ['prelude.json', ...COLLECTIONS.flatMap(collection => [`${collection}.json`, `${collection}.bson`, `${collection}.metadata.json`])]) {
    if (!existsSync(path.join(backup, name))) throw new Error(`This folder is missing ${name}. Choose the complete extracted backup folder and keep its files together.`);
  }
  return backup;
}

export async function importBackup (folder, outputPath, onProgress = () => {}) {
  const backup = await validateBackupFolder(folder);
  const output = path.resolve(outputPath);
  const staging = `${output}.importing`;
  // A crash may leave an incomplete staging file. It has no value and is safe
  // to discard before starting a fresh conversion.
  await rm(staging, { force: true });
  onProgress('Checking the backup files…');
  const verifiedCounts = {};
  for (const collection of COLLECTIONS) {
    onProgress(`Checking ${collection}.json…`);
    const jsonCount = await countJson(path.join(backup, `${collection}.json`), onProgress);
    onProgress(`Checking ${collection}.bson…`);
    const bsonCount = await countBson(path.join(backup, `${collection}.bson`), onProgress);
    if (jsonCount !== bsonCount) throw new Error(`${collection} count mismatch: the JSON and BSON files contain different numbers of records.`);
    verifiedCounts[collection] = jsonCount;
    onProgress(`Verified ${collection}: ${jsonCount.toLocaleString()} records`);
  }

  await mkdir(path.dirname(output), { recursive: true });
  const db = new DatabaseSync(staging);
  try {
    db.exec('PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; PRAGMA temp_store=MEMORY;');
    createSchema(db);
    const statements = insertStatements(db);
    db.exec('BEGIN');
    for (const collection of ['sets', 'packets']) {
      onProgress(`Importing ${collection}…`);
      let imported = 0;
      for await (const doc of documents(path.join(backup, `${collection}.json`))) {
        if (collection === 'sets') {
          statements.sets.run(doc._id, doc.name || '', doc.year ?? null, doc.difficulty ?? null, doc.standard ? 1 : 0, json(doc));
        } else {
          const questionSet = doc.set || {};
          statements.packets.run(doc._id, doc.name || '', questionSet._id ?? null, questionSet.name || '', doc.number ?? 0, json(doc));
        }
        imported++;
        if (imported % 10000 === 0) onProgress(`Importing ${collection}: ${imported.toLocaleString()} of ${verifiedCounts[collection].toLocaleString()}`);
      }
      onProgress(`Imported ${collection}: ${imported.toLocaleString()} records`);
    }
    for (const collection of ['tossups', 'bonuses']) {
      onProgress(`Importing ${collection}…`);
      let imported = 0;
      for await (const doc of documents(path.join(backup, `${collection}.json`))) {
        addQuestion(statements, collection, doc);
        imported++;
        if (imported % 10000 === 0) onProgress(`Importing ${collection}: ${imported.toLocaleString()} of ${verifiedCounts[collection].toLocaleString()}`);
      }
      onProgress(`Imported ${collection}: ${imported.toLocaleString()} records`);
    }
    db.exec('COMMIT');
    const indexes = [
      ['sets', 'CREATE UNIQUE INDEX sets_year_name ON sets(year DESC, name ASC)'],
      ['packets', 'CREATE INDEX packets_set_id ON packets(set_id)'],
      ['packets', 'CREATE UNIQUE INDEX packets_set_name_number ON packets(set_name, number)'],
      ['tossup search', 'CREATE INDEX tossups_search_filters ON tossups(difficulty, category, subcategory, alternate_subcategory, set_year)'],
      ['tossup order', 'CREATE UNIQUE INDEX tossups_packet_number ON tossups(packet_id, number)'],
      ['tossup order', 'CREATE INDEX tossups_play_order ON tossups(set_name COLLATE BINARY DESC, packet_number, number)'],
      ['bonus search', 'CREATE INDEX bonuses_search_filters ON bonuses(difficulty, category, subcategory, alternate_subcategory, set_year)'],
      ['bonus order', 'CREATE UNIQUE INDEX bonuses_packet_number ON bonuses(packet_id, number)'],
      ['bonus order', 'CREATE INDEX bonuses_play_order ON bonuses(set_name COLLATE BINARY DESC, packet_number, number)']
    ];
    for (let index = 0; index < indexes.length; index++) {
      onProgress(`Building ${indexes[index][0]} index (${index + 1} of ${indexes.length})…`);
      db.exec(indexes[index][1]);
    }
    onProgress('Analyzing database…');
    db.exec('ANALYZE');
    const counts = Object.fromEntries(COLLECTIONS.map(collection => [collection, db.prepare(`SELECT count(*) AS n FROM ${collection}`).get().n]));
    db.close();
    await rm(output, { force: true });
    await rename(staging, output);
    onProgress('Database is ready.');
    return { output, counts };
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch {}
    try { db.close(); } catch {}
    await rm(staging, { force: true });
    throw error;
  }
}
