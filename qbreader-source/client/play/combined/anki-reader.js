export default function initializeAnkiReader () {
  const deck = document.getElementById('anki-deck');
  const model = document.getElementById('anki-model');
  const fields = document.getElementById('anki-fields');
  const tags = document.getElementById('anki-tags');
  const status = document.getElementById('anki-status');
  const setup = document.getElementById('anki-setup');
  const connectionControls = document.getElementById('anki-connection-controls');
  const add = document.getElementById('anki-add');
  const open = document.getElementById('anki-open');
  const key = 'local-anki-draft-v1';
  let draft = {};
  let fieldRequest = 0;
  let activeField = null;
  let selectedText = '';
  let connected = false;
  try { draft = JSON.parse(localStorage.getItem(key) || '{}'); } catch {}

  async function call (action, params = {}) {
    const response = await fetch('/api/local/anki', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, params }) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(data.error || 'Anki could not complete the request.');
      error.connectionLost = response.status === 503;
      throw error;
    }
    return data.result;
  }

  function save () {
    const values = {};
    fields.querySelectorAll('[data-field]').forEach(input => { values[input.dataset.field] = input.value; });
    const drafts = { ...(draft.drafts || {}) };
    const renderedModel = fields.dataset.model;
    if (renderedModel) { drafts[renderedModel] = values; }
    draft = { deck: deck.value, model: model.value, drafts, tags: tags.value };
    localStorage.setItem(key, JSON.stringify(draft));
  }

  function setOptions (select, values, selected) {
    select.replaceChildren(...values.map(value => new Option(value, value)));
    if (values.includes(selected)) { select.value = selected; }
  }

  async function loadFields (preserve = true) {
    if (!model.value) { fields.replaceChildren(); return; }
    const request = ++fieldRequest;
    const names = await call('modelFieldNames', { modelName: model.value });
    if (request !== fieldRequest) { return; }
    fields.replaceChildren();
    fields.dataset.model = model.value;
    for (const [index, name] of names.entries()) {
      const label = document.createElement('label');
      label.className = 'form-label mb-1';
      label.htmlFor = `anki-field-${index}`;
      label.textContent = name;
      const input = document.createElement('textarea');
      input.id = label.htmlFor;
      input.dataset.field = name;
      input.className = 'form-control mb-2';
      input.rows = 1;
      input.value = draft.drafts?.[model.value]?.[name] || (preserve && draft.model === model.value ? (draft.fields?.[name] || '') : '');
      input.addEventListener('input', save);
      input.addEventListener('focus', () => { activeField = input; });
      fields.append(label, input);
    }
    save();
  }

  async function connect () {
    status.textContent = 'Connecting to Anki…';
    connectionControls.classList.add('d-none');
    setup.classList.add('d-none');
    add.disabled = open.disabled = true;
    try {
      const [decks, models] = await Promise.all([call('deckNames'), call('modelNames')]);
      setOptions(deck, decks, draft.deck);
      setOptions(model, models, draft.model);
      tags.value = draft.tags || '';
      await loadFields();
      connected = true;
      add.disabled = open.disabled = !deck.value || !model.value;
      status.textContent = add.disabled ? 'Create a deck and note type in Anki first.' : '';
    } catch (error) {
      showDisconnected();
    }
  }

  function showDisconnected () {
    connected = false;
    add.disabled = open.disabled = true;
    connectionControls.classList.remove('d-none');
    status.textContent = 'Anki is not connected. Open Anki, then select Reconnect.';
    setup.classList.remove('d-none');
  }

  setInterval(async () => {
    if (!connected || document.getElementById('anki-drawer').inert || document.hidden) { return; }
    try { await call('version'); } catch { showDisconnected(); }
  }, 15000);

  function note () {
    const values = {};
    fields.querySelectorAll('[data-field]').forEach(input => { values[input.dataset.field] = input.value.replace(/\n/g, '<br>'); });
    return { deckName: deck.value, modelName: model.value, fields: values, tags: tags.value.trim().split(/\s+/).filter(Boolean), options: { allowDuplicate: false } };
  }

  document.getElementById('anki-refresh').addEventListener('click', connect);
  document.addEventListener('selectionchange', () => {
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed && selection.anchorNode && document.getElementById('wikipedia-drawer').contains(selection.anchorNode)) {
      selectedText = selection.toString();
    }
  });
  document.getElementById('anki-insert-selection').addEventListener('click', () => {
    const databaseSelection = document.querySelector('#database-drawer iframe')?.contentWindow?.getSelection()?.toString();
    const text = databaseSelection || selectedText;
    const input = activeField || fields.querySelector('textarea');
    if (!input || !text) { status.textContent = 'Select text in Wikipedia or Database, then choose a card field.'; return; }
    input.setRangeText(text, input.selectionStart, input.selectionEnd, 'end');
    input.focus();
    save();
  });
  document.querySelectorAll('[data-anki-format]').forEach(button => button.addEventListener('click', () => {
    const input = activeField || fields.querySelector('textarea');
    if (!input) { return; }
    const start = input.selectionStart;
    const end = input.selectionEnd;
    const selection = input.value.slice(start, end);
    const format = button.dataset.ankiFormat;
    const replacement = format === 'cloze' ? `{{c1::${selection}}}` : `<${format}>${selection}</${format}>`;
    input.setRangeText(replacement, start, end, 'select');
    input.focus();
    save();
  }));
  deck.addEventListener('change', save);
  tags.addEventListener('input', save);
  model.addEventListener('change', async () => {
    save();
    try { await loadFields(false); } catch (error) { status.textContent = error.message; }
  });
  document.getElementById('anki-form').addEventListener('submit', async event => {
    event.preventDefault();
    add.disabled = true;
    try {
      const current = note();
      const [allowed] = await call('canAddNotes', { notes: [current] });
      if (!allowed) { throw new Error('Anki rejected this note. Check for a duplicate or an empty first field.'); }
      await call('addNote', { note: current });
      fields.querySelectorAll('[data-field]').forEach(input => { input.value = ''; });
      save();
      status.textContent = 'Added to Anki.';
      fields.querySelector('textarea')?.focus();
    } catch (error) {
      if (error.connectionLost || error instanceof TypeError) { showDisconnected(); } else { status.textContent = error.message; }
    } finally { add.disabled = !connected; }
  });
  document.getElementById('anki-drawer').addEventListener('keydown', event => {
    const modifier = navigator.platform.toUpperCase().includes('MAC') ? event.metaKey : event.ctrlKey;
    if (modifier && !event.altKey && !event.isComposing && ['b', 'i', 'u'].includes(event.key.toLowerCase()) && event.target.matches('textarea[data-field]')) {
      event.preventDefault();
      document.querySelector(`[data-anki-format="${event.key.toLowerCase()}"]`)?.click();
      return;
    }
    if (event.key === 'Enter' && modifier && !event.repeat && !event.isComposing) {
      event.preventDefault();
      if (!add.disabled) { document.getElementById('anki-form').requestSubmit(); }
    }
  });
  open.addEventListener('click', async () => {
    try { await call('guiAddCards', { note: note() }); status.textContent = 'Opened in Anki. Finish and add the card there.'; } catch (error) {
      if (error.connectionLost || error instanceof TypeError) { showDisconnected(); } else { status.textContent = error.message; }
    }
  });
  return { connect };
}
