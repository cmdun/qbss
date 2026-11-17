const $ = id => document.getElementById(id);
const filterIds = ['date-range', 'date-from', 'date-to', 'question-type', 'set-name', 'mode', 'category', 'subcategory', 'trend-period', 'trend-metric'];
const FILTERS_KEY = 'local-stats-filters-v1';
let loaded;
let restoredFilters = false;

function esc (value) {
  return String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}

function pct (value) { return `${(100 * (Number(value) || 0)).toFixed(1)}%`; }
function number (value, digits = 1) { return (Number(value) || 0).toFixed(digits); }
function localDate (date) { return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`; }

function getDateRange () {
  const range = $('date-range').value;
  if (range === 'all') { return {}; }
  if (range === 'custom') { return { from: $('date-from').value, to: $('date-to').value }; }
  const end = new Date();
  const start = new Date(end);
  start.setDate(start.getDate() - Number(range));
  return { from: localDate(start), to: localDate(end) };
}

function readFilters () {
  return {
    ...getDateRange(),
    questionType: $('question-type').value,
    setName: $('set-name').value,
    difficulties: [...document.querySelectorAll('#difficulty-options input:checked')].map(input => input.value),
    mode: $('mode').value,
    category: $('category').value,
    subcategory: $('subcategory').value,
    period: $('trend-period').value
  };
}

function setOptions (id, values, firstLabel, selected = '') {
  const select = $(id);
  const previous = selected || select.value;
  select.replaceChildren(new window.Option(firstLabel, ''));
  for (const value of values) { select.add(new window.Option(String(value), String(value))); }
  if ([...select.options].some(option => option.value === previous)) { select.value = previous; }
}

function updateFilterOptions (options) {
  setOptions('set-name', options.sets, 'All sets');
  setOptions('category', options.categories, 'All categories');
  setOptions('subcategory', options.subcategories, 'All subcategories');
  const difficultyOptions = $('difficulty-options');
  const selectedDifficulties = new Set(readFilters().difficulties);
  difficultyOptions.replaceChildren();
  for (const difficulty of options.difficulties) {
    const label = document.createElement('label');
    label.className = 'dropdown-item d-flex gap-2 align-items-center';
    const input = document.createElement('input');
    input.type = 'checkbox'; input.value = String(difficulty); input.checked = selectedDifficulties.has(String(difficulty));
    input.addEventListener('change', () => { updateDifficultyLabel(); saveFilters(); refresh(); });
    label.append(input, document.createTextNode(`Difficulty ${difficulty}`)); difficultyOptions.append(label);
  }
  updateDifficultyLabel();
  setOptions('mode', options.modes, 'All modes');
}

function updateDifficultyLabel () {
  const selected = [...document.querySelectorAll('#difficulty-options input:checked')].map(input => input.value);
  $('difficulty-filter').querySelector('summary').textContent = selected.length ? `Difficulties: ${selected.join(', ')}` : 'All difficulties';
}

function saveFilters () {
  const state = Object.fromEntries(filterIds.map(id => [id, $(id).value]));
  state.difficulties = readFilters().difficulties;
  try { window.localStorage.setItem(FILTERS_KEY, JSON.stringify(state)); } catch {}
}

function restoreFilters () {
  if (restoredFilters) { return false; }
  restoredFilters = true;
  let saved;
  try { saved = JSON.parse(window.localStorage.getItem(FILTERS_KEY) ?? 'null'); } catch { saved = null; }
  if (!saved) { return false; }
  for (const id of filterIds) {
    const field = $(id);
    if (field.tagName === 'SELECT' && saved[id] !== undefined && [...field.options].some(option => option.value === saved[id])) { field.value = saved[id]; }
  }
  if (saved['date-from']) { $('date-from').value = saved['date-from']; }
  if (saved['date-to']) { $('date-to').value = saved['date-to']; }
  for (const input of document.querySelectorAll('#difficulty-options input')) { input.checked = (saved.difficulties ?? []).includes(input.value); }
  updateDifficultyLabel();
  document.querySelectorAll('.custom-date').forEach(element => element.classList.toggle('d-none', $('date-range').value !== 'custom'));
  return true;
}

function card (title, value, caption) {
  return `<div class="col"><article class="card h-100"><div class="card-body"><div class="text-muted small">${esc(title)}</div><div class="fs-3 fw-semibold">${esc(value)}</div><div class="small text-muted">${esc(caption)}</div></div></article></div>`;
}

function renderOverview (summary) {
  const cards = [
    card('Questions played', summary.attempts, `${summary.tossups} tossups · ${summary.bonuses} bonuses`),
    card('Power rate', pct(summary.powerRate), `${summary.powers} powers across ${summary.tossups} tossups`),
    card('Neg rate', pct(summary.negRate), `${summary.negs} negs across ${summary.buzzAttempts} buzzes`),
    card('Average correct buzz', summary.averageCorrectBuzzPosition === null ? (summary.averageCorrectClueRead === null ? '—' : `${pct(summary.averageCorrectClueRead)} of clue`) : `Word ${Math.floor(summary.averageCorrectBuzzPosition) + 1} · ${summary.averageCorrectBuzzPositionCount} ${summary.averageCorrectBuzzPositionCount === 1 ? 'answer' : 'answers'}`, summary.averageCorrectClueRead === null ? 'Average word position for correct answers' : `Average clue read: ${pct(summary.averageCorrectClueRead)} across ${summary.averageCorrectClueReadCount} ${summary.averageCorrectClueReadCount === 1 ? 'answer' : 'answers'}`),
    card('Points per bonus', summary.bonuses ? number(summary.pointsPerBonus, 2) : '—', `${summary.bonuses} bonuses · PPB`)
  ];
  $('overview').innerHTML = cards.join('');
}

function statMetric (stats, type) {
  return type === 'tossup'
    ? { attempts: stats.tossups, value: stats.pointsPerTossup, label: 'PPTU', baseline: loaded.summary.pointsPerTossup }
    : { attempts: stats.bonuses, value: stats.pointsPerBonus, label: 'PPB', baseline: loaded.summary.pointsPerBonus };
}

function renderRankedAreas (targetId, direction) {
  const candidates = [];
  for (const [type, rows] of [['tossup', [...loaded.categories, ...loaded.subcategories]], ['bonus', [...loaded.categories, ...loaded.subcategories]]]) {
    for (const row of rows) {
      const metric = statMetric(row, type);
      if (metric.attempts < 10) { continue; }
      const delta = metric.value - metric.baseline;
      if ((direction === 'high' && delta > 0) || (direction === 'low' && delta < 0)) {
        candidates.push({ ...row, type, metric, delta });
      }
    }
  }
  candidates.sort((a, b) => direction === 'high' ? b.delta - a.delta : a.delta - b.delta);
  const selected = candidates.slice(0, 6);
  const target = $(targetId);
  target.replaceChildren();
  if (!selected.length) {
    target.innerHTML = '<p class="text-muted mb-0">Keep practicing; no area has enough attempts above or below your average yet.</p>';
    return;
  }
  for (const row of selected) {
    const wrapper = document.createElement('div');
    wrapper.className = 'd-flex justify-content-between gap-3 border-bottom py-2';
    const name = row.subcategory
      ? `${row.category} · ${row.subcategory}`
      : row.category;
    wrapper.innerHTML = `<span>${esc(name)} <span class="badge text-bg-light">${row.type === 'tossup' ? 'Tossups' : 'Bonuses'}</span><br><small class="text-muted">${row.metric.attempts} attempts · ${row.metric.label}</small></span><strong class="text-nowrap">${number(row.metric.value, 2)} <small class="text-muted">(${row.delta > 0 ? '+' : ''}${number(row.delta, 2)})</small></strong>`;
    target.append(wrapper);
  }
}

function areaName (area) {
  return area.subcategory ? `${area.category} · ${area.subcategory}` : area.category;
}

function selectedRecommendationQuestions (length) {
  const questions = loaded?.recommendations?.session.questions ?? [];
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

function renderRecommendations (recommendations) {
  const areaRoot = $('recommendation-areas');
  areaRoot.replaceChildren();
  if (!recommendations.areas.length) {
    const empty = document.createElement('p');
    empty.className = 'small text-muted mb-0';
    empty.textContent = 'No weakness has enough attempts to rank yet. Keep practicing; recommendations appear after an area has at least 10 attempts.';
    areaRoot.append(empty);
  }
  for (const area of recommendations.areas) {
    const item = document.createElement('div');
    item.className = 'border-bottom py-2';
    const title = document.createElement('strong');
    title.textContent = `${areaName(area)} · ${area.type === 'tossup' ? 'Tossups' : 'Bonuses'}`;
    const detail = document.createElement('div');
    detail.className = 'small text-muted';
    detail.textContent = area.type === 'tossup'
      ? `${area.attempts} attempts · PPTU ${number(area.value, 2)} vs ${number(area.baseline, 2)} overall · power ${pct(area.powerRate)} vs ${pct(area.baselinePowerRate)} · neg ${pct(area.negRate)} vs ${pct(area.baselineNegRate)}`
      : `${area.attempts} bonuses · PPB ${number(area.value, 2)} vs ${number(area.baseline, 2)} overall`;
    const note = document.createElement('div');
    note.className = 'small';
    note.textContent = area.type === 'tossup'
      ? (area.negRate > area.baselineNegRate ? 'The higher neg rate points to accuracy or content review.' : 'The lower power rate suggests an opportunity to recognize answers earlier.')
      : 'Review incomplete bonus answers in this area.';
    item.append(title, detail, note);
    areaRoot.append(item);
  }
  for (const area of recommendations.selectedScopeAreas) {
    const item = document.createElement('div');
    item.className = 'border-bottom py-2';
    const title = document.createElement('strong');
    title.textContent = `Selected filter · ${areaName(area)} · ${area.type === 'tossup' ? 'Tossups' : 'Bonuses'}`;
    const detail = document.createElement('div');
    detail.className = 'small text-muted';
    detail.textContent = area.type === 'tossup'
      ? `${area.attempts} attempts · PPTU ${number(area.value, 2)} · power ${pct(area.powerRate)} · neg ${pct(area.negRate)}`
      : `${area.attempts} bonuses · PPB ${number(area.value, 2)}`;
    const note = document.createElement('div');
    note.className = 'small';
    note.textContent = area.tentative
      ? 'Focused sample with fewer than 10 attempts; use this as an early signal.'
      : 'Focused practice from the selected filter; it is not a comparison against your overall average.';
    item.append(title, detail, note);
    areaRoot.append(item);
  }
  if (recommendations.tentativeAreas.length) {
    const note = document.createElement('p');
    note.className = 'small text-muted mb-1 mt-3';
    note.textContent = 'Early signals · fewer than 10 attempts, so these are not ranked';
    areaRoot.append(note);
    for (const area of recommendations.tentativeAreas) {
      const item = document.createElement('div');
      item.className = 'small text-muted py-1';
      item.textContent = `${areaName(area)} · ${area.type === 'tossup' ? 'Tossups' : 'Bonuses'} · ${area.attempts} attempts`;
      areaRoot.append(item);
    }
  }

  const topicRoot = $('recommendation-topics');
  topicRoot.replaceChildren();
  if (!recommendations.topics.length) {
    const empty = document.createElement('p');
    empty.className = 'small text-muted mb-0';
    empty.textContent = 'No missed answerlines in the currently ranked areas. Try broader filters or keep building your history.';
    topicRoot.append(empty);
  }
  for (const topic of recommendations.topics) {
    const item = document.createElement('article');
    item.className = 'border-bottom py-2';
    const heading = document.createElement('div');
    const title = document.createElement('strong');
    title.textContent = topic.topic;
    const badge = document.createElement('span');
    badge.className = 'badge text-bg-light ms-2';
    badge.textContent = `${topic.confidence} evidence`;
    heading.append(title, badge);
    const context = document.createElement('div');
    context.className = 'small text-muted';
    const topicType = topic.questionType === 'tossup' ? 'Tossup' : (topic.questionType === 'bonus' ? 'Bonus' : 'Tossup and bonus');
    context.textContent = `${topic.category}${topic.subcategory ? ` · ${topic.subcategory}` : ''} · ${topic.missAttempts} missed ${topic.missAttempts === 1 ? 'attempt' : 'attempts'} across ${topic.questionCount} ${topic.questionCount === 1 ? 'question' : 'questions'} · ${topicType}`;
    const evidence = document.createElement('details');
    evidence.className = 'small mt-1';
    const summary = document.createElement('summary');
    summary.textContent = 'Show supporting questions';
    const list = document.createElement('ul');
    list.className = 'mb-0 mt-1';
    for (const entry of topic.evidence) {
      const row = document.createElement('li');
      if (entry.questionId) {
        const link = document.createElement('a');
        link.href = reviewUrl({ questionType: entry.questionType, questionId: entry.questionId });
        link.textContent = entry.title;
        row.append(link);
      } else { row.textContent = entry.title; }
      row.append(document.createTextNode(`${entry.partIndex === null ? '' : ` · Bonus part ${entry.partIndex + 1}`} · ${entry.outcome}${entry.setName ? ` · ${entry.setName}` : ''}`));
      list.append(row);
    }
    evidence.append(summary, list);
    item.append(heading, context, evidence);
    topicRoot.append(item);
  }

  const session = recommendations.session;
  const shown = selectedRecommendationQuestions(Number($('recommendation-length').value) || 10);
  const reviewCount = shown.filter(question => question.source === 'review').length;
  const freshCount = shown.filter(question => question.source === 'new').length;
  const types = ['tossup', 'bonus'].map(type => `${shown.filter(question => question.type === type).length} ${type === 'tossup' ? 'tossups' : 'bonuses'}`);
  $('recommendation-session-summary').textContent = shown.length
    ? `This varied session currently has ${reviewCount} review and ${freshCount} unseen questions (${types.join(', ')}), spread across ${new Set(shown.map(question => question.area)).size} weak areas. Available: ${session.reviewAvailable} review and ${session.unseenAvailable} unseen.`
    : 'There are no ranked areas with eligible review or unseen questions under these filters.';
  $('start-recommendation').disabled = shown.length === 0;
}

function renderCategoryTable () {
  const tbody = $('category-rows');
  tbody.replaceChildren();
  const rows = [...loaded.subcategories].sort((a, b) => a.category.localeCompare(b.category) || a.subcategory.localeCompare(b.subcategory));
  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="9" class="text-muted text-center py-4">No category data for these filters.</td></tr>';
    return;
  }
  for (const row of rows) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${esc(row.category)}</td><td>${esc(row.subcategory)}</td><td class="text-end">${row.tossups}</td><td class="text-end">${row.tossups ? pct(row.powerRate) : '—'}</td><td class="text-end">${row.tossups ? number(row.pointsPerTossup, 2) : '—'}</td><td class="text-end">${row.buzzAttempts ? `${row.negs}/${row.buzzAttempts} <small class="text-muted">(${pct(row.negRate)})</small>` : '—'}</td><td class="text-end">${row.bonuses}</td><td class="text-end">${row.bonuses ? number(row.pointsPerBonus, 2) : '—'}</td><td class="text-nowrap"></td>`;
    const actions = tr.cells[8];
    const practice = document.createElement('button'); practice.className = 'btn btn-sm btn-outline-primary me-1'; practice.type = 'button'; practice.textContent = 'Practice';
    practice.addEventListener('click', () => openPractice(row, false));
    const negs = document.createElement('button'); negs.className = 'btn btn-sm btn-outline-secondary'; negs.type = 'button'; negs.textContent = 'Negs'; negs.disabled = !row.negs;
    negs.title = `Practice the ${row.negs} negs from this filtered history`;
    negs.addEventListener('click', () => openPractice(row, true));
    actions.append(practice, negs);
    tbody.append(tr);
  }
}

