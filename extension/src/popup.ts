// Extension popup: identity, pairing, organisations and the two switches.

import { mountContacts } from '../../shared/contacts-ui.ts';
import { createIdentity, deleteIdentity, loadDirectory, loadIdentity, saveDirectory } from '../../shared/store.ts';
import { CALL_SITES, DEFAULT_SETTINGS, type Settings } from './messages.ts';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const touch = () => chrome.storage.local.set({ rev: Date.now() });

async function settings(): Promise<Settings> {
  const stored = await chrome.storage.local.get('settings');
  return { ...DEFAULT_SETTINGS, ...(stored.settings as Partial<Settings> | undefined) };
}

async function render(): Promise<void> {
  const identity = await loadIdentity();
  $('welcome').classList.toggle('hidden', !!identity);
  $('main').classList.toggle('hidden', !identity);
  if (!identity) return;
  const s = await settings();
  $<HTMLInputElement>('seal').checked = s.seal;
  $<HTMLInputElement>('verify').checked = s.verify;
  $<HTMLSelectElement>('strength').value = s.strength;
  const directory = await loadDirectory();
  mountContacts($('contacts'), {
    identity,
    directory,
    onChange: async () => { await saveDirectory(directory); await touch(); },
    onRevokeSelf: async () => { await deleteIdentity(); await touch(); await render(); },
  });
}

async function save(): Promise<void> {
  const s: Settings = {
    seal: $<HTMLInputElement>('seal').checked,
    verify: $<HTMLInputElement>('verify').checked,
    strength: $<HTMLSelectElement>('strength').value as Settings['strength'],
  };
  await chrome.storage.local.set({ settings: s, rev: Date.now() });
  $('saved').textContent = 'Saved. Reload the call page for a camera change to take effect.';
}

$('create').addEventListener('click', async () => {
  const name = $<HTMLInputElement>('name').value.trim();
  if (!name) return;
  await createIdentity(name);
  await touch();
  await render();
});
for (const id of ['seal', 'verify', 'strength']) $(id).addEventListener('change', () => void save());

// Jitsi and similar apps run on many addresses; let the user switch LiveSeal on for the current one.
$('enable-site').addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url || !/^https:/.test(tab.url)) { $('saved').textContent = 'Open the call page first (https only).'; return; }
  const pattern = new URL(tab.url).origin + '/*';
  const granted = await chrome.permissions.request({ origins: [pattern] });
  if (!granted) { $('saved').textContent = 'Not enabled.'; return; }
  const id = 'liveseal-' + new URL(tab.url).hostname.replace(/[^a-z0-9]/gi, '-');
  try {
    await chrome.scripting.registerContentScripts([
      { id: id + '-page', matches: [pattern], js: ['inject.js'], runAt: 'document_start', world: 'MAIN', allFrames: true },
      { id: id + '-ext', matches: [pattern], js: ['content.js'], runAt: 'document_start', allFrames: true },
    ]);
    $('saved').textContent = `Enabled on ${new URL(tab.url).hostname}. Reload that page.`;
  } catch (err) {
    $('saved').textContent = /duplicate/i.test(String(err)) ? 'Already enabled on this site.' : `Could not enable: ${(err as Error).message}`;
  }
});
$('sites').textContent = CALL_SITES.map((s) => s.replace('https://', '').replace('/*', '')).join(', ');
void render();
