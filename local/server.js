import express from '../qbreader-source/node_modules/express/index.js';
import checkAnswer from '../qbreader-source/node_modules/qb-answer-checker/src/check-answer.js';
import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as store from './sqlite-store.js';
import { parseCsv } from './parse-csv.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLIENT = path.join(ROOT, 'qbreader-source', 'client');
const SOURCE = path.join(ROOT, 'qbreader-source');
const app = express();
const port = Number(process.env.PORT) || 4173;
const WIKIPEDIA_CACHE = path.join(process.env.QB_READER_DATA_DIR || ROOT, 'wikipedia-cache');
const WIKIPEDIA_ARTICLE_CACHE_LIMIT = 50 * 1024 * 1024;
const WIKIPEDIA_IMAGE_CACHE_LIMIT = 50 * 1024 * 1024;
const WIKIMEDIA_USER_AGENT = 'QBSS/1.0 (https://github.com/cmdun/qbss)';
let wikipediaNextRequestAt = 0;
let wikipediaRequestQueue = Promise.resolve();

function cacheKey (value) {
  return createHash('sha256').update(value).digest('hex');
}

async function pruneWikipediaCache (directory, limit) {
  const files = await readdir(directory).catch(() => []);
  const isImageDirectory = directory.endsWith(`${path.sep}images`);
  const entries = await Promise.all(files.filter(name => !isImageDirectory || !name.endsWith('.json')).map(async name => {
    const filePath = path.join(directory, name);
    const fileStat = await stat(filePath).catch(() => null);
    const metadataPath = `${filePath}.json`;
    const metadataStat = isImageDirectory ? await stat(metadataPath).catch(() => null) : null;
    return fileStat?.isFile() ? { filePath, metadataPath, size: fileStat.size + (metadataStat?.size || 0), accessed: fileStat.atimeMs } : null;
  }));
  let total = entries.reduce((sum, entry) => sum + (entry?.size || 0), 0);
  for (const entry of entries.filter(Boolean).sort((a, b) => a.accessed - b.accessed)) {
    if (total <= limit) { break; }
    await unlink(entry.filePath).catch(() => {});
    if (entry.metadataPath) { await unlink(entry.metadataPath).catch(() => {}); }
    total -= entry.size;
  }
}

async function wikipediaFetch (url, accept) {
  const run = async () => {
    const delay = Math.max(0, wikipediaNextRequestAt - Date.now());
    if (delay) { await new Promise(resolve => setTimeout(resolve, delay)); }
    wikipediaNextRequestAt = Date.now() + 1000;
    let response = await fetch(url, {
      headers: {
        Accept: accept,
        'User-Agent': WIKIMEDIA_USER_AGENT
      },
      signal: AbortSignal.timeout(20000)
    });
    if (response.status === 429 || response.status === 503) {
      const retryAfter = Math.min(30, Math.max(1, Number(response.headers.get('retry-after')) || 3));
      wikipediaNextRequestAt = Date.now() + retryAfter * 1000;
      await new Promise(resolve => setTimeout(resolve, retryAfter * 1000));
      response = await fetch(url, {
        headers: {
          Accept: accept,
          'User-Agent': WIKIMEDIA_USER_AGENT
        },
        signal: AbortSignal.timeout(20000)
      });
    }
    return response;
  };
  const result = wikipediaRequestQueue.then(run, run);
  wikipediaRequestQueue = result.then(() => undefined, () => undefined);
  return result;
}

const wikipediaArticleDirectory = path.join(WIKIPEDIA_CACHE, 'articles');
const wikipediaImageDirectory = path.join(WIKIPEDIA_CACHE, 'images');
await Promise.all([mkdir(wikipediaArticleDirectory, { recursive: true }), mkdir(wikipediaImageDirectory, { recursive: true })]);

app.disable('x-powered-by');
app.set('query parser', 'simple');
app.use(express.json({ limit: '32mb' }));
app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'SAMEORIGIN',
    'Referrer-Policy': 'strict-origin-when-cross-origin'
  });
  next();
});

