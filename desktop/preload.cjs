const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('qbssDesktop', {
  importDatabaseBackup: () => ipcRenderer.invoke('qbss:import-database-backup'),
  restartAfterDatabaseImport: () => ipcRenderer.invoke('qbss:restart-after-database-import'),
  onDatabaseImportProgress: (callback) => {
    const listener = (_event, message) => callback(message);
    ipcRenderer.on('qbss:database-import-progress', listener);
    return () => ipcRenderer.removeListener('qbss:database-import-progress', listener);
  }
});
