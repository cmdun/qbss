import CategoryManager from '../../../shared/category-manager.js';
import Player from '../../../shared/Player.js';
import Team from '../../../shared/Team.js';
import SoloTossupBonusRoom from '../../rooms/SoloTossupBonusRoom.js';
import SoloTossupBonusClient from '../../clients/SoloTossupBonusClient.js';
import localHistory from '../../scripts/local-history.js';
import { getDropdownValues } from '../../scripts/utilities/dropdown-checklist.js';
import CategoryModal from '../../scripts/components/CategoryModal.jsx';
import DifficultyDropdown from '../../scripts/components/DifficultyDropdown.jsx';
import { MODE_ENUM } from '../../../shared/constants.js';
import { setYear } from '../year-slider.js';
import initializeWikipediaReader from './wikipedia-reader.js';
import initializeAnkiReader from './anki-reader.js';

const USER_ID = 'user';
const TEAM_ID = USER_ID;
const SETTINGS_KEY = 'local-combined-settings-v1';
let savedSettings = {};
try { savedSettings = JSON.parse(window.localStorage.getItem(SETTINGS_KEY) ?? '{}'); } catch {}
if (!window.localStorage.getItem(SETTINGS_KEY)) {
  const type = new URLSearchParams(window.location.search).get('type');
  const legacyType = type === 'bonuses' ? 'bonus' : 'tossup';
  try {
    const settings = JSON.parse(window.localStorage.getItem(`singleplayer-${legacyType}-settings`) ?? '{}');
    const query = JSON.parse(window.localStorage.getItem(`singleplayer-${legacyType}-query`) ?? '{}');
    savedSettings = { settings, query, categories: query, practiceType: type || 'combined' };
  } catch {}
}
const room = new SoloTossupBonusRoom('', new CategoryManager());
if (savedSettings.settings) { room.settings = { ...room.settings, ...savedSettings.settings }; }
if (savedSettings.query) { room.query = { ...room.query, ...savedSettings.query }; }
const practiceParams = new URLSearchParams(window.location.search);
const practiceType = document.getElementById('practice-type');
room.practiceType = ['tossups', 'bonuses', 'combined'].includes(practiceParams.get('type')) ? practiceParams.get('type') : (savedSettings.practiceType || 'combined');
practiceType.value = room.practiceType;
if (practiceParams.get('studyRecommendation') === '1') { room.settings.enableBonuses = true; }
const practiceCategory = practiceParams.get('statsCategory');
const practiceDifficulties = practiceParams.get('statsDifficulties');
if (practiceCategory) {
  room.categoryManager.import({
    categories: [practiceCategory],
    subcategories: practiceParams.get('statsSubcategory') ? [practiceParams.get('statsSubcategory')] : []
  });
} else if (savedSettings.categories) { room.categoryManager.import(savedSettings.categories); }
if (practiceParams.has('statsDifficulties')) {
  room.query.difficulties = practiceDifficulties === 'all'
    ? []
    : practiceDifficulties.split(',').map(Number).filter(value => Number.isInteger(value) && value >= 0 && value <= 10);
}
room.players[USER_ID] = new Player(USER_ID);
room.players[USER_ID].teamId = TEAM_ID;
room.teams[TEAM_ID] = new Team(TEAM_ID);
const socket = {
  sendToServer: message => {
    const result = room.message({ userId: USER_ID, username: room.players[USER_ID].username }, message);
    Promise.resolve(result).finally(saveLocalSettings);
    return result;
  },
  send: message => client.onmessage(message)
};
const client = new SoloTossupBonusClient(room, USER_ID, socket);
room.sockets[USER_ID] = socket;
localHistory.start({ tossups: 'Tossups', bonuses: 'Bonuses', combined: 'Tossups + Bonuses' }[room.practiceType]);

function saveLocalSettings () {
  window.localStorage.setItem(SETTINGS_KEY, JSON.stringify({
    settings: room.settings,
    query: room.query,
    practiceType: room.practiceType,
    categories: room.categoryManager.export()
  }));
}

function updatePracticeType () {
  room.practiceType = practiceType.value;
  document.getElementById('toggle-enable-bonuses').closest('.form-check').classList.toggle('d-none', room.practiceType !== 'combined');
  saveLocalSettings();
}
practiceType.addEventListener('change', updatePracticeType);
updatePracticeType();

