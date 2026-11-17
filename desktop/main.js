import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from 'electron';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { importBackup, validateBackupFolder } from '../local/import-backup.js';

const APP_URL = 'http://127.0.0.1:4173/';

app.setName('QBSS');
// Keep existing preferences and browser data when upgrading from Local QBReader.
app.setPath('userData', path.join(app.getPath('appData'), 'Local QBReader'));
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
  await importBackup(selected, path.join(dataDirectory, 'questions.sqlite'));
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
  try {
    const result = await importBackup(selection.filePaths[0], pending, (message) => {
      if (!event.sender.isDestroyed()) event.sender.send('qbss:database-import-progress', message);
    });
    return { ready: true, counts: result.counts };
  } catch (error) {
    return { error: error.message };
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