app.get('/health', (_req, res) => res.json({ ok: true, database: store.readQuestionDatabaseStats() }));

app.post('/api/local/anki', async (req, res) => {
  const { action, params = {} } = req.body || {};
  if (!['version', 'deckNames', 'modelNames', 'modelFieldNames', 'canAddNotes', 'addNote', 'guiAddCards'].includes(action)) {
    return res.status(400).json({ error: 'Unsupported Anki action.' });
  }
  try {
    const response = await fetch('http://127.0.0.1:8765', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, version: 6, params }), signal: AbortSignal.timeout(10000)
    });
    if (!response.ok) { throw new Error('AnkiConnect could not complete the request.'); }
    const result = await response.json();
    if (result.error) { return res.status(400).json({ error: result.error }); }
    res.json({ result: result.result });
  } catch (error) {
    res.status(503).json({ error: 'Cannot connect to Anki. Open Anki and make sure AnkiConnect is enabled.' });
  }
});

app.get(['/play', '/play/', '/play/tossups', '/play/tossups/', '/play/bonuses', '/play/bonuses/'], (req, res) => {
  const params = new URLSearchParams(req.query);
  if (req.path.includes('tossups')) { params.set('type', 'tossups'); }
  if (req.path.includes('bonuses')) { params.set('type', 'bonuses'); }
  const query = params.toString();
  res.redirect(302, `/play/combined/${query ? `?${query}` : ''}`);
});

app.get('/api/wikipedia/search', async (req, res) => {
  const query = String(req.query.q || '').trim();
  if (!query || query.length > 200) { return res.status(400).json({ error: 'Enter a search of 1–200 characters.' }); }
  try {
    const apiUrl = new URL('https://en.wikipedia.org/w/rest.php/v1/search/page');
    apiUrl.searchParams.set('q', query);
    apiUrl.searchParams.set('limit', '10');
    const response = await wikipediaFetch(apiUrl, 'application/json');
    if (!response.ok) { return res.status(response.status === 429 ? 429 : 502).json({ error: 'Wikipedia search is temporarily unavailable.' }); }
    res.json(await response.json());
  } catch (error) {
    console.error('Wikipedia search failed:', error.message);
    res.status(502).json({ error: 'Could not reach Wikipedia. Check your internet connection and try again.' });
  }
});

app.get('/api/wikipedia/article', async (req, res) => {
  const title = String(req.query.title || '').trim();
  if (!title || title.length > 300) { return res.status(400).json({ error: 'Choose a valid article title.' }); }
  const cachePath = path.join(wikipediaArticleDirectory, `${cacheKey(title)}.json`);
  try {
    const cached = await readFile(cachePath, 'utf8').catch(() => null);
    if (cached) {
      res.set('X-Wikipedia-Cache', 'hit');
      return res.type('json').send(cached);
    }
    const apiUrl = `https://en.wikipedia.org/w/rest.php/v1/page/${encodeURIComponent(title)}/html`;
    const response = await wikipediaFetch(apiUrl, 'text/html');
    if (response.status === 404) { return res.status(404).json({ error: 'That Wikipedia article could not be found.' }); }
    if (!response.ok) { return res.status(response.status === 429 ? 429 : 502).json({ error: 'Wikipedia could not load this article right now.' }); }
    const article = { title, html: await response.text(), cachedAt: new Date().toISOString() };
    const serialized = JSON.stringify(article);
    await writeFile(cachePath, serialized);
    await pruneWikipediaCache(wikipediaArticleDirectory, WIKIPEDIA_ARTICLE_CACHE_LIMIT);
    res.set('X-Wikipedia-Cache', 'miss').json(article);
  } catch (error) {
    console.error('Wikipedia article request failed:', error.message);
    res.status(502).json({ error: 'Could not reach Wikipedia. Cached articles remain available offline.' });
  }
});