async function openPractice (row, neggedOnly) {
  const filters = { ...readFilters(), category: row.category, subcategory: row.subcategory };
  try {
    const response = await fetch('/api/local/stats/practice', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filters, neggedOnly })
    });
    const result = await response.json();
    if (!response.ok) { throw new Error(result.error || 'Could not build a practice packet.'); }
    window.location.assign(`/play/combined/?type=combined&packetId=${encodeURIComponent(result.id)}`);
  } catch (error) { window.alert(error.message); }
}

function renderChart (trends) {
  const root = $('trend-chart');
  root.replaceChildren();
  const metric = $('trend-metric').value;
  const metricLabels = {
    pointsPerTossup: 'Tossup points per question',
    powerRate: 'Power rate',
    negRate: 'Neg rate',
    pointsPerBonus: 'Points per bonus (PPB)'
  };
  const percentageMetric = ['powerRate', 'negRate'].includes(metric);
  const valueFor = row => Number(row[metric]) || 0;
  const formatMetric = value => percentageMetric ? pct(value) : number(value, 2);
  $('trend-caption').textContent = `${trends.length} ${$('trend-period').value === 'week' ? 'weeks' : 'months'} · ${metricLabels[metric]}`;
  if (!trends.length) { root.innerHTML = '<p class="text-muted">No trend data for this view.</p>'; return; }
  const svgNS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('viewBox', '0 0 720 250');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', `${metricLabels[metric]} by ${$('trend-period').value}`);
  const min = percentageMetric ? 0 : Math.min(0, ...trends.map(valueFor));
  const max = percentageMetric ? 1 : Math.max(15, ...trends.map(valueFor));
  const points = trends.map((row, index) => ({
    x: trends.length === 1 ? 360 : 30 + index * 660 / (trends.length - 1),
    y: 210 - ((valueFor(row) - min) / (max - min)) * 170,
    row
  }));
  for (let tick = 0; tick <= 3; tick++) {
    const y = 210 - tick * 170 / 3;
    const line = document.createElementNS(svgNS, 'line');
    line.setAttribute('x1', '30'); line.setAttribute('x2', '690'); line.setAttribute('y1', String(y)); line.setAttribute('y2', String(y));
    line.setAttribute('stroke', 'currentColor'); line.setAttribute('opacity', '0.16'); svg.append(line);
    const label = document.createElementNS(svgNS, 'text');
    label.setAttribute('x', '24'); label.setAttribute('y', String(y - 4)); label.setAttribute('text-anchor', 'end'); label.setAttribute('class', 'stats-chart-label');
    const tickValue = min + ((max - min) * tick / 3);
    label.textContent = percentageMetric ? pct(tickValue) : tickValue.toFixed(0); svg.append(label);
  }
  if (points.length > 1) {
    const path = document.createElementNS(svgNS, 'path');
    path.setAttribute('d', points.map((point, index) => `${index ? 'L' : 'M'} ${point.x} ${point.y}`).join(' '));
    path.setAttribute('fill', 'none'); path.setAttribute('stroke', 'var(--bs-primary)'); path.setAttribute('stroke-width', '3');
    svg.append(path);
  }
  for (const { x, y, row } of points) {
    const circle = document.createElementNS(svgNS, 'circle');
    circle.setAttribute('cx', String(x)); circle.setAttribute('cy', String(y)); circle.setAttribute('r', '5');
    circle.setAttribute('fill', 'var(--bs-primary)'); svg.append(circle);
    const title = document.createElementNS(svgNS, 'title'); title.textContent = `${row.period}: ${formatMetric(valueFor(row))} ${metricLabels[metric]} · ${row.attempts} questions`; circle.append(title);
  }
  const xlabels = new Set([0, Math.floor((trends.length - 1) / 2), trends.length - 1]);
  for (const index of xlabels) {
    const label = document.createElementNS(svgNS, 'text');
    label.setAttribute('x', String(points[index].x)); label.setAttribute('y', '238'); label.setAttribute('text-anchor', 'middle'); label.setAttribute('class', 'stats-chart-label');
    label.textContent = points[index].row.period; svg.append(label);
  }
  root.append(svg);
}