document.getElementById('toggle-enable-bonuses').nextElementSibling.textContent = 'Earn bonuses';
for (const [id, property] of Object.entries({
  'toggle-enable-bonuses': 'enableBonuses',
  'toggle-powermark-only': 'powermarkOnly',
  'toggle-standard-only': 'standardOnly',
  'toggle-three-part-bonuses': 'threePartBonuses',
  'toggle-rebuzz': 'rebuzz',
  'toggle-stop-on-power': 'stopOnPower',
  'toggle-skip': 'skip',
  'toggle-timer': 'timer'
})) {
  const input = document.getElementById(id);
  if (input) { input.checked = Boolean(room.settings[property] ?? room.query[property]); }
}
document.getElementById('type-to-answer').checked = room.settings.typeToAnswer;
document.getElementById('toggle-read-bonuses-like-tossups').checked = Boolean(room.settings.readBonusLikeATossup);
document.getElementById('type-to-answer').addEventListener('change', function () {
  room.settings.typeToAnswer = this.checked;
  saveLocalSettings();
});
document.getElementById('toggle-read-bonuses-like-tossups').addEventListener('change', function () {
  socket.sendToServer({ type: 'toggle-read-bonuses-like-tossups', readBonusLikeATossup: this.checked });
});
document.getElementById('toggle-correct').addEventListener('click', () => {
  socket.sendToServer({ type: 'toggle-correct', targetUserId: USER_ID });
});
document.getElementById('reading-speed').value = room.settings.readingSpeed;
document.getElementById('reading-speed-display').textContent = room.settings.readingSpeed;
setYear(room.query.minYear, 'min-year');
setYear(room.query.maxYear, 'max-year');
for (const id of ['toggle-controlled', 'toggle-lock', 'toggle-login-required', 'toggle-public', 'toggle-distraction-free-mode', 'private-chat-warning']) {
  document.getElementById(id)?.closest('.mb-2, .form-check, .input-group')?.classList.add('d-none');
}

document.getElementById('local-packet-input').addEventListener('change', async function () {
  const file = this.files[0];
  if (!file) { return; }
  try {
    const packet = JSON.parse(await file.text());
    socket.sendToServer({ type: 'set-mode', mode: MODE_ENUM.LOCAL });
    socket.sendToServer({ type: 'upload-local-packet', filename: file.name, packet });
  } catch (error) {
    window.alert(`Could not load packet: ${error.message}`);
  }
});

document.getElementById('toggle-randomize-order').addEventListener('click', function () {
  socket.sendToServer({ type: 'toggle-randomize-order', randomizeOrder: this.checked });
});

ReactDOM.createRoot(document.getElementById('category-modal-root')).render(
  <CategoryModal
    categoryManager={room.categoryManager}
    onClose={() => socket.sendToServer({ type: 'set-categories', ...room.categoryManager.export() })}
  />
);

ReactDOM.createRoot(document.getElementById('difficulty-dropdown-root')).render(
  <DifficultyDropdown
    startingDifficulties={room.query.difficulties ?? []}
    onChange={() => socket.sendToServer({ type: 'set-difficulties', difficulties: getDropdownValues('difficulties') })}
  />
);

const databaseDrawer = document.getElementById('database-drawer');
const databaseToggle = document.getElementById('toggle-database');
const settingsDrawer = document.getElementById('settings');
const settingsToggle = document.getElementById('toggle-settings');
const wikipediaDrawer = document.getElementById('wikipedia-drawer');
const wikipediaToggle = document.getElementById('toggle-wikipedia');
const ankiDrawer = document.getElementById('anki-drawer');
const ankiToggle = document.getElementById('toggle-anki');
const readerToggle = document.getElementById('toggle-reader');
const readerContent = document.getElementById('content');
const swapWorkspaceSides = document.getElementById('swap-workspace-sides');
swapWorkspaceSides.checked = window.localStorage.getItem('qbss-swap-workspace-sides') === 'true';
document.body.classList.toggle('workspace-swapped', swapWorkspaceSides.checked);
swapWorkspaceSides.addEventListener('change', () => {
  window.localStorage.setItem('qbss-swap-workspace-sides', String(swapWorkspaceSides.checked));
  document.body.classList.toggle('workspace-swapped', swapWorkspaceSides.checked);
});
const ankiReader = initializeAnkiReader();
const databaseFrame = databaseDrawer.querySelector('iframe');
initializeWikipediaReader();