app.get('/api/wikipedia/image', async (req, res) => {
  let imageUrl;
  try { imageUrl = new URL(String(req.query.url || '')); } catch { return res.sendStatus(400); }
  if (imageUrl.protocol !== 'https:' || !['upload.wikimedia.org', 'commons.wikimedia.org', 'thumb.wikimedia.org'].includes(imageUrl.hostname)) { return res.sendStatus(400); }
  try {
    const response = await fetch(imageUrl, {
      headers: { Accept: 'image/avif,image/webp,image/*', 'User-Agent': WIKIMEDIA_USER_AGENT },
      signal: AbortSignal.timeout(20000)
    });
    if (!response.ok) { return res.sendStatus(response.status === 404 ? 404 : 502); }
    const contentType = response.headers.get('content-type') || '';
    if (!contentType.startsWith('image/')) { return res.sendStatus(415); }
    res.set({ 'Content-Type': contentType, 'Cache-Control': 'no-store' });
    res.send(Buffer.from(await response.arrayBuffer()));
  } catch (error) {
    console.error('Wikipedia image request failed:', error.message);
    res.sendStatus(502);
  }
});

app.get('/api/wikipedia/image-cache/:key', async (req, res) => {
  if (!/^[a-f0-9]{64}$/.test(req.params.key)) { return res.sendStatus(400); }
  const cachePath = path.join(wikipediaImageDirectory, req.params.key);
  try {
    const image = await readFile(cachePath);
    const metadata = JSON.parse(await readFile(`${cachePath}.json`, 'utf8'));
    res.set({ 'Content-Type': metadata.contentType, 'X-Wikipedia-Cache': 'hit' }).send(image);
  } catch { res.sendStatus(404); }
});

app.put('/api/wikipedia/image-cache/:key', express.raw({ type: 'image/*', limit: '5mb' }), async (req, res) => {
  if (!/^[a-f0-9]{64}$/.test(req.params.key) || !Buffer.isBuffer(req.body) || !req.body.length) { return res.sendStatus(400); }
  const contentType = req.headers['content-type'];
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(contentType)) { return res.sendStatus(415); }
  const cachePath = path.join(wikipediaImageDirectory, req.params.key);
  try {
    await writeFile(cachePath, req.body);
    await writeFile(`${cachePath}.json`, JSON.stringify({ contentType }));
    await pruneWikipediaCache(wikipediaImageDirectory, WIKIPEDIA_IMAGE_CACHE_LIMIT);
    res.json({ cached: true });
  } catch (error) {
    console.error('Wikipedia image caching failed:', error.message);
    res.sendStatus(500);
  }
});

app.get('/api/query', (req, res) => {
  const questionType = req.query.questionType || 'all';
  const searchType = req.query.searchType || 'all';
  if (!['all', 'tossup', 'bonus'].includes(questionType)) { return res.status(400).send('Invalid question type specified.'); }
  if (!['all', 'question', 'answer', 'exactAnswer'].includes(searchType)) { return res.status(400).send('Invalid search type specified.'); }
  try {
    const result = store.queryQuestions({
      ...req.query,
      queryString: req.query.queryString ?? req.query.q ?? '',
      questionType,
      searchType,
      maxReturnLength: Math.max(1, Number.parseInt(req.query.maxReturnLength, 10) || 20),
      tossupPagination: Math.max(1, Number(req.query.tossupPagination) || 1),
      bonusPagination: Math.max(1, Number(req.query.bonusPagination) || 1)
    });
    res.json(result);
  } catch (error) {
    console.error('Question search failed:', error);
    res.status(400).json({ error: error.message });
  }
});

app.get('/api/random-tossup', (req, res) => {
  const tossups = store.getRandomQuestions('tossup', req.query);
  res.status(tossups.length ? 200 : 404).json({ tossups });
});

app.get('/api/random-bonus', (req, res) => {
  const bonuses = store.getRandomQuestions('bonus', req.query);
  res.status(bonuses.length ? 200 : 404).json({ bonuses });
});

