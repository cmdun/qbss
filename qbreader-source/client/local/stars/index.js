const elements = {
  search: document.getElementById('stars-search'),
  set: document.getElementById('stars-set'),
  category: document.getElementById('stars-category'),
  difficulty: document.getElementById('stars-difficulty'),
  count: document.getElementById('stars-count'),
  list: document.getElementById('stars-list'),
  pagination: document.getElementById('stars-pagination'),
  play: document.getElementById('stars-play'),
  clear: document.getElementById('stars-clear')
};
const pageSize = 20;
const questions = { tossups: [], bonuses: [] };
let type = 'tossups';
let page = 1;
let filtered = [];

function options (element, values, label) {
  const previous = element.value;
  element.replaceChildren(new Option(label, ''));
  for (const value of values) { element.add(new Option(value, value)); }
  element.value = values.includes(previous) ? previous : '';
}

function refreshOptions () {
  const current = questions[type];
  const unique = values => [...new Set(values.filter(value => value !== undefined && value !== null && value !== '').map(String))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  options(elements.set, unique(current.map(question => question.set?.name)), 'All sets');
  options(elements.category, unique(current.map(question => question.category)), 'All categories');
  options(elements.difficulty, unique(current.map(question => question.difficulty)), 'All difficulties');
}

function makeCard (question) {
  const card = document.createElement('article');
  card.className = 'card mb-2';
  const header = document.createElement('div');
  header.className = 'card-header d-flex align-items-center gap-2';
  const title = document.createElement('strong');
  title.className = 'me-auto';
  title.textContent = [question.set?.name, question.category, question.subcategory, question.difficulty].filter(value => value !== undefined && value !== null && value !== '').join(' | ');
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'btn btn-sm btn-outline-primary';
  remove.setAttribute('aria-label', 'Remove star');
  remove.title = 'Remove star';
  remove.innerHTML = '<i class="bi bi-star-fill" aria-hidden="true"></i>';
  remove.addEventListener('click', async () => {
    const kind = type === 'tossups' ? 'tossup' : 'bonus';
    const response = await fetch(`/auth/stars/unstar-${kind}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ [`${kind}_id`]: question._id })
    });
    if (!response.ok) { window.alert('Could not remove the star.'); return; }
    questions[type] = questions[type].filter(item => item._id !== question._id);
    refreshOptions();
    render();
  });
  header.append(title, remove);
  const body = document.createElement('div');
  body.className = 'card-body';
  const addHtml = (html, tag = 'div') => {
    const block = document.createElement(tag);
    block.innerHTML = window.DOMPurify.sanitize(html || '');
    body.append(block);
  };
  if (type === 'tossups') {
    addHtml(question.question);
    body.append(document.createElement('hr'));
    addHtml(`<b>ANSWER:</b> ${question.formatted_answer || question.answer || ''}`);
  } else {
    addHtml(question.leadin, 'p');
    (question.parts || []).forEach((part, index) => {
      body.append(document.createElement('hr'));
      addHtml(`[${Number(question.values?.[index] ?? 10)}] ${part}`, 'p');
      addHtml(`<b>ANSWER:</b> ${question.answers?.[index] || ''}`);
    });
  }
  const footer = document.createElement('div');
  footer.className = 'card-footer text-muted small';
  footer.textContent = `Packet ${question.packet?.name || question.packet?.number || '—'} · Question ${question.number ?? '—'}`;
  card.append(header, body, footer);
  return card;
}

function render () {
  const query = elements.search.value.trim().toLocaleLowerCase();
  filtered = questions[type].filter(question => {
    const text = [question.question, question.answer, question.leadin, ...(question.parts || []), ...(question.answers || [])].join(' ').toLocaleLowerCase();
    return (!query || text.includes(query)) && (!elements.set.value || question.set?.name === elements.set.value) &&
      (!elements.category.value || question.category === elements.category.value) &&
      (!elements.difficulty.value || String(question.difficulty) === elements.difficulty.value);
  });
  const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
  page = Math.min(page, pages);
  elements.count.textContent = `${filtered.length} ${type} shown`;
  elements.play.disabled = filtered.length === 0;
  elements.clear.disabled = questions[type].length === 0;
  elements.clear.textContent = `Clear starred ${type}`;
  elements.list.replaceChildren(...filtered.slice((page - 1) * pageSize, page * pageSize).map(makeCard));
  if (!filtered.length) {
    const empty = document.createElement('p');
    empty.className = 'text-muted';
    empty.textContent = questions[type].length ? 'No starred questions match these filters.' : `You have no starred ${type}.`;
    elements.list.append(empty);
  }
  elements.pagination.replaceChildren();
  if (pages > 1) {
    const previous = document.createElement('button');
    previous.className = 'btn btn-outline-secondary btn-sm me-2';
    previous.textContent = 'Previous';
    previous.disabled = page === 1;
    previous.onclick = () => { page--; render(); elements.list.scrollIntoView(); };
    const next = document.createElement('button');
    next.className = 'btn btn-outline-secondary btn-sm ms-2';
    next.textContent = 'Next';
    next.disabled = page === pages;
    next.onclick = () => { page++; render(); elements.list.scrollIntoView(); };
    elements.pagination.append(previous, document.createTextNode(`Page ${page} of ${pages}`), next);
  }
}

for (const input of [elements.search, elements.set, elements.category, elements.difficulty]) {
  input.addEventListener(input === elements.search ? 'input' : 'change', () => { page = 1; render(); });
}
for (const kind of ['tossups', 'bonuses']) {
  document.getElementById(`show-${kind}`).addEventListener('click', () => {
    type = kind;
    page = 1;
    for (const buttonType of ['tossups', 'bonuses']) {
      const button = document.getElementById(`show-${buttonType}`);
      button.className = `btn ${buttonType === type ? 'btn-primary' : 'btn-outline-primary'}`;
      button.setAttribute('aria-pressed', String(buttonType === type));
    }
    refreshOptions();
    render();
  });
}

elements.play.addEventListener('click', async () => {
  elements.play.disabled = true;
  try {
    const response = await fetch('/api/local/stars/practice', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ questionType: type === 'tossups' ? 'tossup' : 'bonus', ids: filtered.map(question => question._id) }) });
    if (!response.ok) { throw new Error('Could not prepare practice.'); }
    const saved = await response.json();
    window.location.assign(`/play/combined/?type=${type}&packetId=${encodeURIComponent(saved.id)}`);
  } catch (error) {
    elements.play.disabled = false;
    window.alert(error.message);
  }
});

let clearType;
elements.clear.addEventListener('click', () => {
  clearType = type;
  document.getElementById('stars-clear-title').textContent = `Clear starred ${clearType}?`;
  document.getElementById('stars-clear-message').textContent = `Remove all ${questions[clearType].length} starred ${clearType}, including those hidden by filters? This cannot be undone.`;
  bootstrap.Modal.getOrCreateInstance(document.getElementById('stars-clear-modal')).show();
});
document.getElementById('stars-clear-confirm').addEventListener('click', async function () {
  this.disabled = true;
  try {
    const kind = clearType === 'tossups' ? 'tossup' : 'bonus';
    const response = await fetch(`/auth/stars/clear-${kind}-stars`, { method: 'DELETE' });
    if (!response.ok) { throw new Error('Could not clear starred questions.'); }
    questions[clearType] = [];
    bootstrap.Modal.getInstance(document.getElementById('stars-clear-modal')).hide();
    refreshOptions();
    render();
  } catch (error) {
    window.alert(error.message);
  } finally {
    this.disabled = false;
  }
});

try {
  const responses = await Promise.all(['tossups', 'bonuses'].map(kind => fetch(`/auth/stars/${kind}`)));
  const loaded = await Promise.all(responses.map(response => response.ok ? response.json() : null));
  [questions.tossups, questions.bonuses] = loaded.map(value => Array.isArray(value) ? value : []);
  refreshOptions();
  render();
  if (loaded.some(value => value === null)) {
    elements.count.textContent += ' · Some starred questions could not be loaded; restart the preview and try again.';
  }
} catch (error) {
  elements.count.textContent = error.message;
}