function hasOpenPanel () {
  return ['settings', 'wikipedia', 'database', 'anki'].some(name => document.body.classList.contains(`${name}-drawer-open`));
}
function setReaderHidden (hidden) {
  if (hidden && !hasOpenPanel()) return;
  if (hidden && !document.body.classList.contains('reader-hidden')) {
    const pause = document.getElementById('pause');
    if (!pause.disabled && pause.querySelector('.bi-pause-fill')) pause.click();
  }
  document.body.classList.toggle('reader-hidden', hidden);
  readerContent.inert = hidden;
  readerContent.setAttribute('aria-hidden', String(hidden));
  readerToggle.setAttribute('aria-pressed', String(!hidden));
  readerToggle.classList.toggle('btn-primary', !hidden);
  readerToggle.classList.toggle('btn-outline-secondary', hidden);
  readerToggle.title = hidden ? 'Show reader · Shortcut: R' : hasOpenPanel() ? 'Hide reader · Shortcut: R' : 'Open a study panel to hide the reader';
}
function syncReaderVisibility () {
  if (!hasOpenPanel() && document.body.classList.contains('reader-hidden')) setReaderHidden(false);
  readerToggle.title = document.body.classList.contains('reader-hidden') ? 'Show reader · Shortcut: R' : hasOpenPanel() ? 'Hide reader · Shortcut: R' : 'Open a study panel to hide the reader';
}
setReaderHidden(false);

new window.MutationObserver(() => {
  const theme = document.documentElement.getAttribute('data-bs-theme');
  databaseFrame.contentDocument?.documentElement.setAttribute('data-bs-theme', theme);
}).observe(document.documentElement, { attributes: true, attributeFilter: ['data-bs-theme'] });

databaseFrame.addEventListener('load', () => {
  databaseFrame.contentDocument.documentElement.setAttribute('data-bs-theme', document.documentElement.getAttribute('data-bs-theme'));
});

function setDatabaseDrawerOpen (open) {
  document.body.classList.toggle('database-drawer-open', open);
  databaseToggle.setAttribute('aria-expanded', String(open));
  databaseDrawer.setAttribute('aria-hidden', String(!open));
  databaseDrawer.inert = !open;
  if (open && document.body.classList.contains('settings-drawer-open')) {
    document.body.classList.remove('settings-drawer-open');
    settingsDrawer.setAttribute('aria-hidden', 'true');
    settingsDrawer.inert = true;
    settingsToggle.setAttribute('aria-expanded', 'false');
  }
  syncReaderVisibility();
}

function setSettingsDrawerOpen (open) {
  document.body.classList.toggle('settings-drawer-open', open);
  settingsDrawer.setAttribute('aria-hidden', String(!open));
  settingsDrawer.inert = !open;
  settingsToggle.setAttribute('aria-expanded', String(open));
  if (open) {
    setAnkiDrawerOpen(false);
    document.body.classList.remove('wikipedia-drawer-open');
    wikipediaDrawer.setAttribute('aria-hidden', 'true');
    wikipediaDrawer.inert = true;
    wikipediaToggle.setAttribute('aria-expanded', 'false');
    document.body.classList.remove('database-drawer-open');
    databaseDrawer.setAttribute('aria-hidden', 'true');
    databaseDrawer.inert = true;
    databaseToggle.setAttribute('aria-expanded', 'false');
  }
  syncReaderVisibility();
}

function setAnkiDrawerOpen (open) {
  document.body.classList.toggle('anki-drawer-open', open);
  ankiDrawer.setAttribute('aria-hidden', String(!open));
  ankiDrawer.inert = !open;
  ankiToggle.setAttribute('aria-expanded', String(open));
  if (open) {
    if (document.body.classList.contains('settings-drawer-open')) { setSettingsDrawerOpen(false); }
    ankiReader.connect();
  }
  syncReaderVisibility();
}

function setWikipediaDrawerOpen (open) {
  document.body.classList.toggle('wikipedia-drawer-open', open);
  wikipediaDrawer.setAttribute('aria-hidden', String(!open));
  wikipediaDrawer.inert = !open;
  wikipediaToggle.setAttribute('aria-expanded', String(open));
  if (open && document.body.classList.contains('settings-drawer-open')) {
    document.body.classList.remove('settings-drawer-open');
    settingsDrawer.setAttribute('aria-hidden', 'true');
    settingsDrawer.inert = true;
    settingsToggle.setAttribute('aria-expanded', 'false');
  }
  syncReaderVisibility();
}