app.get('/api/tossup', (req, res) => {
  const tossup = store.getById('tossup', req.query._id);
  if (!tossup) { return res.sendStatus(404); }
  res.json({ tossup });
});

app.get('/api/bonus', (req, res) => {
  const bonus = store.getById('bonus', req.query._id);
  if (!bonus) { return res.sendStatus(404); }
  res.json({ bonus });
});

app.get('/api/set-list', (req, res) => {
  if (req.query.expand === 'true') {
    return res.json({
      setList: store.listSets({
        includeCounts: req.query.includeCounts === 'true',
        limit: Math.max(1, Number(req.query.limit) || 10000)
      })
    });
  }
  res.json({ setList: store.listSetNames() });
});

app.get('/api/packet-list', (req, res) => {
  if (req.query.expand === 'true') {
    const packetList = store.listPacketMetadata(req.query.set_id);
    return res.json({ packetList, setName: packetList[0]?.setName });
  }
  if (!req.query.setName) { return res.sendStatus(400); }
  res.json({ packetList: store.listPackets(req.query.setName) });
});

app.get('/api/frequency-list', (req, res) => {
  const frequencyList = store.getFrequencyList({
    ...req.query,
    difficulties: req.query.difficulties ?? Array.from({ length: 11 }, (_, index) => index).join(','),
    minYear: req.query.minYear || undefined,
    maxYear: req.query.maxYear || undefined
  });
  res.status(frequencyList.length ? 200 : 404).json({ frequencyList });
});

app.get('/api/num-packets', (req, res) => {
  const numPackets = store.countPackets(req.query.setName);
  res.status(numPackets ? 200 : 404).json({ numPackets });
});

app.get('/api/packet', (req, res) => {
  if (req.query._id) {
    const packet = store.getPacketById(req.query._id);
    if (!packet) { return res.sendStatus(404); }
    const questionTypes = (req.query.questionTypes || 'tossups,bonuses').split(',');
    if (!questionTypes.includes('tossups')) { packet.tossups = []; }
    if (!questionTypes.includes('bonuses')) { packet.bonuses = []; }
    if (packet.tossups.length + packet.bonuses.length === 0) { return res.sendStatus(404); }
    return res.json(packet);
  }

  const packet = store.getPacket(req.query.setName, req.query.packetNumber);
  const questionTypes = (req.query.questionTypes || 'tossups,bonuses').split(',');
  if (!questionTypes.includes('tossups')) { packet.tossups = []; }
  if (!questionTypes.includes('bonuses')) { packet.bonuses = []; }
  if (packet.tossups.length + packet.bonuses.length === 0) { return res.sendStatus(404); }
  res.json(packet);
});

app.get('/api/check-answer', (req, res) => {
  const result = checkAnswer(req.query.answerline, req.query.givenAnswer, Number(req.query.strictness) || 7);
  res.json(result);
});

app.get('/api/question-stats/:questionType', (req, res) => {
  const questionType = req.params.questionType;
  if (!['tossup', 'bonus'].includes(questionType)) { return res.sendStatus(404); }
  res.json({ stats: store.getLocalQuestionStats(questionType, req.query._id) });
});

app.get('/api/health', (_req, res) => res.json(store.readQuestionDatabaseStats()));
app.get('/api/local/settings', (_req, res) => res.json({ settings: store.loadSettings() }));
app.put('/api/local/settings/:key', (req, res) => {
  store.saveSetting(req.params.key, req.body.value);
  res.json({ saved: true });
});

