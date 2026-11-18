import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, shell, utilityProcess } from 'electron';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { validateBackupFolder } from '../local/import-backup.js';

const APP_URL = 'http://127.0.0.1:4173/';

app.setName('QBSS');
// Keep Chromium's prefers-color-scheme query tied to Windows/macOS system mode.
nativeTheme.themeSource = 'system';
// Move forward from the legacy Local QBReader data folder while preserving
// existing preferences, database selection, stars, and practice history.
const appDataDirectory = app.getPath('appData');
const legacyUserDataDirectory = path.join(appDataDirectory, 'Local QBReader');
const qbssUserDataDirectory = path.join(appDataDirectory, 'QBSS');
let userDataDirectory = qbssUserDataDirectory;
if (!existsSync(qbssUserDataDirectory) && existsSync(legacyUserDataDirectory)) {
  try {
    renameSync(legacyUserDataDirectory, qbssUserDataDirectory);
  } catch {
    // If the OS prevents the same-volume rename, keep using the existing
    // directory instead of duplicating a potentially large question database.
    userDataDirectory = legacyUserDataDirectory;
  }
}
app.setPath('userData', userDataDirectory);
Menu.setApplicationMenu(Menu.buildFromTemplate([
  {
    label: 'QBSS',
    submenu: [
      { role: 'about', label: 'About QBSS' },
      { type: 'separator' },
      { role: 'quit', label: 'Quit QBSS' }
    ]
  },
  {
    label: 'Edit',
    submenu: [
      { role: 'undo' },
      { role: 'redo' },
      { type: 'separator' },
      { role: 'cut' },
      { role: 'copy' },
      { role: 'paste' },
      { role: 'selectAll' }
    ]
  },
  { role: 'windowMenu' }
]));

let mainWindow;
let localServer;
let isShuttingDown = false;

async function checkForUpdates () {
  if (!app.isPackaged) return;
  if (process.platform === 'darwin') {
    try {
      const response = await fetch('https://api.github.com/repos/cmdun/qbss/releases?per_page=30', {
        headers: { 'User-Agent': 'QBSS', Accept: 'application/vnd.github+json' },
        signal: AbortSignal.timeout(10000)
      });
      if (!response.ok) throw new Error(`GitHub returned ${response.status}`);
      const releases = await response.json();
      const parse = value => {
        const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-preview\.(\d+))?$/.exec(value);
        return match && [+match[1], +match[2], +match[3], match[4] === undefined ? Infinity : +match[4]];
      };
      const current = parse(app.getVersion());
      if (!current) return;
      const newer = version => {
        const candidate = parse(version);
        if (!candidate) return false;
        for (let index = 0; index < current.length; index++) {
          if (candidate[index] !== current[index]) return candidate[index] > current[index];
        }
        return false;
      };
      const release = releases.find(item => !item.draft && (!item.prerelease || app.getVersion().includes('-preview.')) && newer(item.tag_name) && item.html_url?.startsWith('https://github.com/cmdun/qbss/releases/tag/'));
      if (!release) return;
      const result = await dialog.showMessageBox(mainWindow, {
        type: 'info', title: 'QBSS update available',
        message: `QBSS ${release.tag_name.replace(/^v/, '')} is available.`,
        detail: 'Download the new Mac installer from the release page.',
        buttons: ['Open download', 'Later'], defaultId: 0, cancelId: 1
      });
      if (result.response === 0) await shell.openExternal(release.html_url);
    } catch (error) { console.error('Update check failed:', error.message); }
    return;
  }
  if (process.platform !== 'win32') return;
  const { default: updater } = await import('electron-updater');
  const { autoUpdater } = updater;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('error', error => console.error('Update check failed:', error.message));
  autoUpdater.on('update-downloaded', async info => {
    const result = await dialog.showMessageBox(mainWindow, {
      type: 'info', title: 'QBSS update ready',
      message: `QBSS ${info.version} is ready to install.`,
      detail: 'Restart now to install the update, or install it when you quit QBSS.',
      buttons: ['Restart and update', 'Later'], defaultId: 0, cancelId: 1
    });
    if (result.response === 0) autoUpdater.quitAndInstall();
  });
  autoUpdater.checkForUpdates().catch(error => console.error('Update check failed:', error.message));
}

