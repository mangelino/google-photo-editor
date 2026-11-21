// Builds both distributions from src/:
//   google-photos-range-tools.user.js   Tampermonkey userscript (path is the auto-update URL; keep it)
//   extension/                          unpacked Chrome extension (Manifest V3)
// `--zip` also writes range-tools-extension-<version>.zip for the Chrome Web Store.
// No dependencies; version and description come from package.json.

import { readFileSync, writeFileSync, mkdirSync, rmSync, cpSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');
const pkg = JSON.parse(read('package.json'));

const indent = (code) => code.trimEnd().split('\n').map((l) => (l ? `  ${l}` : l)).join('\n');
const iife = (...parts) => `(() => {\n  'use strict';\n\n${parts.map(indent).join('\n\n')}\n})();\n`;

const core = read('src/core.js');
const css = read('src/styles.css');

// ---- Userscript ----
const header = read('src/header.userscript.js')
  .replace('{{version}}', pkg.version)
  .replace('{{description}}', pkg.description);
const userscript = `${header}\n${iife(`const STYLES = ${JSON.stringify(css)};`, read('src/platform.userscript.js'), core)}`;
writeFileSync(join(root, 'google-photos-range-tools.user.js'), userscript);

// ---- Chrome extension ----
const ext = join(root, 'extension');
rmSync(ext, { recursive: true, force: true });
mkdirSync(ext);
const generated = '// GENERATED FILE: edit src/ and run `npm run build`.\n';
writeFileSync(join(ext, 'content.js'), generated + iife(read('src/platform.extension.js'), core));
writeFileSync(join(ext, 'background.js'), generated + read('src/extension.background.js'));
writeFileSync(join(ext, 'styles.css'), css);
cpSync(join(root, 'src/icons'), join(ext, 'icons'), { recursive: true });

const icons = { 16: 'icons/icon16.png', 32: 'icons/icon32.png', 48: 'icons/icon48.png', 128: 'icons/icon128.png' };
const manifest = {
  manifest_version: 3,
  name: 'Range Tools for Google Photos',
  short_name: 'Range Tools',
  version: pkg.version,
  description: pkg.description, // Chrome Web Store limit: 132 chars
  homepage_url: 'https://github.com/mangelino/google-photo-editor',
  icons,
  action: { default_title: 'Open Range Tools', default_icon: icons },
  background: { service_worker: 'background.js' },
  permissions: ['downloads'],
  content_scripts: [
    {
      matches: ['https://photos.google.com/*'],
      js: ['content.js'],
      css: ['styles.css'],
      run_at: 'document_idle',
      all_frames: false,
    },
  ],
};
writeFileSync(join(ext, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

console.log(`Built v${pkg.version}: google-photos-range-tools.user.js, extension/`);

if (process.argv.includes('--zip')) {
  const zip = join(root, `range-tools-extension-${pkg.version}.zip`);
  if (existsSync(zip)) rmSync(zip);
  execFileSync('zip', ['-qr', zip, '.'], { cwd: ext });
  console.log(`Packaged ${zip}`);
}
