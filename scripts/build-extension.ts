// Builds the browser extension into extension/dist/ (load that folder as an
// unpacked extension in Chrome or Edge, or as a temporary add-on in Firefox).
// Run with: node scripts/build-extension.ts

import { build } from 'esbuild';
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CALL_SITES } from '../extension/src/messages.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'extension', 'dist');
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

// Content scripts and the worker cannot be ES modules, so every entry is bundled on its own.
const entries: Record<string, string> = {
  background: 'extension/src/background.ts',
  content: 'extension/src/content.ts',
  inject: 'extension/src/inject.ts',
  popup: 'extension/src/popup.ts',
  'verify-worker': 'shared/verify-worker.ts',
};
for (const [name, entry] of Object.entries(entries)) {
  await build({
    entryPoints: [join(root, entry)],
    outfile: join(out, `${name}.js`),
    bundle: true,
    format: 'iife',
    target: 'es2022',
    minify: false, // reviewable output: store reviewers and curious users can read what runs
    legalComments: 'none',
    logLevel: 'warning',
  });
}

const pkg = JSON.parse((await import('node:fs')).readFileSync(join(root, 'package.json'), 'utf8')) as { version: string };
const dev = process.argv.includes('--dev');
const sites = dev ? [...CALL_SITES, 'http://localhost/*'] : CALL_SITES;
const manifest = {
  manifest_version: 3,
  name: 'LiveSeal',
  version: pkg.version,
  description: 'Seals your camera on video-call sites and checks the seal on the people you talk to.',
  icons: { 16: 'icons/icon-16.png', 32: 'icons/icon-32.png', 48: 'icons/icon-48.png', 128: 'icons/icon-128.png' },
  action: { default_popup: 'popup.html', default_title: 'LiveSeal' },
  // Chrome and Edge use the service worker; Firefox uses the scripts entry.
  background: { service_worker: 'background.js', scripts: ['background.js'] },
  permissions: ['storage', 'scripting', 'activeTab'],
  host_permissions: sites,
  optional_host_permissions: ['https://*/*'],
  content_scripts: [
    { matches: sites, js: ['inject.js'], run_at: 'document_start', world: 'MAIN', all_frames: true },
    { matches: sites, js: ['content.js'], run_at: 'document_start', all_frames: true },
  ],
  web_accessible_resources: [{ resources: ['verify-worker.js'], matches: ['https://*/*', 'http://localhost/*'] }],
  browser_specific_settings: { gecko: { id: 'liveseal@liveseal.invalid', strict_min_version: '128.0' } },
};
writeFileSync(join(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
cpSync(join(root, 'extension', 'popup.html'), join(out, 'popup.html'));
cpSync(join(root, 'shared', 'ui.css'), join(out, 'ui.css'));
cpSync(join(root, 'extension', 'icons'), join(out, 'icons'), { recursive: true });
console.log(`extension built in extension/dist (${Object.keys(entries).length} bundles${dev ? ', dev hosts included' : ''})`);
