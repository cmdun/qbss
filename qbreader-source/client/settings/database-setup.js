const importButton = document.getElementById('import-question-backup');
const restartButton = document.getElementById('restart-after-question-import');
const status = document.getElementById('question-backup-status');
const desktop = window.qbssDesktop;

if (importButton && status) {
  if (!desktop) {
    importButton.disabled = true;
    status.textContent = 'Folder import is available in the installed QBSS app.';
  } else {
    desktop.onDatabaseImportProgress(message => { status.textContent = message; });
    importButton.addEventListener('click', async () => {
      importButton.disabled = true;
      status.textContent = 'Choose the extracted backup folder…';
      let result;
      try { result = await desktop.importDatabaseBackup(); } catch (error) {
        status.textContent = error.message || 'QBSS could not start the database import.';
        importButton.disabled = false;
        return;
      }
      if (result.canceled) {
        status.textContent = '';
        importButton.disabled = false;
        return;
      }
      if (result.error) {
        status.textContent = result.error;
        importButton.disabled = false;
        return;
      }
      status.textContent = `Ready to use (${result.counts.tossups.toLocaleString()} tossups, ${result.counts.bonuses.toLocaleString()} bonuses). Restart QBSS to switch databases.`;
      restartButton?.classList.remove('d-none');
    });
    restartButton?.addEventListener('click', () => desktop.restartAfterDatabaseImport());
  }
}
