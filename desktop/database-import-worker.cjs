const { pathToFileURL } = require('node:url');
const path = require('node:path');

async function main () {
  const [backup, output] = process.argv.slice(-2);
  if (!backup || !output || !process.parentPort) {
    throw new Error('The database import worker was started without its input folder or output path.');
  }

  const importerPath = pathToFileURL(path.join(__dirname, '..', 'local', 'import-backup.js')).href;
  const { importBackup } = await import(importerPath);
  const result = await importBackup(backup, output, (message) => {
    process.parentPort.postMessage({ type: 'progress', message });
  });
  process.parentPort.postMessage({ type: 'complete', result });
  process.parentPort.close();
}

main().catch((error) => {
  process.parentPort?.postMessage({ type: 'error', message: error.message || String(error) });
  process.parentPort?.close();
  process.exitCode = 1;
});