settingsToggle.addEventListener('click', () => {
  setSettingsDrawerOpen(!document.body.classList.contains('settings-drawer-open'));
});

databaseToggle.addEventListener('click', () => {
  setDatabaseDrawerOpen(!document.body.classList.contains('database-drawer-open'));
});
wikipediaToggle.addEventListener('click', () => {
  setWikipediaDrawerOpen(!document.body.classList.contains('wikipedia-drawer-open'));
});
ankiToggle.addEventListener('click', () => {
  setAnkiDrawerOpen(!document.body.classList.contains('anki-drawer-open'));
});
readerToggle.addEventListener('click', () => setReaderHidden(!document.body.classList.contains('reader-hidden')));
window.addEventListener('message', event => {
  if (event.origin !== window.location.origin || event.source !== databaseFrame.contentWindow) { return; }
  if (event.data?.type === 'qbreader-toggle-database') {
    setDatabaseDrawerOpen(!document.body.classList.contains('database-drawer-open'));
  } else if (event.data?.type === 'qbreader-toggle-anki') {
    setAnkiDrawerOpen(!document.body.classList.contains('anki-drawer-open'));
  }
});

const packetId = new URLSearchParams(window.location.search).get('packetId');
if (packetId) {
  fetch(`/api/local/packets/${encodeURIComponent(packetId)}`)
    .then(response => response.ok ? response.json() : Promise.reject(new Error('Packet not found')))
    .then(packet => {
      socket.sendToServer({ type: 'set-mode', mode: 'local packet' });
      socket.sendToServer({ type: 'upload-local-packet', filename: packet.name, packet });
    })
    .catch(error => window.alert(`Could not load packet: ${error.message}`));
}

document.addEventListener('keydown', event => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f' && document.body.classList.contains('database-drawer-open')) {
    event.preventDefault();
    databaseFrame.contentWindow.postMessage({ type: 'qbss-find' }, window.location.origin);
    return;
  }
  if (event.key === 'Escape' && (document.body.classList.contains('database-drawer-open') || document.body.classList.contains('settings-drawer-open') || document.body.classList.contains('wikipedia-drawer-open') || document.body.classList.contains('anki-drawer-open'))) {
    if (document.body.classList.contains('database-drawer-open')) { setDatabaseDrawerOpen(false); }
    if (document.body.classList.contains('settings-drawer-open')) { setSettingsDrawerOpen(false); }
    if (document.body.classList.contains('wikipedia-drawer-open')) { setWikipediaDrawerOpen(false); }
    if (document.body.classList.contains('anki-drawer-open')) { setAnkiDrawerOpen(false); }
    event.preventDefault();
    return;
  }
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName) || document.activeElement.isContentEditable) { return; }
  if (event.metaKey || event.ctrlKey || event.altKey) { return; }
  if (document.body.classList.contains('reader-hidden') && [' ', 'n', 's', 'p', 't', 'y', 'k', '0', '1', '2', '3', '4'].includes(event.key.toLowerCase())) return;
  const partKey = event.key === '0' ? String(room.pointsPerPart.length) : event.key;
  if (['0', '1', '2', '3', '4'].includes(event.key) && document.getElementById(`checkbox-${partKey}`)) {
    document.getElementById(`checkbox-${partKey}`).click();
    event.preventDefault();
    return;
  }
  switch (event.key?.toLowerCase()) {
    case ' ':
      if (!document.getElementById('reveal').disabled) { document.getElementById('reveal').click(); } else { document.getElementById('buzz').click(); }
      event.preventDefault();
      break;
    case 'e': document.getElementById('toggle-settings').click(); break;
    case 'd': databaseToggle.click(); event.preventDefault(); break;
    case 'w': wikipediaToggle.click(); event.preventDefault(); break;
    case 'a': ankiToggle.click(); event.preventDefault(); break;
    case 'r': setReaderHidden(!document.body.classList.contains('reader-hidden')); event.preventDefault(); break;
    case 't': document.querySelector('#room-history .star-tossup, #room-history .star-bonus')?.click(); event.preventDefault(); break;
    case 'y': {
      const question = room.currentQuestionType === 1 ? room.bonus : room.tossup;
      if (question?._id) { navigator.clipboard.writeText(String(question._id)); }
      break;
    }
    case 'k': document.getElementsByClassName('card-header-clickable')[0]?.click(); break;
    case 'n':
    case 's': document.getElementById('next').click(); break;
    case 'p': document.getElementById('pause').click(); break;
  }
});
