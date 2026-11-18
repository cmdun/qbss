const manager = window.qbTheme;
const choice = document.getElementById('theme-choice');
const editor = document.getElementById('theme-editor');
const nameInput = document.getElementById('theme-name');
const roleFields = document.getElementById('theme-role-fields');
const message = document.getElementById('theme-message');
const labels = { background: 'Page background', panel: 'Panels and navigation', selection: 'Selected background', border: 'Borders', muted: 'Muted text', text: 'Main text', strong: 'Headings', danger: 'Incorrect and danger', warning: 'Warning', highlight: 'Highlights', success: 'Correct and success', info: 'Information', accent: 'Buttons and links', purple: 'Link hover', brown: 'Extra accent' };
const presets = {
  nord: { name: 'Nord', palette: ['2e3440', '3b4252', '434c5e', '4c566a', 'd8dee9', 'e5e9f0', 'eceff4', 'ffffff', 'bf616a', 'd08770', 'ebcb8b', 'a3be8c', '88c0d0', '81a1c1', 'b48ead', '8fbcbb'] },
  solarized: { name: 'Solarized Light', palette: ['fdf6e3', 'eee8d5', 'e8e0cc', '93a1a1', '657b83', '586e75', '073642', '002b36', 'dc322f', 'cb4b16', 'b58900', '859900', '2aa198', '268bd2', '6c71c4', 'd33682'] }
};
let preview = null;
let applied = false;
const savedSelection = () => localStorage.getItem('color-theme') || 'auto';
const normalizedKey = index => `base${index.toString(16).toUpperCase().padStart(2, '0')}`;

function preset (id) {
  const selected = presets[id];
  return { version: 1, name: selected.name, palette: Object.fromEntries(selected.palette.map((color, index) => [normalizedKey(index), `#${color}`])), roles: {} };
}

function parseProfile (raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { throw new Error('This file does not contain a theme.'); }
  const source = raw.palette && typeof raw.palette === 'object' ? raw.palette : raw;
  const entries = Object.fromEntries(Object.entries(source).map(([key, value]) => [key.toLowerCase(), value]));
  const palette = {};
  for (let index = 0; index < 16; index++) {
    const key = normalizedKey(index);
    const value = entries[key.toLowerCase()];
    if (typeof value !== 'string' || !/^#?[0-9a-f]{6}$/i.test(value)) { throw new Error(`The Base16 color ${key} is missing or invalid. Use six-digit hex colors.`); }
    palette[key] = '#' + value.replace(/^#/, '').toLowerCase();
  }
  const roles = {};
  if (raw.roles !== undefined && (!raw.roles || typeof raw.roles !== 'object' || Array.isArray(raw.roles))) { throw new Error('Theme color roles are invalid.'); }
  for (const role of Object.keys(manager.roleMap)) {
    if (raw.roles?.[role] !== undefined) {
      if (typeof raw.roles[role] !== 'string' || !/^#[0-9a-f]{6}$/i.test(raw.roles[role])) { throw new Error(`Invalid color for ${role}.`); }
      roles[role] = raw.roles[role].toLowerCase();
    }
  }
  return { version: 1, name: String(raw.name || raw.scheme || 'Imported theme').slice(0, 100), palette, roles };
}

function showEditor () {
  editor.classList.toggle('d-none', !preview);
  if (!preview) { return; }
  nameInput.value = preview.name;
  roleFields.replaceChildren();
  for (const [role, label] of Object.entries(labels)) {
    const group = document.createElement('div');
    group.className = 'col-sm-6 col-lg-4';
    const wrapper = document.createElement('label');
    wrapper.className = 'd-flex align-items-center gap-2 border rounded p-2';
    const input = document.createElement('input');
    input.type = 'color';
    input.className = 'form-control form-control-color flex-shrink-0';
    input.value = preview.roles[role] || preview.palette[manager.roleMap[role]];
    input.addEventListener('input', () => { preview.roles[role] = input.value; manager.apply(preview); message.textContent = 'Previewing changes.'; });
    wrapper.append(input, document.createTextNode(label));
    group.append(wrapper);
    roleFields.append(group);
  }
}

function selectTheme (value) {
  message.textContent = '';
  if (presets[value]) { preview = preset(value); }
  else if (value === 'custom') {
    preview = manager.stored();
    if (!preview) { message.textContent = 'Import a Base16 palette or choose a built-in palette first.'; }
  } else { preview = null; }
  showEditor();
  if (preview) { manager.apply(preview); } else {
    manager.applySelection(value);
  }
}

choice.value = ['auto', 'light', 'night', 'custom'].includes(savedSelection()) ? savedSelection() : 'auto';
if (choice.value === 'custom' && manager.stored()) { preview = manager.stored(); showEditor(); }
choice.addEventListener('change', () => selectTheme(choice.value));
nameInput.addEventListener('input', () => { if (preview) { preview.name = nameInput.value; } });
document.getElementById('theme-import').addEventListener('change', async event => {
  const file = event.target.files[0];
  if (!file) { return; }
  try {
    if (file.size > 1024 * 1024) { throw new Error('Theme files must be smaller than 1 MB.'); }
    const contents = await file.text();
    const parsed = /\.json$/i.test(file.name) ? JSON.parse(contents) : window.jsyaml.load(contents, { schema: window.jsyaml.JSON_SCHEMA });
    preview = parseProfile(parsed);
    choice.value = 'custom';
    showEditor();
    manager.apply(preview);
    message.textContent = `Previewing ${preview.name}. Select Apply theme to save it.`;
  } catch (error) { message.textContent = `Could not import theme: ${error.message}`; }
  event.target.value = '';
});
document.getElementById('theme-apply').addEventListener('click', () => {
  if (choice.value === 'custom' && !preview) { message.textContent = 'Choose or import a theme first.'; return; }
  if (preview) {
    preview.name = nameInput.value.trim() || 'Custom theme';
    localStorage.setItem(manager.key, JSON.stringify(preview));
    localStorage.setItem('color-theme', 'custom');
    choice.value = 'custom';
    manager.apply(preview);
  } else {
    localStorage.setItem('color-theme', choice.value);
    selectTheme(choice.value);
  }
  applied = true;
  message.textContent = 'Theme applied.';
  window.dispatchEvent(new Event('qb-theme-changed'));
});
document.getElementById('theme-revert').addEventListener('click', () => {
  choice.value = savedSelection();
  selectTheme(choice.value);
  message.textContent = 'Restored the saved theme.';
});
document.getElementById('theme-export').addEventListener('click', () => {
  if (!preview) { message.textContent = 'Choose a custom palette to export.'; return; }
  preview.name = nameInput.value.trim() || 'Custom theme';
  const url = URL.createObjectURL(new Blob([JSON.stringify(preview, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `${preview.name.replace(/[^a-z0-9_-]+/gi, '-').replace(/^-|-$/g, '') || 'qbss-theme'}.json`;
  link.click();
  URL.revokeObjectURL(url);
});
window.addEventListener('pagehide', () => { if (!applied && savedSelection() === 'custom') { manager.applyStored(); } });
