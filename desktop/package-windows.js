import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT = path.join(ROOT, 'release', 'windows');

if (process.platform !== 'win32') {
  throw new Error('Build the Windows installer on Windows so Electron and native tooling match the target platform.');
}

mkdirSync(path.dirname(OUTPUT), { recursive: true });
rmSync(OUTPUT, { recursive: true, force: true });
execFileSync(process.execPath, [
  path.join(ROOT, 'node_modules', 'electron-builder', 'cli.js'),
  '--win', 'nsis',
  `--${process.arch}`
], { cwd: ROOT, stdio: 'inherit' });

const installers = readdirSync(OUTPUT).filter((name) => name.endsWith('.exe'));
if (installers.length !== 1) {
  throw new Error(`Expected one Windows installer in ${OUTPUT}, found ${installers.length}.`);
}
for (const name of readdirSync(OUTPUT)) {
  if (name !== installers[0]) rmSync(path.join(OUTPUT, name), { recursive: true, force: true });
}

console.log(`Created ${path.join(OUTPUT, installers[0])}`);