function questionTitle (item) {
  const q = item.question ?? {};
  const clean = (q.question ?? q.leadin ?? 'Question').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  return clean.length > 190 ? `${clean.slice(0, 187)}…` : clean;
}

function reviewUrl (item) {
  if (!item.questionId) { return ''; }
  return `/db/${item.questionType}/?${new URLSearchParams({ _id: item.questionId })}`;
}

function questionElement (item) {
  const wrapper = document.createElement('div');
  wrapper.className = 'list-group-item';
  const label = item.questionType === 'tossup' ? (item.resultClass ?? item.outcome ?? 'unanswered') : `${item.outcome ?? 'partial'} bonus`;
  const detail = `${new Date(item.playedAt).toLocaleString()} · ${item.setName ?? 'Local packet'} · ${item.category} / ${item.subcategory} · ${label}`;
  const title = questionTitle(item);
  const review = title !== 'Question' ? reviewUrl(item) : '';
  wrapper.innerHTML = `<div class="d-flex flex-wrap justify-content-between gap-2"><div class="flex-grow-1"><div class="small text-muted">${esc(detail)}${item.points === null ? '' : ` · ${number(item.points, 0)}/${number(item.possiblePoints, 0)} pts`}</div><div>${esc(title)}</div></div>${review ? `<a class="btn btn-sm btn-outline-secondary align-self-center" href="${esc(review)}">Review</a>` : ''}</div>`;
  return wrapper;
}