function runDatabaseImport (backup, output, onProgress = () => {}) {
  return new Promise((resolve, reject) => {
    const workerPath = path.join(app.getAppPath(), 'desktop', 'database-import-worker.cjs');
    let settled = false;
    const worker = utilityProcess.fork(workerPath, [backup, output], {
      serviceName: 'QBSS database setup',
      stdio: 'ignore'
    });
    worker.on('message', (_event, message) => {
      if (message?.type === 'progress') onProgress(message.message);
      if (message?.type === 'complete' && !settled) {
        settled = true;
        resolve(message.result);
      }
      if (message?.type === 'error' && !settled) {
        settled = true;
        reject(new Error(message.message));
      }
    });
    worker.on('error', (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
    worker.on('exit', (code) => {
      if (settled) return;
      settled = true;
      reject(new Error(`The database setup process stopped unexpectedly${code ? ` (exit code ${code})` : ''}.`));
    });
  });
}

function createDatabaseProgressWindow () {
  let currentMessage = 'Preparing the question database…';
  let pageReady = false;
  const progressWindow = new BrowserWindow({
    parent: mainWindow || undefined,
    modal: Boolean(mainWindow),
    width: 540,
    height: 250,
    resizable: false,
    minimizable: false,
    maximizable: false,
    show: false,
    title: 'Setting up QBSS database',
    backgroundColor: '#222222',
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  const page = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Setting up QBSS</title><style>
    :root{color-scheme:dark;font:15px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#222;color:#eee}
    body{margin:0;padding:28px 32px}.title{font-size:21px;font-weight:650;margin:0 0 8px}.description{color:#aab2b9;margin:0 0 22px;line-height:1.45}
    .track{height:8px;border-radius:10px;background:#3b4147;overflow:hidden}.bar{height:100%;width:38%;border-radius:10px;background:#3f6790;animation:move 1.5s ease-in-out infinite alternate}
    @keyframes move{from{transform:translateX(-15%)}to{transform:translateX(175%)}}
    #status{margin-top:15px;min-height:42px;line-height:1.4;color:#d7dce0;overflow-wrap:anywhere}.foot{font-size:12px;color:#8b949b;margin-top:7px}
  </style></head><body><h1 class="title">Setting up your question database</h1><p class="description">QBSS is converting the backup into a searchable local database. Larger backups can take several minutes.</p><div class="track" aria-hidden="true"><div class="bar"></div></div><div id="status" role="status" aria-live="polite">Preparing the question database…</div><div class="foot">You can keep this window open while setup runs.</div></body></html>`;
  progressWindow.webContents.once('did-finish-load', () => {
    pageReady = true;
    setMessage(currentMessage);
    progressWindow.show();
  });
  progressWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(page)}`);

  function setMessage (message) {
    currentMessage = String(message || 'Preparing the question database…');
    if (!pageReady || progressWindow.isDestroyed()) return;
    progressWindow.webContents.executeJavaScript(
      `document.getElementById('status').textContent = ${JSON.stringify(currentMessage)}`
    ).catch(() => {});
  }

  return { window: progressWindow, setMessage };
}

function applyPendingDatabase (directory) {
  const pending = path.join(directory, 'questions.sqlite.pending');
  const current = path.join(directory, 'questions.sqlite');
  if (!existsSync(pending)) return;
  if (existsSync(current)) {
    const previous = path.join(directory, 'questions.sqlite.previous');
    if (existsSync(previous)) unlinkSync(previous);
    renameSync(current, previous);
  }
  renameSync(pending, current);
}

function hasQuestionDatabase (directory) {
  return existsSync(path.join(directory, 'questions.sqlite'));
}

function saveDataDirectory (directory) {
  const settingsPath = path.join(app.getPath('userData'), 'settings.json');
  mkdirSync(path.dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, JSON.stringify({ dataDirectory: directory }, null, 2));
  return directory;
}

async function getDataDirectory () {
  const settingsPath = path.join(app.getPath('userData'), 'settings.json');
  if (existsSync(settingsPath)) {
    try {
      const configured = JSON.parse(readFileSync(settingsPath, 'utf8')).dataDirectory;
      if (configured && hasQuestionDatabase(configured)) { return configured; }
    } catch {}
  }

  const buildConfigPath = path.join(app.getAppPath(), 'desktop', 'build-config.json');
  if (existsSync(buildConfigPath)) {
    try {
      const configured = JSON.parse(readFileSync(buildConfigPath, 'utf8')).dataDirectory;
      if (configured && hasQuestionDatabase(configured)) { return saveDataDirectory(configured); }
    } catch {}
  }

  let candidate = app.getAppPath();
  while (true) {
    if (hasQuestionDatabase(candidate)) { return saveDataDirectory(candidate); }
    const parent = path.dirname(candidate);
    if (parent === candidate) { break; }
    candidate = parent;
  }

  const selection = await dialog.showOpenDialog({
    title: 'Choose a question database or QBReader backup folder',
    message: 'Select either a folder containing questions.sqlite or the extracted QBReader database backup. QBSS can convert a backup automatically. Your stars and practice history stay in your personal data file.',
    properties: ['openDirectory']
  });
  const selected = selection.filePaths[0];
  if (selection.canceled || !selected) {
    throw new Error('Choose a question database folder or an extracted QBReader backup to start QBSS.');
  }
  if (hasQuestionDatabase(selected)) return saveDataDirectory(selected);
  try { await validateBackupFolder(selected); } catch (error) {
    throw new Error(`That folder is not a complete QBReader backup and does not contain questions.sqlite. ${error.message}`);
  }
  const dataDirectory = path.join(app.getPath('userData'), 'QBSS-data');
  const progress = createDatabaseProgressWindow();
  try {
    await runDatabaseImport(selected, path.join(dataDirectory, 'questions.sqlite'), progress.setMessage);
  } finally {
    if (!progress.window.isDestroyed()) progress.window.close();
  }
  return saveDataDirectory(dataDirectory);
}

function createWindow () {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 900,
    minHeight: 650,
    show: false,
    title: 'QBSS — Quiz Bowl Study Suite',
    backgroundColor: '#222222',
    webPreferences: {
      preload: path.join(app.getAppPath(), 'desktop', 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (!url.startsWith(APP_URL)) { shell.openExternal(url); }
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(APP_URL)) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('closed', () => { mainWindow = null; });
  mainWindow.loadURL(APP_URL).catch(error => {
    dialog.showErrorBox('QBSS could not open', error.message);
    app.quit();
  });
}

ipcMain.handle('qbss:import-database-backup', async (event) => {
  const selection = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose the extracted QBReader backup folder',
    message: 'Choose the folder containing prelude.json and the sets, packets, tossups, and bonuses backup files.',
    properties: ['openDirectory']
  });
  if (selection.canceled || !selection.filePaths[0]) return { canceled: true };
  const directory = process.env.QB_READER_DATA_DIR;
  const pending = path.join(directory, 'questions.sqlite.pending');
  const progress = createDatabaseProgressWindow();
  try {
    const result = await runDatabaseImport(selection.filePaths[0], pending, (message) => {
      progress.setMessage(message);
      if (!event.sender.isDestroyed()) event.sender.send('qbss:database-import-progress', message);
    });
    return { ready: true, counts: result.counts };
  } catch (error) {
    return { error: error.message };
  } finally {
    if (!progress.window.isDestroyed()) progress.window.close();
  }
});

ipcMain.handle('qbss:restart-after-database-import', () => {
  app.relaunch();
  app.quit();
});

app.whenReady().then(async () => {
  try {
    const configuredSettingsPath = path.join(app.getPath('userData'), 'settings.json');
    if (existsSync(configuredSettingsPath)) {
      try {
        const configuredDirectory = JSON.parse(readFileSync(configuredSettingsPath, 'utf8')).dataDirectory;
        if (configuredDirectory) applyPendingDatabase(configuredDirectory);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
    process.env.QB_READER_DATA_DIR = await getDataDirectory();
    const { startLocalServer } = await import('../local/server.js');
    localServer = await startLocalServer();
    createWindow();
    checkForUpdates().catch(error => console.error('Update initialization failed:', error.message));
  } catch (error) {
    const message = error.code === 'EADDRINUSE'
      ? 'Port 4173 is already in use. Quit the existing QBSS server, then open the app again.'
      : error.message;
    dialog.showErrorBox('QBSS could not start', message);
    app.quit();
  }
});

app.on('window-all-closed', () => app.quit());

app.on('before-quit', event => {
  if (!localServer || isShuttingDown) { return; }
  event.preventDefault();
  isShuttingDown = true;
  const server = localServer;
  localServer = null;
  server.close(() => app.quit());
});
