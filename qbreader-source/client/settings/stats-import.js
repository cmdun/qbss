const tossupFile = document.getElementById('import-tossup-stats');
const bonusFile = document.getElementById('import-bonus-stats');
const importButton = document.getElementById('import-qbreader-stats');
const status = document.getElementById('stats-import-status');

function describeResult (result) {
  if (result.alreadyImported) { return `${result.filename}: already imported; no changes made.`; }
  return `${result.filename}: imported ${result.imported.toLocaleString()} rows, skipped ${result.skipped.toLocaleString()}.`;
}

importButton.addEventListener('click', async () => {
  const files = [
    { type: 'tossups', file: tossupFile.files[0] },
    { type: 'bonuses', file: bonusFile.files[0] }
  ].filter(item => item.file);
  if (!files.length) {
    status.className = 'small text-danger';
    status.textContent = 'Choose at least one QBReader stats CSV.';
    return;
  }

  importButton.disabled = true;
  status.className = 'small text-muted';
  status.textContent = 'Importing stats…';
  const messages = [];
  try {
    for (const { type, file } of files) {
      const response = await fetch(`/api/local/stats/import/${type}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: file.name, csv: await file.text() })
      });
      const result = await response.json();
      if (!response.ok) { throw new Error(`${file.name}: ${result.error || 'Import failed.'}`); }
      messages.push(describeResult(result));
    }
    status.className = 'small text-success';
    status.textContent = messages.join(' ');
  } catch (error) {
    status.className = 'small text-danger';
    status.textContent = `${error.message}${messages.length ? ` ${messages.join(' ')}` : ''}`;
  } finally {
    importButton.disabled = false;
  }
});