async function showSession (sessionId, panel) {
  panel.replaceChildren();
  const response = await fetch(`/api/local/history/${encodeURIComponent(sessionId)}`);
  if (!response.ok) { panel.textContent = 'Could not load this session.'; return; }
  const session = await response.json();
  const header = document.createElement('div');
  header.className = 'd-flex justify-content-between align-items-center mt-3 mb-2';
  const title = document.createElement('h3'); title.className = 'h6 mb-0'; title.textContent = `${session.mode} · ${new Date(session.startedAt).toLocaleString()}`;
  const close = document.createElement('button'); close.type = 'button'; close.className = 'btn btn-sm btn-outline-secondary'; close.textContent = 'Close'; close.addEventListener('click', () => panel.replaceChildren());
  header.append(title, close); panel.append(header);
  const summary = document.createElement('p'); summary.className = 'small text-muted'; summary.textContent = `${session.questionCount} saved question records`;
  panel.append(summary);
  if (session.questionsLimited) {
    const note = document.createElement('p'); note.className = 'small text-muted';
    note.textContent = 'Showing the 100 most recent imported questions. Use the Stats filters to narrow the full imported history.';
    panel.append(note);
  }
  const list = document.createElement('div'); list.className = 'list-group';
  for (const item of session.questions) {
    list.append(questionElement({ ...item, question: item.question, playedAt: item.playedAt, resultClass: item.resultClass }));
  }
  panel.append(list);
}

