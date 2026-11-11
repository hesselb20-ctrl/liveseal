// Background service worker: owns the identity key and the pinned keys. The
// private key never leaves this context; content scripts send the bytes of a
// statement and get a signature back.

import { fromBase64Url, toBase64Url, utf8 } from '../../core/src/bytes.ts';
import { fetchOrganisation, loadDirectory, loadIdentity, refreshOrganisations, saveDirectory } from '../../shared/store.ts';
import { DEFAULT_SETTINGS, type Request, type Settings, type StateReply } from './messages.ts';

const STATEMENT_PREFIX = utf8('LiveSeal statement v1\0');

async function settings(): Promise<Settings> {
  const stored = await chrome.storage.local.get('settings');
  return { ...DEFAULT_SETTINGS, ...(stored.settings as Partial<Settings> | undefined) };
}

async function state(): Promise<StateReply> {
  const [identity, directory, s] = await Promise.all([loadIdentity(), loadDirectory(), settings()]);
  return {
    identity: identity ? { name: identity.name, publicKey: toBase64Url(identity.signer.publicKey), software: identity.signer.software } : null,
    directory: directory.toJSON(),
    settings: s,
  };
}

async function handle(req: Request): Promise<unknown> {
  switch (req.type) {
    case 'state':
      return state();
    case 'sign': {
      const message = fromBase64Url(req.data);
      // only LiveSeal statements are signed, so this key cannot be borrowed for anything else
      if (!STATEMENT_PREFIX.every((b, i) => message[i] === b)) throw new Error('not a LiveSeal statement');
      const identity = await loadIdentity();
      if (!identity) throw new Error('no identity');
      return { signature: toBase64Url(await identity.signer.sign(message)) };
    }
    case 'record-call': {
      const directory = await loadDirectory();
      directory.recordCall(req.name, req.sealed);
      await saveDirectory(directory);
      return { ok: true };
    }
    case 'fetch-org': {
      const directory = await loadDirectory();
      const res = await fetchOrganisation(directory, req.input);
      await saveDirectory(directory);
      await chrome.storage.local.set({ rev: Date.now() });
      return res;
    }
  }
}

chrome.runtime.onMessage.addListener((req: Request, _sender, reply) => {
  handle(req).then((value) => reply({ ok: true, value }), (err) => reply({ ok: false, error: String((err as Error).message ?? err) }));
  return true; // the reply is asynchronous
});

// Pick up organisation revocations at least once a day.
async function refresh(): Promise<void> {
  const directory = await loadDirectory();
  await refreshOrganisations(directory);
  await saveDirectory(directory);
  await chrome.storage.local.set({ rev: Date.now() });
}
chrome.runtime.onStartup?.addListener(() => void refresh());
chrome.runtime.onInstalled?.addListener(() => void refresh());