app.get('/auth/stars/:questionType-ids', (req, res) => {
  const type = req.params.questionType;
  if (!['tossup', 'bonus'].includes(type)) { return res.sendStatus(404); }
  res.json(store.getStarredIds(type));
});
app.get('/auth/stars/is-starred-:questionType', (req, res) => {
  const type = req.params.questionType;
  const id = req.query[`${type}_id`];
  res.json({ isStarred: store.isStarred(type, id) });
});
app.get('/auth/stars/:questionType', (req, res) => {
  const type = { tossups: 'tossup', bonuses: 'bonus' }[req.params.questionType];
  if (!['tossup', 'bonus'].includes(type)) { return res.sendStatus(404); }
  res.json(store.getStarredQuestions(type));
});
app.put('/auth/stars/star-:questionType', (req, res) => {
  const type = req.params.questionType;
  const id = req.body[`${type}_id`];
  if (!['tossup', 'bonus'].includes(type) || !id) { return res.sendStatus(400); }
  res.json({ isStarred: store.setStar(type, id, true) });
});
app.put('/auth/stars/unstar-:questionType', (req, res) => {
  const type = req.params.questionType;
  const id = req.body[`${type}_id`];
  if (!['tossup', 'bonus'].includes(type) || !id) { return res.sendStatus(400); }
  res.json({ isStarred: store.setStar(type, id, false) });
});
app.delete('/auth/stars/clear-:questionType-stars', (req, res) => {
  const type = req.params.questionType;
  if (!['tossup', 'bonus'].includes(type)) { return res.sendStatus(404); }
  res.json({ count: store.clearStars(type) });
});

app.post('/api/local/stars/practice', (req, res) => {
  const { questionType, ids } = req.body;
  if (!['tossup', 'bonus'].includes(questionType) || !Array.isArray(ids) || ids.some(id => typeof id !== 'string')) { return res.sendStatus(400); }
  const packet = store.createStarredPracticePacket(questionType, ids);
  if (!packet) { return res.status(404).json({ error: 'No matching starred questions were found.' }); }
  res.status(201).json(packet);
});

app.get('/api/local/packets', (_req, res) => res.json({ packets: store.listImportedPackets() }));
app.post('/api/local/packets', (req, res) => {
  const packet = store.saveImportedPacket(req.body.packet ?? req.body, req.body.filename ?? '');
  res.status(201).json(packet);
});
app.get('/api/local/packets/:id', (req, res) => {
  const packet = store.getLocalPacket(req.params.id);
  if (!packet) { return res.sendStatus(404); }
  res.json(packet);
});
app.delete('/api/local/packets/:id', (req, res) => res.json({ count: store.removeImportedPacket(req.params.id) }));

app.post('/api/local/history/sessions', (req, res) => {
  res.status(201).json({ id: store.startHistorySession(req.body.mode ?? 'Tossups') });
});
app.put('/api/local/history/sessions/:id/questions/:ordinal', (req, res) => {
  const { question, questionType, ...result } = req.body;
  store.saveHistoryQuestion(req.params.id, Number(req.params.ordinal), questionType, question, result);
  res.json({ saved: true });
});
app.put('/api/local/history/sessions/:id/finish', (req, res) => {
  store.finishHistorySession(req.params.id, req.body);
  res.json({ saved: true });
});
app.get('/api/local/stats', (req, res) => {
  res.json(store.getLocalStats({ ...req.query, period: req.query.period === 'week' ? 'week' : 'month' }));
});
app.post('/api/local/stats/import/:type', (req, res) => {
  const type = req.params.type;
  if (!['tossups', 'bonuses'].includes(type)) { return res.sendStatus(404); }
  const csv = req.body?.csv;
  const filename = String(req.body?.filename || `${type}-stats.csv`).slice(0, 255);
  if (typeof csv !== 'string' || !csv.trim()) { return res.status(400).json({ error: 'Choose a non-empty CSV file.' }); }
  if (Buffer.byteLength(csv, 'utf8') > 24 * 1024 * 1024) { return res.status(413).json({ error: 'Stats CSV files must be smaller than 24 MB.' }); }
  try {
    const records = parseCsv(csv);
    if (!records.length) { return res.status(400).json({ error: 'The CSV has no stats rows.' }); }
    const requiredHeaders = type === 'tossups' ? ['tossup._id', 'created', 'pointValue'] : ['bonus._id', 'created', 'part1', 'part2', 'part3'];
    const headers = new Set(Object.keys(records[0]));
    const missing = requiredHeaders.filter(header => !headers.has(header));
    if (missing.length) { return res.status(400).json({ error: `This does not look like a QBReader ${type} stats CSV. Missing columns: ${missing.join(', ')}.` }); }
    const fileHash = createHash('sha256').update(csv).digest('hex');
    const result = type === 'tossups'
      ? store.importQbReaderTossupStats(records, fileHash, filename)
      : store.importQbReaderBonusStats(records, fileHash, filename);
    res.json({ filename: path.basename(filename), rowsInFile: records.length, ...result });
  } catch (error) {
    console.error(`QBReader ${type} stats import failed:`, error.message);
    res.status(400).json({ error: `Could not import this CSV: ${error.message}` });
  }
});
app.post('/api/local/stats/practice', (req, res) => {
  const packet = store.createStatsPracticePacket(req.body.filters ?? {}, { neggedOnly: req.body.neggedOnly === true });
  if (!packet) { return res.status(404).json({ error: 'No matching questions are available in the local database.' }); }
  res.status(201).json(packet);
});
app.post('/api/local/stats/recommendation-practice', (req, res) => {
  const packet = store.createStudyRecommendationPacket(req.body.filters ?? {}, req.body.length ?? 10);
  if (!packet) { return res.status(404).json({ error: 'No review or unseen questions are available for these filters.' }); }
  res.status(201).json(packet);
});
app.get('/local/history', (_req, res) => res.redirect(301, '/local/stats/'));
app.get('/api/local/history', (req, res) => res.json({ sessions: store.listHistorySessions(req.query.limit) }));
app.get('/api/local/history/:id', (req, res) => {
  const session = store.getHistorySession(req.params.id);
  if (!session) { return res.sendStatus(404); }
  res.json(session);
});