function renderSessions (sessions) {
  const target = $('sessions'); target.replaceChildren();
  $('sessions-empty').classList.toggle('d-none', sessions.length > 0);
  for (const session of sessions) {
    const wrapper = document.createElement('div'); wrapper.className = 'list-group-item';
    const row = document.createElement('div'); row.className = 'd-flex flex-wrap justify-content-between align-items-center gap-2';
    const summary = document.createElement('span');
    summary.textContent = `${new Date(session.startedAt).toLocaleString()} · ${session.mode} · ${session.filteredQuestionCount} matching questions`;
    const button = document.createElement('button'); button.type = 'button'; button.className = 'btn btn-sm btn-outline-primary'; button.textContent = 'View questions';
    const panel = document.createElement('div');
    button.addEventListener('click', () => showSession(session.id, panel).catch(() => { panel.textContent = 'Could not load this session.'; }));
    row.append(summary, button); wrapper.append(row, panel); target.append(wrapper);
  }
}

async function refresh () {
  $('loading').classList.remove('d-none'); $('error-state').classList.add('d-none'); $('stats-content').classList.add('d-none'); $('empty-state').classList.add('d-none');
  const params = new URLSearchParams(Object.fromEntries(Object.entries(readFilters()).filter(([, value]) => value !== '' && value !== undefined)));
  try {
    const response = await fetch(`/api/local/stats?${params}`);
    if (!response.ok) { throw new Error('Could not load local stats.'); }
    loaded = await response.json();
    updateFilterOptions(loaded.options);
    if (restoreFilters()) { saveFilters(); return refresh(); }
    $('stats-scope').textContent = `${$('date-range').selectedOptions[0].text} · ${$('question-type').value || 'All types'} · ${$('mode').value || 'All modes'}`;
    $('loading').classList.add('d-none');
    if (!loaded.summary.attempts) { $('empty-state').classList.remove('d-none'); return; }
    $('stats-content').classList.remove('d-none');
    renderOverview(loaded.summary);
    renderChart(loaded.trends);
    renderRankedAreas('strengths', 'high');
    renderRankedAreas('focus-areas', 'low');
    renderRecommendations(loaded.recommendations);
    renderCategoryTable();
    renderSessions(loaded.sessions);
    $('questions').replaceChildren(...loaded.questions.map(questionElement));
    $('question-count').textContent = `Showing ${loaded.questions.length} of ${loaded.questionsTotal} matching questions`;
  } catch (error) {
    $('loading').classList.add('d-none'); $('error-state').textContent = error.message; $('error-state').classList.remove('d-none');
  }
}

