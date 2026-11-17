import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { DEFAULT_MIN_YEAR, DEFAULT_MAX_YEAR } from '../qbreader-source/shared/constants.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = path.resolve(process.env.QB_READER_DATA_DIR || ROOT);
const QUESTIONS_DB_PATH = path.join(DATA_DIR, 'questions.sqlite');
const PERSONAL_DB_PATH = path.join(DATA_DIR, 'personal.sqlite');

const db = new DatabaseSync(QUESTIONS_DB_PATH, { readOnly: true });
const personal = new DatabaseSync(PERSONAL_DB_PATH);
db.function('regexp', (pattern, value) => {
  try { return new RegExp(pattern).test(value ?? '') ? 1 : 0; } catch { return 0; }
});
db.function('regexp_flags', (pattern, flags, value) => {
  try { return new RegExp(pattern, flags).test(value ?? '') ? 1 : 0; } catch { return 0; }
});
personal.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value_json TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS stars (
    question_type TEXT NOT NULL CHECK (question_type IN ('tossup', 'bonus')),
    question_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (question_type, question_id)
  );
  CREATE TABLE IF NOT EXISTS imported_packets (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    source_filename TEXT,
    imported_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    doc_json TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS stats_practice_packets (
    id TEXT PRIMARY KEY,
    doc_json TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS history_sessions (
    id TEXT PRIMARY KEY,
    started_at TEXT NOT NULL,
    completed_at TEXT,
    mode TEXT NOT NULL,
    correct_count INTEGER NOT NULL DEFAULT 0,
    question_count INTEGER NOT NULL DEFAULT 0,
    total_points REAL NOT NULL DEFAULT 0,
    category_summary_json TEXT NOT NULL DEFAULT '{}'
  );
  CREATE TABLE IF NOT EXISTS history_questions (
    session_id TEXT NOT NULL REFERENCES history_sessions(id) ON DELETE CASCADE,
    ordinal INTEGER NOT NULL,
    question_type TEXT NOT NULL,
    question_id TEXT,
    set_name TEXT,
    category TEXT,
    subcategory TEXT,
    outcome TEXT,
    buzz_position REAL,
    celerity REAL,
    bonus_part_results_json TEXT,
    played_at TEXT NOT NULL,
    question_snapshot_json TEXT,
    points INTEGER,
    possible_points INTEGER,
    result_class TEXT,
    difficulty INTEGER,
    bonus_part_possible_json TEXT,
    PRIMARY KEY (session_id, ordinal)
  );
  CREATE INDEX IF NOT EXISTS history_questions_category ON history_questions(category, subcategory);
  CREATE INDEX IF NOT EXISTS history_sessions_started_at ON history_sessions(started_at DESC);
  CREATE TABLE IF NOT EXISTS qbreader_stats_imports (
    file_hash TEXT PRIMARY KEY,
    source_filename TEXT NOT NULL,
    session_id TEXT REFERENCES history_sessions(id),
    imported_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    row_count INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS qbreader_stats_rows (
    row_hash TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES history_sessions(id),
    ordinal INTEGER NOT NULL
  );
`);

const sessionColumns = new Set(personal.prepare('PRAGMA table_info(history_sessions)').all().map(column => column.name));
if (!sessionColumns.has('total_points')) { personal.exec('ALTER TABLE history_sessions ADD COLUMN total_points REAL NOT NULL DEFAULT 0'); }
const historyColumns = new Set(personal.prepare('PRAGMA table_info(history_questions)').all().map(column => column.name));
if (!historyColumns.has('points')) { personal.exec('ALTER TABLE history_questions ADD COLUMN points INTEGER'); }
if (!historyColumns.has('possible_points')) { personal.exec('ALTER TABLE history_questions ADD COLUMN possible_points INTEGER'); }
if (!historyColumns.has('celerity')) { personal.exec('ALTER TABLE history_questions ADD COLUMN celerity REAL'); }
if (!historyColumns.has('result_class')) { personal.exec('ALTER TABLE history_questions ADD COLUMN result_class TEXT'); }
if (!historyColumns.has('difficulty')) { personal.exec('ALTER TABLE history_questions ADD COLUMN difficulty INTEGER'); }
if (!historyColumns.has('bonus_part_possible_json')) { personal.exec('ALTER TABLE history_questions ADD COLUMN bonus_part_possible_json TEXT'); }
personal.exec(`
  UPDATE history_questions
  SET difficulty = coalesce(
    CAST(json_extract(question_snapshot_json, '$.difficulty') AS INTEGER),
    CAST(json_extract(question_snapshot_json, '$.set.difficulty') AS INTEGER)
  )
  WHERE difficulty IS NULL AND json_valid(question_snapshot_json);
`);

db.exec(`
  CREATE TEMP TABLE IF NOT EXISTS search_candidates (id TEXT PRIMARY KEY);
  CREATE TEMP TABLE IF NOT EXISTS recommendation_seen_ids (
    question_type TEXT NOT NULL,
    id TEXT NOT NULL,
    PRIMARY KEY (question_type, id)
  );
`);

const rows = {
  tossup: db.prepare('SELECT doc_json FROM tossups WHERE id = ?'),
  bonus: db.prepare('SELECT doc_json FROM bonuses WHERE id = ?'),
  tossupBySetPacket: db.prepare('SELECT doc_json FROM tossups WHERE set_name = ? AND packet_number = ? ORDER BY number'),
  bonusBySetPacket: db.prepare('SELECT doc_json FROM bonuses WHERE set_name = ? AND packet_number = ? ORDER BY number'),
  packet: db.prepare('SELECT doc_json FROM packets WHERE id = ?'),
  tossupByPacketId: db.prepare('SELECT doc_json FROM tossups WHERE packet_id = ? ORDER BY number'),
  bonusByPacketId: db.prepare('SELECT doc_json FROM bonuses WHERE packet_id = ? ORDER BY number')
};

function parseList (value) {
  if (Array.isArray(value)) { return value.flatMap(item => String(item).split(',')).filter(Boolean); }
  if (value === undefined || value === null || value === '') { return []; }
  return String(value).split(',').map(item => item.trim()).filter(Boolean);
}

function asNumbers (value) {
  return parseList(value).map(Number).filter(Number.isFinite);
}

function asBoolean (value) {
  return value === true || value === 'true' || value === '1';
}

function documentFromRow (row) {
  if (!row) { return null; }
  const document = JSON.parse(row.doc_json);
  delete document.reports;
  return document;
}

function documentsFromRows (foundRows) {
  return foundRows.map(documentFromRow);
}

function metadataFilter (options = {}, alias = '') {
  const where = [];
  const params = [];
  const column = name => alias ? `${alias}.${name}` : name;
  const difficulties = asNumbers(options.difficulties);
  const categories = parseList(options.categories ?? options.category);
  const subcategories = parseList(options.subcategories ?? options.subcategory);
  const alternateSubcategories = parseList(options.alternateSubcategories ?? options.alternate_subcategories ?? options.alternateSubcategory);
  const minYear = Number(options.minYear || DEFAULT_MIN_YEAR);
  const maxYear = Number(options.maxYear || DEFAULT_MAX_YEAR);
  const setIds = parseList(options.setIds ?? options.set_id);
  const setName = options.setName ?? options.set_name;

  if (Number.isFinite(minYear)) { where.push(`${column('set_year')} >= ?`); params.push(minYear); }
  if (Number.isFinite(maxYear)) { where.push(`${column('set_year')} <= ?`); params.push(maxYear); }
  if (difficulties.length) {
    where.push(`${column('difficulty')} IN (${difficulties.map(() => '?').join(',')})`);
    params.push(...difficulties);
  }
  if (categories.length) {
    where.push(`${column('category')} IN (${categories.map(() => '?').join(',')})`);
    params.push(...categories);
  }
  if (subcategories.length) {
    where.push(`${column('subcategory')} IN (${subcategories.map(() => '?').join(',')})`);
    params.push(...subcategories);
  }
  if (alternateSubcategories.length) {
    where.push(`(${column('alternate_subcategory')} IN (${alternateSubcategories.map(() => '?').join(',')}) OR ${column('alternate_subcategory')} IS NULL)`);
    params.push(...alternateSubcategories);
  }
  if (setIds.length) {
    where.push(`${column('set_id')} IN (${setIds.map(() => '?').join(',')})`);
    params.push(...setIds);
  }
  if (setName) {
    const names = parseList(setName);
    if (names.length) {
      where.push(`(${names.map(() => `regexp_flags(?, 'i', ${column('set_name')}) = 1`).join(' OR ')})`);
      params.push(...names.map(name => options.regex ? name : escapeRegExp(name)));
    }
  }
  if (asBoolean(options.standardOnly)) { where.push(`${column('standard')} = 1`); }
  if (asBoolean(options.powermarkOnly)) {
    // QBReader's random tossup path searches the question text for the power marker.
    where.push(`regexp(?, ${column('question_sanitized')}) = 1`);
    params.push('\\(\\*\\)');
  }
  return { where, params };
}

function sqlForMetadata (options, alias = '', extraWhere = [], extraParams = []) {
  const { where, params } = metadataFilter(options, alias);
  const conditions = [...where, ...extraWhere];
  return {
    clause: conditions.length ? `WHERE ${conditions.join(' AND ')}` : '',
    params: params.concat(extraParams)
  };
}

function escapeRegExp (value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function unformatString (value) {
  return value.normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[\u2010-\u2015]/g, '-')
    .replace(/[\u2018-\u201B]/g, "'")
    .replace(/[\u201C-\u201F]/g, '"')
    .replace(/[\u2026]/g, '...')
    .replace(/[\u2032-\u2037]/g, "'")
    .replace(/[\u00B7\u22C5\u2027]/g, '')
    .replace(/\u0142/g, 'l')
    .replace(/\u00F8/g, 'o');
}

function buildSearchPatterns (options) {
  let query = String(options.queryString ?? '').trim();
  const regex = asBoolean(options.regex);
  const caseSensitive = asBoolean(options.caseSensitive);
  const exactPhrase = !regex && asBoolean(options.exactPhrase);
  const ignoreWordOrder = !regex && asBoolean(options.ignoreWordOrder);
  if (!regex) { query = escapeRegExp(unformatString(query)); }
  const words = ignoreWordOrder ? query.split(' ').filter(Boolean) : [query];
  const patterns = (exactPhrase ? words.map(word => `\\b${word}\\b`) : words).map(word => {
    const source = options.searchType === 'exactAnswer'
      ? `^\\s*${word}\\s*(\\[.*|\\(.*)?$`
      : word;
    return new RegExp(source, caseSensitive ? '' : 'i');
  });
  return { query: unformatString(String(options.queryString ?? '').trim()), patterns, regex };
}

function searchFields (searchType) {
  if (searchType === 'question') { return ['question']; }
  if (searchType === 'answer' || searchType === 'exactAnswer') { return ['answer']; }
  return ['question', 'answer'];
}

function addFtsCandidates (words, fields) {
  const tempDb = db;
  tempDb.exec('CREATE TEMP TABLE IF NOT EXISTS fts_candidates (id TEXT PRIMARY KEY)');
  tempDb.exec('DELETE FROM fts_candidates');
  let candidateIds = null;
  for (const word of words) {
    const ftsPhrase = word.replaceAll('"', '""');
    if ([...ftsPhrase].length < 3) { continue; }
    const found = new Set(tempDb.prepare(`
      SELECT DISTINCT question_id FROM question_search
      WHERE value MATCH ? AND field IN (${fields.map(() => '?').join(',')})
    `).all(`"${ftsPhrase}"`, ...fields).map(row => row.question_id));
    candidateIds = candidateIds === null
      ? found
      : new Set([...candidateIds].filter(id => found.has(id)));
    if (candidateIds.size === 0) { break; }
  }
  if (candidateIds !== null) {
    const insert = tempDb.prepare('INSERT INTO fts_candidates (id) VALUES (?)');
    tempDb.exec('BEGIN');
    try {
      for (const id of candidateIds) { insert.run(id); }
      tempDb.exec('COMMIT');
    } catch (error) {
      tempDb.exec('ROLLBACK');
      throw error;
    }
  }
  return candidateIds !== null;
}

function searchConditions (patterns, fields, questionType) {
  const clauses = [];
  const params = [];
  for (const pattern of patterns) {
    const checks = [];
    const addTextCheck = expression => {
      checks.push(`regexp_flags(?, ?, ${expression}) = 1`);
      params.push(pattern.source, pattern.flags);
    };
    if (questionType === 'tossup') {
      if (fields.includes('question')) { addTextCheck('q.question_sanitized'); }
      if (fields.includes('answer')) { addTextCheck('q.answer_sanitized'); }
    } else {
      if (fields.includes('question')) {
        addTextCheck('q.leadin_sanitized');
        checks.push('EXISTS (SELECT 1 FROM json_each(q.parts_sanitized_json) p WHERE regexp_flags(?, ?, p.value) = 1)');
        params.push(pattern.source, pattern.flags);
      }
      if (fields.includes('answer')) {
        checks.push('EXISTS (SELECT 1 FROM json_each(q.answers_sanitized_json) a WHERE regexp_flags(?, ?, a.value) = 1)');
        params.push(pattern.source, pattern.flags);
      }
    }
    clauses.push(`(${checks.join(' OR ')})`);
  }
  return { clauses, params };
}

export function getById (questionType, id) {
  return documentFromRow((questionType === 'bonus' ? rows.bonus : rows.tossup).get(id));
}

export function getPacket (setName, packetNumber) {
  return {
    tossups: documentsFromRows(rows.tossupBySetPacket.all(setName, Number(packetNumber))),
    bonuses: documentsFromRows(rows.bonusBySetPacket.all(setName, Number(packetNumber)))
  };
}

export function getPacketById (packetId) {
  const row = rows.packet.get(packetId);
  if (!row) { return null; }
  return {
    packet: JSON.parse(row.doc_json),
    tossups: documentsFromRows(rows.tossupByPacketId.all(packetId)),
    bonuses: documentsFromRows(rows.bonusByPacketId.all(packetId))
  };
}

export function getFrequencyList (options = {}) {
  if (!options.category && !options.subcategory && !options.alternateSubcategory) { return []; }
  const questionType = options.questionType ?? 'all';
  const types = questionType === 'all' ? ['tossup', 'bonus'] : [questionType];
  const values = new Map();
  for (const type of types) {
    const table = type === 'tossup' ? 'tossups' : 'bonuses';
    const { where, params } = metadataFilter(options, 'q');
    if (options.category) { where.push('q.category = ?'); params.push(options.category); }
    if (options.subcategory) { where.push('q.subcategory = ?'); params.push(options.subcategory); }
    if (options.alternateSubcategory) { where.push('q.alternate_subcategory = ?'); params.push(options.alternateSubcategory); }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const rows = db.prepare(type === 'tossup'
      ? `SELECT q.answer_sanitized AS answer FROM ${table} q ${clause}`
      : `SELECT a.value AS answer FROM ${table} q, json_each(q.answers_sanitized_json) a ${clause}`
    ).all(...params);
    for (const row of rows) {
      const answer = String(row.answer ?? '').split(/[[(]/, 1)[0].replace(/\s+/g, ' ').trim();
      const normalized = answer.replaceAll('-', ' ').toLowerCase();
      if (!normalized) { continue; }
      const existing = values.get(normalized);
      if (existing) { existing.count++; } else { values.set(normalized, { answer, count: 1 }); }
    }
  }
  return [...values.values()]
    .sort((a, b) => b.count - a.count || a.answer.localeCompare(b.answer))
    .slice(0, Math.max(1, Math.min(500, Number(options.limit) || 50)));
}

export function getRandomQuestions (questionType, options = {}) {
  const table = questionType === 'bonus' ? 'bonuses' : 'tossups';
  const extraWhere = questionType === 'bonus' && asBoolean(options.threePartBonuses) ? ['part_count = 3'] : [];
  const { clause, params } = sqlForMetadata(options, '', extraWhere);
  if (questionType === 'bonus' && options.bonusLength) {
    const length = Number.parseInt(options.bonusLength, 10);
    if (Number.isFinite(length) && length > 0) {
      return documentsFromRows(db.prepare(`SELECT doc_json FROM bonuses ${clause}${clause ? ' AND' : ' WHERE'} part_count = ? ORDER BY random() LIMIT ?`)
        .all(...params, length, Math.max(1, Number(options.number) || 1)));
    }
  }
  return documentsFromRows(db.prepare(`SELECT doc_json FROM ${table} ${clause} ORDER BY random() LIMIT ?`)
    .all(...params, Math.max(1, Math.min(100, Number(options.number) || 1))));
}

export function queryQuestions (options = {}) {
  const queryString = String(options.queryString ?? '').trim();
  const searchType = options.searchType ?? 'all';
  const questionType = options.questionType ?? 'all';
  const { query, patterns, regex } = buildSearchPatterns(options);
  const normalized = regex ? queryString : unformatString(queryString);
  const words = asBoolean(options.ignoreWordOrder) && !regex
    ? normalized.split(' ').filter(Boolean)
    : normalized ? [normalized] : [];
  const fields = searchFields(searchType);
  const useCandidates = Boolean(query && !regex && addFtsCandidates(words, fields));
  const pageSize = Math.max(1, Number.parseInt(options.maxReturnLength, 10) || 20);

  const runType = type => {
    if (type === 'bonus' && asBoolean(options.powermarkOnly)) { return { count: 0, questionArray: [] }; }
    const table = type === 'bonus' ? 'bonuses' : 'tossups';
    const search = searchConditions(patterns, fields, type);
    const candidateWhere = [];
    if (useCandidates) { candidateWhere.push('id IN (SELECT id FROM fts_candidates)'); }
    const { clause, params } = sqlForMetadata(options, 'q', [...candidateWhere, ...search.clauses], search.params);
    const pagination = Math.max(1, Number(options[`${type}Pagination`]) || 1);
    const count = db.prepare(`SELECT count(*) AS count FROM ${table} q ${clause}`).get(...params).count;
    const offset = (pagination - 1) * pageSize;
    const order = asBoolean(options.randomize)
      ? 'ORDER BY random()'
      : 'ORDER BY q.set_name COLLATE BINARY DESC, q.packet_number ASC, q.number ASC';
    const questionArray = db.prepare(`SELECT q.doc_json FROM ${table} q ${clause} ${order} LIMIT ? OFFSET ?`)
      .all(...params, pageSize, offset).map(documentFromRow);
    return {
      count,
      questionArray
    };
  };

  const tossups = questionType === 'bonus'
    ? { count: 0, questionArray: [] }
    : runType('tossup');
  const bonuses = questionType === 'tossup'
    ? { count: 0, questionArray: [] }
    : runType('bonus');
  return { tossups, bonuses, queryString: query };
}

export function listSetNames () {
  return db.prepare('SELECT name FROM sets ORDER BY year DESC, name COLLATE BINARY ASC').all().map(row => row.name);
}

export function listSets ({ includeCounts = false, limit = 10000 } = {}) {
  const sets = db.prepare('SELECT id AS _id, name AS setName, year, difficulty, standard FROM sets ORDER BY year DESC, name COLLATE BINARY ASC LIMIT ?').all(limit);
  if (!includeCounts) { return sets.map(set => ({ ...set, standard: Boolean(set.standard) })); }
  const count = type => db.prepare(`SELECT set_id, count(*) AS count FROM ${type} GROUP BY set_id`)
    .all().reduce((map, row) => map.set(row.set_id, row.count), new Map());
  const tossups = count('tossups');
  const bonuses = count('bonuses');
  const packets = count('packets');
  return sets.map(set => ({
    _id: set._id,
    setName: set.setName,
    year: set.year,
    difficulty: set.difficulty,
    standard: Boolean(set.standard),
    tossupsCount: tossups.get(set._id) ?? 0,
    bonusesCount: bonuses.get(set._id) ?? 0,
    packetsCount: packets.get(set._id) ?? 0
  }));
}

export function listPackets (setName) {
  return db.prepare('SELECT number, name FROM packets WHERE set_name = ? ORDER BY number').all(setName);
}

export function countPackets (setName) {
  return db.prepare('SELECT count(*) AS count FROM packets WHERE set_name = ?').get(setName)?.count ?? 0;
}

export function listPacketMetadata (setId) {
  return db.prepare(`
    SELECT p.id AS _id, p.name AS packetName, p.number AS packetNumber, p.set_name AS setName,
      (SELECT count(*) FROM tossups t WHERE t.packet_id = p.id) AS tossupCount,
      (SELECT count(*) FROM bonuses b WHERE b.packet_id = p.id) AS bonusCount
    FROM packets p WHERE p.set_id = ? ORDER BY p.number
  `).all(setId);
}

export function saveSetting (key, value) {
  personal.prepare('INSERT INTO settings (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json')
    .run(key, JSON.stringify(value));
}

export function loadSettings () {
  return personal.prepare('SELECT key, value_json FROM settings ORDER BY key').all()
    .reduce((settings, row) => ({ ...settings, [row.key]: JSON.parse(row.value_json) }), {});
}

export function setStar (questionType, questionId, starred) {
  if (starred) {
    personal.prepare('INSERT OR IGNORE INTO stars(question_type, question_id) VALUES (?, ?)').run(questionType, questionId);
  } else {
    personal.prepare('DELETE FROM stars WHERE question_type = ? AND question_id = ?').run(questionType, questionId);
  }
  return personal.prepare('SELECT 1 AS starred FROM stars WHERE question_type = ? AND question_id = ?').get(questionType, questionId) !== undefined;
}

export function isStarred (questionType, questionId) {
  return personal.prepare('SELECT 1 AS starred FROM stars WHERE question_type = ? AND question_id = ?').get(questionType, questionId) !== undefined;
}

export function getStarredIds (questionType) {
  return personal.prepare('SELECT question_id FROM stars WHERE question_type = ? ORDER BY created_at, question_id').all(questionType).map(row => row.question_id);
}

export function getStarredQuestions (questionType) {
  const ids = getStarredIds(questionType);
  const get = questionType === 'bonus' ? rows.bonus : rows.tossup;
  return ids.map(id => documentFromRow(get.get(id))).filter(Boolean);
}

export function clearStars (questionType) {
  return personal.prepare('DELETE FROM stars WHERE question_type = ?').run(questionType).changes;
}

export function createStarredPracticePacket (questionType, ids) {
  const starred = new Set(getStarredIds(questionType));
  const get = questionType === 'bonus' ? rows.bonus : rows.tossup;
  const selected = [...new Set(ids)].filter(id => starred.has(id)).map(id => documentFromRow(get.get(id))).filter(Boolean);
  if (!selected.length) { return null; }
  const packet = { id: `stars-${randomUUID()}`, name: 'Starred question practice', tossups: questionType === 'tossup' ? selected : [], bonuses: questionType === 'bonus' ? selected : [] };
  personal.prepare("DELETE FROM stats_practice_packets WHERE created_at < datetime('now', '-1 day')").run();
  personal.prepare('INSERT INTO stats_practice_packets(id, doc_json) VALUES (?, ?)').run(packet.id, JSON.stringify(packet));
  return { id: packet.id };
}

export function saveImportedPacket (packet, sourceFilename = '') {
  const normalized = {
    tossups: Array.isArray(packet.tossups) ? packet.tossups : [],
    bonuses: Array.isArray(packet.bonuses) ? packet.bonuses : []
  };
  const name = String(packet.name || sourceFilename.replace(/\.json$/i, '') || 'Imported packet');
  const id = packet.id || randomUUID();
  personal.prepare(`
    INSERT INTO imported_packets(id, name, source_filename, doc_json)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET name = excluded.name, source_filename = excluded.source_filename,
      imported_at = CURRENT_TIMESTAMP, doc_json = excluded.doc_json
  `).run(id, name, sourceFilename, JSON.stringify(normalized));
  return { id, name, tossupCount: normalized.tossups.length, bonusCount: normalized.bonuses.length };
}

export function listImportedPackets () {
  return personal.prepare('SELECT id, name, source_filename AS sourceFilename, imported_at AS importedAt, doc_json FROM imported_packets ORDER BY imported_at DESC, name')
    .all().map(row => {
      const packet = JSON.parse(row.doc_json);
      return {
        id: row.id,
        name: row.name,
        sourceFilename: row.sourceFilename,
        importedAt: row.importedAt,
        tossupCount: packet.tossups.length,
        bonusCount: packet.bonuses.length
      };
    });
}

export function getImportedPacket (id) {
  const row = personal.prepare('SELECT id, name, doc_json FROM imported_packets WHERE id = ?').get(id);
  if (!row) { return null; }
  return { id: row.id, name: row.name, ...JSON.parse(row.doc_json) };
}

export function createStatsPracticePacket (filters = {}, { neggedOnly = false } = {}) {
  personal.prepare("DELETE FROM stats_practice_packets WHERE created_at < datetime('now', '-1 day')").run();
  const conditions = [];
  const params = [];
  if (filters.from) { conditions.push('date(h.played_at) >= date(?)'); params.push(filters.from); }
  if (filters.to) { conditions.push('date(h.played_at) <= date(?)'); params.push(filters.to); }
  if (['tossup', 'bonus'].includes(filters.questionType)) { conditions.push('h.question_type = ?'); params.push(filters.questionType); }
  if (filters.setName) { conditions.push('h.set_name = ?'); params.push(filters.setName); }
  const difficulties = asNumbers(filters.difficulties ?? filters.difficulty);
  if (difficulties.length) { conditions.push(`h.difficulty IN (${difficulties.map(() => '?').join(',')})`); params.push(...difficulties); }
  if (filters.category) { conditions.push('h.category = ?'); params.push(filters.category); }
  if (filters.subcategory) { conditions.push('h.subcategory = ?'); params.push(filters.subcategory); }
  if (filters.mode) { conditions.push('s.mode = ?'); params.push(filters.mode); }
  if (neggedOnly) {
    conditions.push("h.question_type = 'tossup'");
    conditions.push("coalesce(h.result_class, CASE WHEN h.outcome = 'incorrect' THEN 'neg' END) = 'neg'");
  }
  conditions.push('h.question_id IS NOT NULL');
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const matching = personal.prepare(`
    SELECT h.question_type, h.question_id,
      sum(CASE WHEN h.question_type = 'tossup' AND coalesce(h.result_class, CASE WHEN h.outcome = 'incorrect' THEN 'neg' END) = 'neg' THEN 1
        WHEN h.question_type = 'bonus' AND h.possible_points > h.points THEN 1 ELSE 0 END) AS misses,
      count(*) AS attempts, max(h.played_at) AS latest
    FROM history_questions h JOIN history_sessions s ON s.id = h.session_id
    ${where}
    GROUP BY h.question_type, h.question_id
    ORDER BY misses DESC, attempts DESC, latest DESC
  `).all(...params);
  const tossups = [];
  const bonuses = [];
  for (const row of matching) {
    const document = documentFromRow((row.question_type === 'bonus' ? rows.bonus : rows.tossup).get(row.question_id));
    if (document) { (row.question_type === 'bonus' ? bonuses : tossups).push(document); }
  }
  if (!tossups.length && !bonuses.length) { return null; }
  const suffix = neggedOnly ? ' — Negged tossups' : '';
  const name = `${filters.category || 'All categories'}${filters.subcategory ? ` · ${filters.subcategory}` : ''}${suffix}`;
  const packet = { id: `stats-${randomUUID()}`, name: `Stats practice: ${name}`, tossups, bonuses };
  personal.prepare('INSERT INTO stats_practice_packets(id, doc_json) VALUES (?, ?)').run(packet.id, JSON.stringify(packet));
  return { id: packet.id, name: packet.name, tossupCount: tossups.length, bonusCount: bonuses.length };
}

export function getLocalPacket (id) {
  const imported = getImportedPacket(id);
  if (imported) { return imported; }
  const row = personal.prepare('SELECT doc_json FROM stats_practice_packets WHERE id = ?').get(id);
  if (!row) { return null; }
  personal.prepare('DELETE FROM stats_practice_packets WHERE id = ?').run(id);
  return JSON.parse(row.doc_json);
}

export function removeImportedPacket (id) {
  return personal.prepare('DELETE FROM imported_packets WHERE id = ?').run(id).changes;
}

export function startHistorySession (mode) {
  const id = randomUUID();
  personal.prepare('INSERT INTO history_sessions (id, started_at, mode) VALUES (?, ?, ?)')
    .run(id, new Date().toISOString(), mode);
  return id;
}

function finiteNumberOrNull (value) {
  if (value === null || value === undefined || value === '') { return null; }
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function saveHistoryQuestion (sessionId, ordinal, questionType, question, result = {}) {
  const row = question ?? {};
  personal.prepare(`
    INSERT INTO history_questions (
      session_id, ordinal, question_type, question_id, set_name, category, subcategory,
      outcome, buzz_position, celerity, bonus_part_results_json, played_at, question_snapshot_json,
      points, possible_points, result_class, difficulty, bonus_part_possible_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_id, ordinal) DO UPDATE SET
      question_id = excluded.question_id, set_name = excluded.set_name, category = excluded.category,
      subcategory = excluded.subcategory, outcome = excluded.outcome,
      buzz_position = excluded.buzz_position, celerity = excluded.celerity, bonus_part_results_json = excluded.bonus_part_results_json,
      played_at = excluded.played_at, question_snapshot_json = excluded.question_snapshot_json,
      points = excluded.points, possible_points = excluded.possible_points,
      result_class = excluded.result_class, difficulty = excluded.difficulty,
      bonus_part_possible_json = excluded.bonus_part_possible_json
  `).run(
    sessionId,
    ordinal,
    questionType,
    row._id ?? null,
    row.set?.name ?? row.set_name ?? null,
    row.category ?? null,
    row.subcategory ?? null,
    result.outcome ?? null,
    finiteNumberOrNull(result.buzzPosition),
    finiteNumberOrNull(result.celerity),
    result.bonusPartResults ? JSON.stringify(result.bonusPartResults) : null,
    new Date().toISOString(),
    JSON.stringify(row),
    finiteNumberOrNull(result.points),
    finiteNumberOrNull(result.possiblePoints),
    result.resultClass ?? null,
    finiteNumberOrNull(row.difficulty ?? row.set?.difficulty),
    Array.isArray(result.bonusPartPossible) ? JSON.stringify(result.bonusPartPossible) : null
  );
  personal.prepare(`
    UPDATE history_sessions
    SET question_count = (SELECT count(*) FROM history_questions WHERE session_id = ?),
      total_points = (SELECT coalesce(sum(points), 0) FROM history_questions WHERE session_id = ?)
    WHERE id = ?
  `).run(sessionId, sessionId, sessionId);
}

export function importQbReaderTossupStats (records, fileHash, sourceFilename) {
  const existingImport = personal.prepare(`
    SELECT row_count AS rowCount, session_id AS sessionId
    FROM qbreader_stats_imports WHERE file_hash = ?
  `).get(fileHash);
  if (existingImport) { return { imported: 0, skipped: existingImport.rowCount, sessionId: existingImport.sessionId, alreadyImported: true }; }

  const sessionId = `qbreader-${fileHash.slice(0, 32)}`;
  const qSelect = db.prepare('SELECT doc_json FROM tossups WHERE id = ?');
  const setSelect = db.prepare('SELECT name FROM sets WHERE id = ?');
  const knownRows = personal.prepare('SELECT 1 FROM qbreader_stats_rows WHERE row_hash = ?');
  const insertSession = personal.prepare('INSERT OR IGNORE INTO history_sessions (id, started_at, mode) VALUES (?, ?, ?)');
  const insertQuestion = personal.prepare(`
    INSERT INTO history_questions (
      session_id, ordinal, question_type, question_id, set_name, category, subcategory,
      outcome, buzz_position, celerity, bonus_part_results_json, played_at, question_snapshot_json,
      points, possible_points, result_class, difficulty, bonus_part_possible_json
    ) VALUES (?, ?, 'tossup', ?, ?, ?, ?, ?, NULL, ?, NULL, ?, ?, ?, 10, ?, ?, NULL)
  `);
  const insertRowFingerprint = personal.prepare('INSERT INTO qbreader_stats_rows (row_hash, session_id, ordinal) VALUES (?, ?, ?)');

  let imported = 0;
  let skipped = 0;
  let correctCount = 0;
  let totalPoints = 0;
  let earliest = null;
  let latest = null;
  const categories = new Map();
  personal.exec('BEGIN IMMEDIATE');
  try {
    for (let index = 0; index < records.length; index++) {
      const row = records[index];
      const questionId = String(row['tossup._id'] ?? '').trim();
      const created = new Date(row.created);
      const pointValue = Number(row.pointValue);
      const difficulty = finiteNumberOrNull(row.difficulty);
      const celerity = finiteNumberOrNull(row.celerity);
      if (!questionId || !Number.isFinite(created.getTime()) || !Number.isFinite(pointValue)) { skipped++; continue; }

      const createdAt = created.toISOString();
      const category = String(row.category || 'Uncategorized');
      const subcategory = String(row.subcategory || 'Uncategorized');
      const setId = String(row['set._id'] || '');
      const existingQuestion = qSelect.get(questionId);
      const question = existingQuestion ? JSON.parse(existingQuestion.doc_json) : { _id: questionId };
      const set = setSelect.get(setId);
      const setName = set?.name ?? question.set?.name ?? 'Unknown set';
      question._id = questionId;
      question.category = category;
      question.subcategory = subcategory;
      question.alternate_subcategory = row.alternate_subcategory || null;
      question.difficulty = difficulty;
      question.set = { ...(question.set ?? {}), _id: setId, name: setName, difficulty };
      question.qbreaderImport = { multiplayer: row.multiplayer === 'true', source: 'tossup-stats.csv' };

      const outcome = pointValue > 0 ? 'correct' : (pointValue < 0 ? 'incorrect' : 'unanswered');
      const resultClass = pointValue > 10 ? 'power' : (pointValue > 0 ? 'get' : (pointValue < 0 ? 'neg' : 'unanswered'));
      const rowHash = createHash('sha256').update(JSON.stringify([
        row.created, questionId, setId, row.difficulty, category, subcategory,
        row.alternate_subcategory, row.multiplayer, row.celerity, row.pointValue
      ])).digest('hex');
      if (knownRows.get(rowHash)) { skipped++; continue; }

      insertSession.run(sessionId, createdAt, 'QBReader stats import');
      insertQuestion.run(
        sessionId, index + 1, questionId, setName, category, subcategory,
        outcome, celerity, createdAt, JSON.stringify(question), pointValue, resultClass, difficulty
      );
      insertRowFingerprint.run(rowHash, sessionId, index + 1);
      imported++;
      if (pointValue > 0) { correctCount++; }
      totalPoints += pointValue;
      if (!earliest || createdAt < earliest) { earliest = createdAt; }
      if (!latest || createdAt > latest) { latest = createdAt; }
      const categoryStats = categories.get(category) ?? { count: 0, correct: 0, points: 0 };
      categoryStats.count++;
      if (pointValue > 0) { categoryStats.correct++; }
      categoryStats.points += pointValue;
      categories.set(category, categoryStats);
    }

    if (imported) {
      personal.prepare(`
        UPDATE history_sessions
        SET started_at = ?, completed_at = ?, correct_count = ?, question_count = ?,
          total_points = ?, category_summary_json = ?
        WHERE id = ?
      `).run(earliest, latest, correctCount, imported, totalPoints, JSON.stringify(Object.fromEntries(categories)), sessionId);
    }
    personal.prepare(`
      INSERT INTO qbreader_stats_imports (file_hash, source_filename, session_id, row_count)
      VALUES (?, ?, ?, ?)
    `).run(fileHash, path.basename(sourceFilename), imported ? sessionId : null, imported);
    personal.exec('COMMIT');
  } catch (error) {
    personal.exec('ROLLBACK');
    throw error;
  }
  return { imported, skipped, sessionId: imported ? sessionId : null, alreadyImported: false };
}

export function importQbReaderBonusStats (records, fileHash, sourceFilename) {
  const existingImport = personal.prepare(`
    SELECT row_count AS rowCount, session_id AS sessionId
    FROM qbreader_stats_imports WHERE file_hash = ?
  `).get(fileHash);
  if (existingImport) { return { imported: 0, skipped: existingImport.rowCount, sessionId: existingImport.sessionId, alreadyImported: true }; }

  const sessionId = `qbreader-${fileHash.slice(0, 32)}`;
  const qSelect = db.prepare('SELECT doc_json FROM bonuses WHERE id = ?');
  const setSelect = db.prepare('SELECT name FROM sets WHERE id = ?');
  const knownRows = personal.prepare('SELECT 1 FROM qbreader_stats_rows WHERE row_hash = ?');
  const insertSession = personal.prepare('INSERT OR IGNORE INTO history_sessions (id, started_at, mode) VALUES (?, ?, ?)');
  const insertQuestion = personal.prepare(`
    INSERT INTO history_questions (
      session_id, ordinal, question_type, question_id, set_name, category, subcategory,
      outcome, buzz_position, celerity, bonus_part_results_json, played_at, question_snapshot_json,
      points, possible_points, result_class, difficulty, bonus_part_possible_json
    ) VALUES (?, ?, 'bonus', ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, NULL, ?, ?)
  `);
  const insertRowFingerprint = personal.prepare('INSERT INTO qbreader_stats_rows (row_hash, session_id, ordinal) VALUES (?, ?, ?)');
  let imported = 0;
  let skipped = 0;
  let totalPoints = 0;
  let earliest = null;
  let latest = null;
  const categories = new Map();

  personal.exec('BEGIN IMMEDIATE');
  try {
    for (let index = 0; index < records.length; index++) {
      const row = records[index];
      const questionId = String(row['bonus._id'] ?? '').trim();
      const created = new Date(row.created);
      const difficulty = finiteNumberOrNull(row.difficulty);
      if (!questionId || !Number.isFinite(created.getTime())) { skipped++; continue; }

      const createdAt = created.toISOString();
      const category = String(row.category || 'Uncategorized');
      const subcategory = String(row.subcategory || 'Uncategorized');
      const setId = String(row['set._id'] || '');
      const existingQuestion = qSelect.get(questionId);
      const question = existingQuestion ? JSON.parse(existingQuestion.doc_json) : { _id: questionId };
      const set = setSelect.get(setId);
      const setName = set?.name ?? question.set?.name ?? 'Unknown set';
      const rawParts = ['part1', 'part2', 'part3'].map(key => row[key] === '' || row[key] === undefined ? null : Number(row[key]));
      const inferredCount = rawParts.reduce((last, value, index) => value === null ? last : index + 1, 0);
      const sourceValues = Array.isArray(question.values) ? question.values : [];
      const sourceParts = Array.isArray(question.parts) ? question.parts : [];
      const partCount = sourceValues.length || sourceParts.length || inferredCount || 3;
      const possiblePoints = sourceValues.length
        ? sourceValues.slice(0, partCount).map(value => Number(value) || 10)
        : Array.from({ length: partCount }, () => 10);
      const partResults = Array.from({ length: partCount }, (_, part) => Number(rawParts[part]) || 0);
      const questionPoints = partResults.reduce((sum, value) => sum + value, 0);
      const totalPossiblePoints = possiblePoints.reduce((sum, value) => sum + value, 0);
      const outcome = questionPoints >= totalPossiblePoints ? 'complete' : 'partial';

      question._id = questionId;
      question.category = category;
      question.subcategory = subcategory;
      question.alternate_subcategory = row.alternate_subcategory || null;
      question.difficulty = difficulty;
      question.set = { ...(question.set ?? {}), _id: setId, name: setName, difficulty };
      question.qbreaderImport = { multiplayer: row.multiplayer === 'true', source: 'bonus-stats.csv' };
      if (!sourceValues.length) { question.values = possiblePoints; }

      const rowHash = createHash('sha256').update(JSON.stringify([
        'bonus', row.created, questionId, setId, row.difficulty, category, subcategory,
        row.alternate_subcategory, row.multiplayer, row.part1, row.part2, row.part3
      ])).digest('hex');
      if (knownRows.get(rowHash)) { skipped++; continue; }

      insertSession.run(sessionId, createdAt, 'QBReader bonus stats import');
      insertQuestion.run(
        sessionId, index + 1, questionId, setName, category, subcategory, outcome,
        JSON.stringify(partResults), createdAt, JSON.stringify(question), questionPoints,
        totalPossiblePoints, difficulty, JSON.stringify(possiblePoints)
      );
      insertRowFingerprint.run(rowHash, sessionId, index + 1);
      imported++;
      if (!earliest || createdAt < earliest) { earliest = createdAt; }
      if (!latest || createdAt > latest) { latest = createdAt; }
      const categoryStats = categories.get(category) ?? { count: 0, correct: 0, points: 0 };
      categoryStats.count++;
      if (outcome === 'complete') { categoryStats.correct++; }
      categoryStats.points += questionPoints;
      categories.set(category, categoryStats);
      totalPoints += questionPoints;
    }

    if (imported) {
      personal.prepare(`
        UPDATE history_sessions
        SET started_at = ?, completed_at = ?, correct_count = 0, question_count = ?,
          total_points = ?, category_summary_json = ?
        WHERE id = ?
      `).run(earliest, latest, imported, totalPoints, JSON.stringify(Object.fromEntries(categories)), sessionId);
    }
    personal.prepare(`
      INSERT INTO qbreader_stats_imports (file_hash, source_filename, session_id, row_count)
      VALUES (?, ?, ?, ?)
    `).run(fileHash, path.basename(sourceFilename), imported ? sessionId : null, imported);
    personal.exec('COMMIT');
  } catch (error) {
    personal.exec('ROLLBACK');
    throw error;
  }
  return { imported, skipped, sessionId: imported ? sessionId : null, alreadyImported: false };
}

export function finishHistorySession (sessionId, { correctCount = 0 } = {}) {
  const summary = personal.prepare(`
    SELECT category, count(*) AS count,
      sum(CASE WHEN outcome = 'correct' THEN 1 ELSE 0 END) AS correct,
      sum(coalesce(points, 0)) AS points
    FROM history_questions WHERE session_id = ? AND category IS NOT NULL GROUP BY category
  `).all(sessionId).reduce((value, row) => ({
    ...value,
    [row.category]: { count: row.count, correct: row.correct, points: row.points }
  }), {});
  personal.prepare(`
    UPDATE history_sessions SET completed_at = ?, correct_count = ?, question_count = ?, total_points = ?, category_summary_json = ?
    WHERE id = ?
  `).run(
    new Date().toISOString(),
    correctCount,
    personal.prepare('SELECT count(*) AS count FROM history_questions WHERE session_id = ?').get(sessionId).count,
    personal.prepare('SELECT coalesce(sum(points), 0) AS points FROM history_questions WHERE session_id = ?').get(sessionId).points,
    JSON.stringify(summary),
    sessionId
  );
}

export function listHistorySessions (limit = 50) {
  return personal.prepare(`
    SELECT id, started_at AS startedAt, completed_at AS completedAt, mode,
      correct_count AS correctCount, question_count AS questionCount, category_summary_json AS categorySummary
      ,total_points AS totalPoints
    FROM history_sessions
    WHERE EXISTS (SELECT 1 FROM history_questions WHERE session_id = history_sessions.id)
    ORDER BY started_at DESC LIMIT ?
  `).all(Math.max(1, Math.min(200, Number(limit) || 50))).map(row => ({
    ...row,
    categorySummary: JSON.parse(row.categorySummary)
  }));
}

export function getHistorySession (id) {
  const sessionRow = personal.prepare(`
    SELECT id, started_at AS startedAt, completed_at AS completedAt, mode,
      correct_count AS correctCount, question_count AS questionCount,
      total_points AS totalPoints, category_summary_json AS categorySummary
    FROM history_sessions WHERE id = ?
  `).get(id);
  if (!sessionRow) { return null; }
  const session = { ...sessionRow, categorySummary: JSON.parse(sessionRow.categorySummary) };
  const questionsLimited = session.mode.includes('stats import');
  const questionQuery = `
    SELECT ordinal, question_type AS questionType, question_id AS questionId,
      set_name AS setName, category, subcategory, outcome, buzz_position AS buzzPosition,
      bonus_part_results_json AS bonusPartResults, points, possible_points AS possiblePoints, played_at AS playedAt,
      question_snapshot_json AS question, result_class AS resultClass, difficulty,
      bonus_part_possible_json AS bonusPartPossible
    FROM history_questions WHERE session_id = ?
    ORDER BY ${questionsLimited ? 'played_at DESC, ordinal DESC LIMIT 100' : 'ordinal'}
  `;
  const questions = personal.prepare(questionQuery).all(id).map(row => ({
    ...row,
    bonusPartResults: row.bonusPartResults ? JSON.parse(row.bonusPartResults) : [],
    bonusPartPossible: row.bonusPartPossible ? JSON.parse(row.bonusPartPossible) : [],
    question: row.question ? JSON.parse(row.question) : null
  }));
  return { ...session, questions, questionsLimited };
}

function parseJsonArray (value, fallback = []) {
  if (!value) { return fallback; }
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function normalizedHistoryRow (row) {
  const question = row.question_snapshot_json ? JSON.parse(row.question_snapshot_json) : {};
  const bonusPartResults = parseJsonArray(row.bonus_part_results_json);
  const bonusPartPossible = parseJsonArray(row.bonus_part_possible_json,
    Array.isArray(question.values) ? question.values : (question.parts ?? []).map(() => 10));
  const resultClass = row.result_class ?? (row.question_type === 'tossup'
    ? (row.outcome === 'correct' ? (Number(row.points) > 10 ? 'power' : 'get') : (row.outcome === 'incorrect' ? 'neg' : 'unanswered'))
    : null);
  return {
    sessionId: row.session_id,
    mode: row.mode,
    ordinal: row.ordinal,
    questionType: row.question_type,
    questionId: row.question_id,
    setName: row.set_name,
    category: row.category ?? 'Uncategorized',
    subcategory: row.subcategory ?? 'Uncategorized',
    outcome: row.outcome,
    resultClass,
    buzzPosition: row.buzz_position,
    celerity: row.celerity,
    points: row.points === null ? null : Number(row.points),
    possiblePoints: row.possible_points === null ? null : Number(row.possible_points),
    difficulty: row.difficulty === null ? null : Number(row.difficulty),
    bonusPartResults,
    bonusPartPossible,
    playedAt: row.played_at,
    question
  };
}

function blankStats () {
  return {
    attempts: 0,
    points: 0,
    tossupPoints: 0,
    bonusPoints: 0,
    possibleBonusPoints: 0,
    correct: 0,
    powers: 0,
    gets: 0,
    negs: 0,
    unanswered: 0,
    buzzAttempts: 0,
    correctBuzzPositionTotal: 0,
    correctBuzzPositionCount: 0,
    correctCelerityTotal: 0,
    correctCelerityCount: 0,
    bonuses: 0,
    bonusPartPoints: [],
    bonusPartPossible: []
  };
}

function addStat (stats, row) {
  stats.attempts++;
  if (Number.isFinite(row.points)) { stats.points += row.points; }
  if (row.questionType === 'tossup') {
    if (Number.isFinite(row.points)) { stats.tossupPoints += row.points; }
    if (row.outcome === 'correct') { stats.correct++; }
    if (row.resultClass === 'power') { stats.powers++; stats.buzzAttempts++; } else if (row.resultClass === 'get') { stats.gets++; stats.buzzAttempts++; } else if (row.resultClass === 'neg') { stats.negs++; stats.buzzAttempts++; } else { stats.unanswered++; }
    if (row.outcome === 'correct' && Number.isFinite(row.buzzPosition)) {
      stats.correctBuzzPositionTotal += row.buzzPosition;
      stats.correctBuzzPositionCount++;
    }
    if (row.outcome === 'correct' && Number.isFinite(row.celerity)) {
      stats.correctCelerityTotal += 1 - row.celerity;
      stats.correctCelerityCount++;
    }
    return;
  }
  stats.bonuses++;
  if (Number.isFinite(row.points)) { stats.bonusPoints += row.points; }
  row.bonusPartResults.forEach((points, index) => {
    stats.bonusPartPoints[index] = (stats.bonusPartPoints[index] ?? 0) + (Number(points) || 0);
    const possible = Number(row.bonusPartPossible[index]) || 10;
    stats.bonusPartPossible[index] = (stats.bonusPartPossible[index] ?? 0) + possible;
    stats.possibleBonusPoints += possible;
  });
}

function summarizeStats (stats) {
  const {
    bonusPartPoints, bonusPartPossible, correctBuzzPositionTotal, correctBuzzPositionCount,
    correctCelerityTotal, correctCelerityCount, ...rest
  } = stats;
  const tossups = stats.attempts - stats.bonuses;
  return {
    ...rest,
    tossups,
    pointsPerTossup: tossups > 0 ? stats.tossupPoints / tossups : 0,
    powerRate: tossups > 0 ? stats.powers / tossups : 0,
    correctRate: tossups > 0 ? stats.correct / tossups : 0,
    negRate: stats.buzzAttempts > 0 ? stats.negs / stats.buzzAttempts : 0,
    averageCorrectBuzzPosition: correctBuzzPositionCount ? correctBuzzPositionTotal / correctBuzzPositionCount : null,
    averageCorrectBuzzPositionCount: correctBuzzPositionCount,
    averageCorrectClueRead: correctCelerityCount ? correctCelerityTotal / correctCelerityCount : null,
    averageCorrectClueReadCount: correctCelerityCount,
    pointsPerBonus: stats.bonuses > 0 ? stats.bonusPoints / stats.bonuses : 0,
    bonusConversion: stats.possibleBonusPoints > 0 ? stats.bonusPoints / stats.possibleBonusPoints : 0,
    bonusParts: bonusPartPoints.map((points, index) => ({
      part: index + 1,
      points,
      possible: bonusPartPossible[index] ?? 0,
      conversion: bonusPartPossible[index] ? points / bonusPartPossible[index] : 0
    }))
  };
}

function researchAnswers (question, questionType) {
  const rawAnswers = questionType === 'tossup'
    ? [question.answer]
    : (question.answers ?? question.parts?.map(part => part.answer ?? part.answers?.[0]) ?? []);
  return rawAnswers.map(answer => String(answer ?? '')
    .replace(/<[^>]*>/g, '').replace(/\[[^\]]*\]/g, '').replace(/\s+/g, ' ').trim()).filter(Boolean);
}

function answerKeysForQuestion (question, questionType) {
  return researchAnswers(question, questionType).map(answerKey).filter(Boolean);
}

function answerKey (answer) {
  return String(answer ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/<[^>]*>/g, '').replace(/\[[^\]]*\]/g, '').toLowerCase()
    .replace(/\b(or|accept|prompt|do not accept)\b/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();
}

function makeWeakArea (row, type, granularity, summary) {
  const attempts = type === 'tossup' ? row.tossups : row.bonuses;
  if (!attempts) { return null; }
  if (type === 'bonus') {
    const delta = summary.pointsPerBonus - row.pointsPerBonus;
    if (delta <= 0) { return null; }
    return {
      type,
      granularity,
      category: row.category,
      subcategory: row.subcategory,
      attempts,
      tentative: attempts < 10,
      value: row.pointsPerBonus,
      baseline: summary.pointsPerBonus,
      gap: delta,
      score: (delta / 30) * Math.sqrt(attempts / (attempts + 20)),
      metric: 'PPB'
    };
  }
  const pptuGap = (summary.pointsPerTossup - row.pointsPerTossup) / 20;
  const powerGap = summary.powerRate - row.powerRate;
  const negGap = row.negRate - summary.negRate;
  const rawScore = 0.5 * pptuGap + 0.25 * powerGap + 0.25 * negGap;
  if (rawScore <= 0) { return null; }
  return {
    type,
    granularity,
    category: row.category,
    subcategory: row.subcategory,
    attempts,
    tentative: attempts < 10,
    value: row.pointsPerTossup,
    baseline: summary.pointsPerTossup,
    gap: rawScore,
    score: rawScore * Math.sqrt(attempts / (attempts + 20)),
    metric: 'PPTU, power, neg rate',
    powerRate: row.powerRate,
    negRate: row.negRate,
    baselinePowerRate: summary.powerRate,
    baselineNegRate: summary.negRate
  };
}

function matchesWeakArea (row, area) {
  return row.questionType === area.type && row.category === area.category &&
    (!area.subcategory || row.subcategory === area.subcategory);
}

function cleanQuestionExcerpt (question, questionType, partIndex = null) {
  const text = questionType === 'tossup'
    ? question.question
    : partIndex === null
      ? [question.leadin, ...(question.parts ?? [])].filter(Boolean).join(' ')
      : question.parts?.[partIndex];
  return String(text ?? '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 240);
}

function candidateWeakAreas (categories, subcategories, summary) {
  const candidates = [];
  for (const type of ['tossup', 'bonus']) {
    const eligibleSubcategories = subcategories
      .map(row => makeWeakArea(row, type, 'subcategory', summary))
      .filter(Boolean);
    candidates.push(...eligibleSubcategories);
    for (const row of categories) {
      const hasSpecificData = subcategories.some(subcategory => subcategory.category === row.category &&
        (type === 'tossup' ? subcategory.tossups : subcategory.bonuses) >= 10);
      if (!hasSpecificData) {
        const area = makeWeakArea(row, type, 'category', summary);
        if (area) { candidates.push(area); }
      }
    }
  }
  const sort = (a, b) => b.score - a.score || b.attempts - a.attempts;
  return {
    ranked: candidates.filter(area => !area.tentative).sort(sort).slice(0, 6),
    tentative: candidates.filter(area => area.tentative).sort(sort).slice(0, 6)
  };
}

function selectedScopeAreas (filters, categories, subcategories, summary) {
  if (!filters.category && !filters.subcategory) { return []; }
  const allowedTypes = ['tossup', 'bonus'].filter(type => !filters.questionType || filters.questionType === type);
  const result = [];
  for (const type of allowedTypes) {
    const row = filters.subcategory
      ? subcategories.find(candidate => candidate.category === filters.category && candidate.subcategory === filters.subcategory)
      : categories.find(candidate => candidate.category === filters.category);
    if (!row) { continue; }
    const attempts = type === 'tossup' ? row.tossups : row.bonuses;
    if (!attempts) { continue; }
    result.push({
      type,
      granularity: filters.subcategory ? 'subcategory' : 'category',
      category: row.category,
      subcategory: filters.subcategory || undefined,
      attempts,
      tentative: attempts < 10,
      selectedScope: true,
      value: type === 'tossup' ? row.pointsPerTossup : row.pointsPerBonus,
      baseline: type === 'tossup' ? summary.pointsPerTossup : summary.pointsPerBonus,
      metric: type === 'tossup' ? 'PPTU, power, neg rate' : 'PPB',
      powerRate: row.powerRate,
      negRate: row.negRate,
      baselinePowerRate: summary.powerRate,
      baselineNegRate: summary.negRate
    });
  }
  return result;
}

function buildStudyRecommendations (filters, sourceRows, summary, categories, subcategories) {
  const candidates = candidateWeakAreas(categories, subcategories, summary);
  const areas = candidates.ranked;
  const selectedContext = areas.length ? [] : selectedScopeAreas(filters, categories, subcategories, summary);
  const targetAreas = areas.length ? areas.slice(0, 3) : selectedContext;
  const targetRows = sourceRows.filter(row => targetAreas.some(area => matchesWeakArea(row, area)) &&
    (row.questionType === 'tossup'
      ? row.points < 15
      : Number.isFinite(row.points) && Number.isFinite(row.possiblePoints) && row.points < row.possiblePoints));

  const topicsByKey = new Map();
  for (const row of targetRows) {
    const answers = researchAnswers(row.question, row.questionType);
    for (const [partIndex, answer] of answers.entries()) {
      if (row.questionType === 'bonus' && Number(row.bonusPartResults[partIndex]) >= Number(row.bonusPartPossible[partIndex] ?? 10)) { continue; }
      const key = answerKey(answer);
      if (!answer || !key) { continue; }
      if (!topicsByKey.has(key)) {
        topicsByKey.set(key, {
          topic: answer.length > 120 ? `${answer.slice(0, 117)}…` : answer,
          questionType: row.questionType,
          questionTypes: new Set(),
          category: row.category,
          subcategory: row.subcategory,
          questionIds: new Set(),
          missAttempts: 0,
          evidence: []
        });
      }
      const topic = topicsByKey.get(key);
      topic.missAttempts++;
      topic.questionTypes.add(row.questionType);
      topic.questionIds.add(row.questionId);
      if (topic.evidence.length < 4 && !topic.evidence.some(evidence => evidence.questionId === row.questionId && evidence.partIndex === partIndex)) {
        topic.evidence.push({
          questionId: row.questionId,
          questionType: row.questionType,
          partIndex: row.questionType === 'bonus' ? partIndex : null,
          title: cleanQuestionExcerpt(row.question, row.questionType, row.questionType === 'bonus' ? partIndex : null) || 'Question text unavailable',
          outcome: row.resultClass ?? row.outcome ?? 'partial',
          setName: row.setName
        });
      }
    }
  }
  const topics = [...topicsByKey.values()]
    .map(topic => {
      const questionCount = topic.questionIds.size;
      return {
        topic: topic.topic,
        questionType: topic.questionTypes.size > 1 ? 'mixed' : topic.questionType,
        category: topic.category,
        subcategory: topic.subcategory,
        evidence: topic.evidence,
        questionCount,
        missAttempts: topic.missAttempts,
        confidence: questionCount >= 3 ? 'High' : (questionCount === 2 ? 'Medium' : 'Low')
      };
    })
    .sort((a, b) => b.questionCount - a.questionCount || a.topic.localeCompare(b.topic))
    .slice(0, 8);

  db.exec('DELETE FROM recommendation_seen_ids');
  const insertSeen = db.prepare('INSERT OR IGNORE INTO recommendation_seen_ids(question_type, id) VALUES (?, ?)');
  for (const row of personal.prepare('SELECT DISTINCT question_type, question_id FROM history_questions WHERE question_id IS NOT NULL').all()) {
    insertSeen.run(row.question_type, row.question_id);
  }

  const seenIds = new Set();
  const answerKeys = new Set();
  const reviewPool = [];
  for (const area of targetAreas) {
    const best = targetRows.filter(row => matchesWeakArea(row, area))
      .sort((a, b) => (b.resultClass === 'neg' ? 1 : 0) - (a.resultClass === 'neg' ? 1 : 0) || b.playedAt.localeCompare(a.playedAt));
    for (const historyRow of best) {
      if (!historyRow.questionId || seenIds.has(`${historyRow.questionType}:${historyRow.questionId}`)) { continue; }
      const question = documentFromRow((historyRow.questionType === 'bonus' ? rows.bonus : rows.tossup).get(historyRow.questionId));
      if (!question) { continue; }
      const keys = answerKeysForQuestion(question, historyRow.questionType);
      if (keys.some(key => answerKeys.has(key))) { continue; }
      seenIds.add(`${historyRow.questionType}:${historyRow.questionId}`);
      keys.forEach(key => answerKeys.add(key));
      reviewPool.push({ question, type: historyRow.questionType, area, source: 'review' });
    }
  }

  const freshPool = [];
  const questionFilters = {
    setName: filters.setName,
    difficulties: filters.difficulties ?? filters.difficulty
  };
  for (const area of targetAreas) {
    const type = area.type;
    const table = type === 'bonus' ? 'bonuses' : 'tossups';
    const metadata = { ...questionFilters, category: area.category, subcategory: area.subcategory };
    const { clause, params } = sqlForMetadata(metadata, 'q', [
      'q.id NOT IN (SELECT id FROM recommendation_seen_ids WHERE question_type = ?)'
    ], [type]);
    const candidates = db.prepare(`SELECT q.doc_json FROM ${table} q ${clause} ORDER BY random() LIMIT 12`).all(...params);
    for (const candidate of candidates) {
      const question = documentFromRow(candidate);
      const id = question?._id;
      const keys = answerKeysForQuestion(question, type);
      if (!id || seenIds.has(`${type}:${id}`) || keys.some(key => answerKeys.has(key))) { continue; }
      seenIds.add(`${type}:${id}`);
      keys.forEach(key => answerKeys.add(key));
      freshPool.push({ question, type, area, source: 'new' });
    }
  }

  const selected = [];
  const reviewByArea = targetAreas.map(area => reviewPool.filter(item => item.area === area));
  const freshByArea = targetAreas.map(area => freshPool.filter(item => item.area === area));
  const half = 10;
  for (let index = 0; selected.length < half; index++) {
    let added = false;
    for (const areaItems of reviewByArea) {
      if (areaItems[index] && selected.length < half) {
        selected.push(areaItems[index]);
        added = true;
      }
    }
    if (!added) { break; }
  }
  const used = new Set(selected.map(item => `${item.type}:${item.question._id}`));
  const freshSelected = [];
  for (let index = 0; freshSelected.length < half; index++) {
    let added = false;
    for (const areaItems of freshByArea) {
      const item = areaItems[index];
      if (item && freshSelected.length < half) {
        const id = `${item.type}:${item.question._id}`;
        if (!used.has(id)) {
          freshSelected.push(item);
          used.add(id);
          added = true;
        }
      }
    }
    if (!added) { break; }
  }
  const varied = [];
  for (let index = 0; index < Math.max(selected.length, freshSelected.length); index++) {
    if (selected[index]) { varied.push(selected[index]); }
    if (freshSelected[index]) { varied.push(freshSelected[index]); }
  }
  const remaining = [...reviewPool, ...freshPool].filter(item => !used.has(`${item.type}:${item.question._id}`));
  while (varied.length < 20 && remaining.length) {
    const item = remaining.shift();
    varied.push(item);
    used.add(`${item.type}:${item.question._id}`);
  }
  return {
    areas,
    tentativeAreas: candidates.tentative,
    selectedScopeAreas: selectedContext,
    topics,
    session: {
      defaultLength: 10,
      reviewAvailable: reviewPool.length,
      unseenAvailable: freshPool.length,
      questions: varied.map(item => ({
        id: item.question._id,
        type: item.type,
        source: item.source,
        area: item.area.subcategory ? `${item.area.category} · ${item.area.subcategory}` : item.area.category
      }))
    }
  };
}

export function getLocalStats (filters = {}) {
  const conditions = [];
  const params = [];
  if (filters.from) { conditions.push('date(h.played_at) >= date(?)'); params.push(filters.from); }
  if (filters.to) { conditions.push('date(h.played_at) <= date(?)'); params.push(filters.to); }
  if (['tossup', 'bonus'].includes(filters.questionType)) { conditions.push('h.question_type = ?'); params.push(filters.questionType); }
  if (filters.setName) { conditions.push('h.set_name = ?'); params.push(filters.setName); }
  const difficulties = asNumbers(filters.difficulties ?? filters.difficulty);
  if (difficulties.length) { conditions.push(`h.difficulty IN (${difficulties.map(() => '?').join(',')})`); params.push(...difficulties); }
  if (filters.category) { conditions.push('h.category = ?'); params.push(filters.category); }
  if (filters.subcategory) { conditions.push('h.subcategory = ?'); params.push(filters.subcategory); }
  if (filters.mode) { conditions.push('s.mode = ?'); params.push(filters.mode); }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const sourceRows = personal.prepare(`
    SELECT h.*, s.mode FROM history_questions h
    JOIN history_sessions s ON s.id = h.session_id
    ${where}
    ORDER BY h.played_at DESC, h.session_id, h.ordinal
  `).all(...params).map(normalizedHistoryRow);
  const summary = blankStats();
  const categoryMap = new Map();
  const topCategoryMap = new Map();
  const sessionMap = new Map();
  const trendMap = new Map();
  for (const row of sourceRows) {
    addStat(summary, row);
    const key = `${row.category}\u0000${row.subcategory}`;
    if (!categoryMap.has(key)) { categoryMap.set(key, { category: row.category, subcategory: row.subcategory, stats: blankStats() }); }
    addStat(categoryMap.get(key).stats, row);
    if (!topCategoryMap.has(row.category)) { topCategoryMap.set(row.category, blankStats()); }
    addStat(topCategoryMap.get(row.category), row);
    if (!sessionMap.has(row.sessionId)) {
      sessionMap.set(row.sessionId, { id: row.sessionId, mode: row.mode, count: 0, points: 0, startedAt: row.playedAt, lastPlayedAt: row.playedAt });
    }
    const session = sessionMap.get(row.sessionId);
    session.count++;
    session.points += row.points ?? 0;
    if (row.playedAt < session.startedAt) { session.startedAt = row.playedAt; }
    if (row.playedAt > session.lastPlayedAt) { session.lastPlayedAt = row.playedAt; }
    const date = new Date(row.playedAt);
    const bucket = filters.period === 'week'
      ? (() => { const day = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())); day.setUTCDate(day.getUTCDate() - ((day.getUTCDay() + 6) % 7)); return day.toISOString().slice(0, 10); })()
      : `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
    if (!trendMap.has(bucket)) { trendMap.set(bucket, blankStats()); }
    addStat(trendMap.get(bucket), row);
  }
  const subcategories = [...categoryMap.values()].map(entry => ({
    category: entry.category, subcategory: entry.subcategory, ...summarizeStats(entry.stats)
  }));
  const categories = [...topCategoryMap.entries()].map(([category, stats]) => ({ category, ...summarizeStats(stats) }));
  const sessions = [...sessionMap.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, 30).map(session => ({
    id: session.id,
    mode: session.mode,
    startedAt: session.startedAt,
    filteredQuestionCount: session.count,
    filteredPoints: session.points
  }));
  const recommendations = buildStudyRecommendations(filters, sourceRows, summarizeStats(summary), categories, subcategories);
  return {
    summary: summarizeStats(summary),
    categories,
    subcategories,
    recommendations,
    trends: [...trendMap.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([period, stats]) => ({ period, ...summarizeStats(stats) })),
    sessions,
    questions: sourceRows.slice(0, 50),
    questionsTotal: sourceRows.length,
    options: {
      sets: personal.prepare('SELECT DISTINCT set_name AS value FROM history_questions WHERE set_name IS NOT NULL ORDER BY value COLLATE NOCASE').all().map(row => row.value),
      categories: personal.prepare('SELECT DISTINCT category AS value FROM history_questions WHERE category IS NOT NULL ORDER BY value COLLATE NOCASE').all().map(row => row.value),
      subcategories: personal.prepare('SELECT DISTINCT subcategory AS value FROM history_questions WHERE subcategory IS NOT NULL ORDER BY value COLLATE NOCASE').all().map(row => row.value),
      difficulties: personal.prepare('SELECT DISTINCT difficulty AS value FROM history_questions WHERE difficulty IS NOT NULL ORDER BY value').all().map(row => row.value),
      modes: personal.prepare('SELECT DISTINCT mode AS value FROM history_sessions ORDER BY value').all().map(row => row.value)
    }
  };
}

function selectRecommendationQuestions (questions, length) {
  const selected = [];
  const hasTossups = questions.some(question => question.type === 'tossup');
  let tossups = 0;
  let bonuses = 0;
  for (const question of questions) {
    if (selected.length >= length) { break; }
    if (question.type === 'bonus' && hasTossups && bonuses >= tossups) { continue; }
    selected.push(question);
    if (question.type === 'tossup') { tossups++; } else { bonuses++; }
  }
  return selected;
}

export function createStudyRecommendationPacket (filters = {}, length = 10) {
  const recommendations = getLocalStats(filters).recommendations;
  const selected = selectRecommendationQuestions(recommendations.session.questions, Math.max(1, Math.min(20, Number(length) || 10)));
  const tossups = [];
  const bonuses = [];
  for (const item of selected) {
    const question = getById(item.type, item.id);
    if (question) { (item.type === 'bonus' ? bonuses : tossups).push(question); }
  }
  if (!tossups.length && !bonuses.length) { return null; }
  const packet = {
    id: `stats-${randomUUID()}`,
    name: 'Stats study recommendation',
    tossups,
    bonuses
  };
  personal.prepare('INSERT INTO stats_practice_packets(id, doc_json) VALUES (?, ?)').run(packet.id, JSON.stringify(packet));
  return {
    id: packet.id,
    name: packet.name,
    tossupCount: tossups.length,
    bonusCount: bonuses.length,
    questionCount: tossups.length + bonuses.length
  };
}

export function getLocalQuestionStats (questionType, questionId) {
  const rows = personal.prepare(`
    SELECT outcome, points, possible_points AS possiblePoints, buzz_position AS buzzPosition, celerity,
      bonus_part_results_json AS bonusPartResults
    FROM history_questions WHERE question_type = ? AND question_id = ?
  `).all(questionType, questionId);
  if (!rows.length) { return null; }
  const totalPoints = rows.reduce((sum, row) => sum + (Number(row.points) || 0), 0);
  if (questionType === 'tossup') {
    const correctRows = rows.filter(row => row.outcome === 'correct');
    const resultCounts = {};
    for (const row of rows) {
      const value = String(Number(row.points) || 0);
      resultCounts[value] = (resultCounts[value] ?? 0) + 1;
    }
    return {
      count: rows.length,
      numCorrect: correctRows.length,
      totalCorrectCelerity: correctRows.reduce((sum, row) => sum + (Number(row.celerity) || 0), 0),
      resultCounts,
      totalPoints,
      pptu: totalPoints / rows.length
    };
  }
  const partCount = Math.max(0, ...rows.map(row => row.bonusPartResults ? JSON.parse(row.bonusPartResults).length : 0));
  const partTotals = Array(partCount).fill(0);
  for (const row of rows) {
    const parts = row.bonusPartResults ? JSON.parse(row.bonusPartResults) : [];
    parts.forEach((points, index) => { partTotals[index] += Number(points) || 0; });
  }
  const resultCounts = {};
  for (const row of rows) {
    const values = row.bonusPartResults ? JSON.parse(row.bonusPartResults) : [];
    const score = values.reduce((sum, value) => sum + (Number(value) || 0), 0);
    resultCounts[score] = (resultCounts[score] ?? 0) + 1;
  }
  return {
    count: rows.length,
    partConversion: partTotals.map((points, index) => points / (rows.length * 10)),
    resultCounts,
    totalPoints,
    ppb: totalPoints / rows.length
  };
}

export function readQuestionDatabaseStats () {
  return {
    tossups: db.prepare('SELECT count(*) AS count FROM tossups').get().count,
    bonuses: db.prepare('SELECT count(*) AS count FROM bonuses').get().count,
    sets: db.prepare('SELECT count(*) AS count FROM sets').get().count
  };
}
