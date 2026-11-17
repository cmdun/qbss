import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { packager } from '@electron/packager';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ICON_SOURCE = path.join(ROOT, 'qbreader-source', 'client', 'qbss-icon.svg');
const ICONSET = path.join(ROOT, 'desktop', 'assets', 'qbreader.iconset');
const ICON_PATH = path.join(ROOT, 'desktop', 'assets', 'qbreader.icns');
const OUTPUT = path.join(ROOT, 'release', 'macos');
const DMG_PATH = path.join(OUTPUT, `QBSS-1.0.0-macos-${process.arch}.dmg`);
const ELECTRON_ZIP_DIR = '/private/tmp/local-qbreader-electron-zips';
const ELECTRON_VERSION = JSON.parse(readFileSync(path.join(ROOT, 'node_modules', 'electron', 'package.json'), 'utf8')).version;
const ELECTRON_ZIP = path.join(ELECTRON_ZIP_DIR, `electron-v${ELECTRON_VERSION}-darwin-${process.arch}.zip`);
const APP_NAME = 'QBSS';
const swiftModuleCache = '/private/tmp/local-qbreader-swift-cache';
const iconChunks = [
  ['icp4', 'icon_16x16.png'],
  ['icp5', 'icon_32x32.png'],
  ['icp6', 'icon_32x32@2x.png'],
  ['ic07', 'icon_128x128.png'],
  ['ic08', 'icon_256x256.png'],
  ['ic09', 'icon_512x512.png'],
  ['ic10', 'icon_512x512@2x.png']
];

if (process.platform !== 'darwin') {
  throw new Error('Build the Finder app on macOS.');
}

mkdirSync(ICONSET, { recursive: true });
mkdirSync(swiftModuleCache, { recursive: true });
execFileSync('swift', ['-module-cache-path', swiftModuleCache, path.join(ROOT, 'desktop', 'create-iconset.swift'), ICON_SOURCE, ICONSET], { stdio: 'inherit' });
const chunks = iconChunks.map(([type, filename]) => {
  const image = readFileSync(path.join(ICONSET, filename));
  const chunkHeader = Buffer.alloc(8);
  chunkHeader.write(type, 0, 4, 'ascii');
  chunkHeader.writeUInt32BE(image.length + 8, 4);
  return Buffer.concat([chunkHeader, image]);
});
const iconFile = Buffer.alloc(8);
iconFile.write('icns', 0, 4, 'ascii');
iconFile.writeUInt32BE(chunks.reduce((length, chunk) => length + chunk.length, 8), 4);
writeFileSync(ICON_PATH, Buffer.concat([iconFile, ...chunks]));
mkdirSync(ELECTRON_ZIP_DIR, { recursive: true });
rmSync(ELECTRON_ZIP, { force: true });
execFileSync('ditto', ['-c', '-k', '--keepParent', path.join(ROOT, 'node_modules', 'electron', 'dist', 'Electron.app'), ELECTRON_ZIP]);
rmSync(OUTPUT, { recursive: true, force: true });

const apps = await packager({
  dir: ROOT,
  name: APP_NAME,
  platform: 'darwin',
  arch: process.arch,
  out: OUTPUT,
  electronVersion: ELECTRON_VERSION,
  electronZipDir: ELECTRON_ZIP_DIR,
  overwrite: true,
  asar: true,
  asarIntegrityDigest: false,
  prune: false,
  icon: ICON_PATH,
  // Keep the installed app's stable identifier so macOS treats QBSS as an
  // upgrade to the user's existing Local QBReader app.
  appBundleId: 'org.qbreader.local',
  appVersion: '1.0.0',
  appCategoryType: 'public.app-category.education',
  ignore: [
    /^\/node_modules(?:\/|$)/,
    /^\/release(?:\/|$)/,
    /^\/questions[^/]*\.sqlite(?:-|$)/,
    /^\/personal\.sqlite(?:-|$)/,
    /^\/wikipedia-cache(?:\/|$)/,
    /^\/2026-07-18_16_15_24(?:\/|$)/,
    /^\/desktop\/build-config\.json$/,
    /^\/\.DS_Store$/
  ]
});

console.log(`Packaged ${apps[0]}`);
// Electron Packager skips legacy ICNS icons on newer macOS versions that prefer
// Icon Composer's .icon format. Keep the supported legacy bundle icon key and
// replace Electron's generic artwork with the QBSS icon directly.
copyFileSync(ICON_PATH, path.join(apps[0], `${APP_NAME}.app`, 'Contents', 'Resources', 'electron.icns'));
// Electron's Mach-O binary is linker-signed before packaging. Re-sign the final
// bundle after replacing its icon so macOS accepts the customized app bundle.
const appBundle = path.join(apps[0], `${APP_NAME}.app`);
// ditto can leave AppleDouble metadata sidecars in the Electron bundle; they
// are redundant on macOS and prevent the final bundle signature from verifying.
execFileSync('find', [appBundle, '-name', '._*', '-delete']);
execFileSync('codesign', ['--force', '--deep', '--sign', '-', appBundle], { stdio: 'inherit' });
const dmgContents = mkdtempSync(path.join('/private/tmp', 'qbss-dmg-'));
try {
  symlinkSync('/Applications', path.join(dmgContents, 'Applications'));
  copyFileSync(path.join(ROOT, 'LICENSE'), path.join(dmgContents, 'LICENSE.txt'));
  copyFileSync(path.join(ROOT, 'THIRD_PARTY_NOTICES.md'), path.join(dmgContents, 'Third-party notices.txt'));
  execFileSync('ditto', [appBundle, path.join(dmgContents, `${APP_NAME}.app`)]);
  rmSync(DMG_PATH, { force: true });
  execFileSync('hdiutil', ['create', '-volname', 'QBSS 1.0.0', '-srcfolder', dmgContents, '-ov', '-format', 'UDZO', DMG_PATH], { stdio: 'inherit' });
} finally {
  rmSync(dmgContents, { recursive: true, force: true });
}
rmSync(apps[0], { recursive: true, force: true });
console.log(`Created ${DMG_PATH}`);