$('recommendation-length').addEventListener('change', () => {
  if (loaded?.recommendations) { renderRecommendations(loaded.recommendations); }
});
$('start-recommendation').addEventListener('click', async () => {
  const button = $('start-recommendation');
  button.disabled = true;
  try {
    const response = await fetch('/api/local/stats/recommendation-practice', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filters: readFilters(), length: Number($('recommendation-length').value) || 10 })
    });
    const result = await response.json();
    if (!response.ok) { throw new Error(result.error || 'Could not build the study session.'); }
    const reader = result.tossupCount && result.bonusCount
      ? 'combined'
      : (result.tossupCount ? 'tossups' : 'bonuses');
    const params = new URLSearchParams({ packetId: result.id });
    if (reader === 'combined') { params.set('studyRecommendation', '1'); }
    window.location.assign(`/play/${reader}/?${params}`);
  } catch (error) {
    window.alert(error.message);
    button.disabled = false;
  }
});

for (const id of filterIds.filter(id => id !== 'date-range')) { $(id).addEventListener('change', () => { saveFilters(); refresh(); }); }
$('date-range').addEventListener('change', () => {
  document.querySelectorAll('.custom-date').forEach(element => element.classList.toggle('d-none', $('date-range').value !== 'custom'));
  saveFilters();
  refresh();
});
$('date-from').addEventListener('change', () => { saveFilters(); refresh(); });
$('date-to').addEventListener('change', () => { saveFilters(); refresh(); });
$('reset-filters').addEventListener('click', () => {
  for (const id of filterIds) {
    const select = $(id);
    if (select.tagName === 'SELECT') { select.value = ['trend-period'].includes(id) ? 'month' : (id === 'date-range' ? 'all' : (id === 'trend-metric' ? 'pointsPerTossup' : '')); } else { select.value = ''; }
  }
  for (const input of document.querySelectorAll('#difficulty-options input')) { input.checked = false; }
  updateDifficultyLabel();
  document.querySelectorAll('.custom-date').forEach(element => element.classList.add('d-none'));
  saveFilters();
  refresh();
});

refresh();