function serveLocalHtml (req, res, next) {
  if (req.method !== 'GET') { return next(); }
  const route = req.path.replace(/^\/+|\/+$/g, '');
  if (path.extname(route) && path.extname(route) !== '.html') { return next(); }
  const candidates = route === ''
    ? [path.resolve(CLIENT, 'index.html')]
    : path.extname(route) === '.html'
      ? [path.resolve(CLIENT, route)]
      : [path.resolve(CLIENT, route, 'index.html'), path.resolve(CLIENT, `${route}.html`)];
  const page = candidates.find(candidate => candidate.startsWith(CLIENT + path.sep) && existsSync(candidate));
  if (!page) { return next(); }
  let html = readFileSync(page, 'utf8');
  const ssiDirectory = path.join(SOURCE, 'ssi');
  const ssiFiles = ['nav.html', 'head.html', 'star-toast.html', 'funny-toast.html', 'clipboard-toast.html', 'report-question-modal.html'];
  for (const name of ssiFiles) {
    const marker = `<!--#include virtual="/ssi/${name}" -->`;
    if (html.includes(marker)) { html = html.replaceAll(marker, readFileSync(path.join(ssiDirectory, name), 'utf8')); }
  }
  res.type('html').send(html);
}

app.get('*', serveLocalHtml);
app.use('/bootstrap-icons', express.static(path.join(SOURCE, 'node_modules', 'bootstrap-icons')));
app.use('/node_modules', express.static(path.join(SOURCE, 'node_modules')));
app.use('/shared', express.static(path.join(SOURCE, 'shared')));
app.use('/docs', express.static(path.join(SOURCE, 'docs')));
app.use(express.static(CLIENT));
app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(500).json({ error: 'QBSS request failed.' });
});

export function startLocalServer () {
  return new Promise((resolve, reject) => {
    const server = createServer(app);
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      console.log(`QBSS ready at http://127.0.0.1:${port}`);
      console.log(JSON.stringify(store.readQuestionDatabaseStats()));
      resolve(server);
    });
  });
}

const isMainModule = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMainModule) {
  startLocalServer().catch(error => {
    console.error('Could not start QBSS:', error);
    process.exitCode = 1;
  });
}
