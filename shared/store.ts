// On-device storage for the identity key and the pinned keys (IndexedDB).
// Nothing in here ever leaves the device.

import { createSigner, nativeSigner, softwareSigner, type Signer } from '../core/src/crypto.ts';
import { KeyDirectory, normalizeOrgLocator, parseOrgFile, type OrgLocator } from '../core/src/directory.ts';

const DB_NAME = 'liveseal';
const STORE = 'kv';

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const req = run(db.transaction(STORE, mode).objectStore(STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

export const kvGet = <T>(key: string) => tx<T | undefined>('readonly', (s) => s.get(key) as IDBRequest<T | undefined>);
export const kvSet = (key: string, value: unknown) => tx('readwrite', (s) => s.put(value, key));
export const kvDelete = (key: string) => tx('readwrite', (s) => s.delete(key));

interface StoredIdentity {
  name: string;
  publicKey: Uint8Array;
  /** Non-extractable WebCrypto key: usable for signing, never readable. */
  privateKey?: CryptoKey;
  /** Software fallback for browsers without Ed25519 in WebCrypto. Readable by page script: less safe. */
  secret?: Uint8Array;
  createdAt: number;
}

export interface Identity {
  name: string;
  signer: Signer;
  createdAt: number;
}

async function toIdentity(s: StoredIdentity): Promise<Identity> {
  const signer = s.privateKey
    ? nativeSigner({ privateKey: s.privateKey, publicKey: s.publicKey })
    : await softwareSigner(s.secret as Uint8Array);
  return { name: s.name, signer, createdAt: s.createdAt };
}

export async function loadIdentity(): Promise<Identity | null> {
  const stored = await kvGet<StoredIdentity>('identity');
  return stored ? toIdentity(stored) : null;
}

export async function createIdentity(name: string): Promise<Identity> {
  const made = await createSigner();
  const stored: StoredIdentity = {
    name,
    publicKey: made.signer.publicKey,
    privateKey: made.native?.privateKey,
    secret: made.secret,
    createdAt: Math.floor(Date.now() / 1000),
  };
  await kvSet('identity', stored);
  return toIdentity(stored);
}

export async function renameIdentity(name: string): Promise<void> {
  const stored = await kvGet<StoredIdentity>('identity');
  if (stored) await kvSet('identity', { ...stored, name });
}

export async function deleteIdentity(): Promise<void> {
  await kvDelete('identity');
}

export async function loadDirectory(): Promise<KeyDirectory> {
  return KeyDirectory.fromJSON(await kvGet('directory'));
}

export async function saveDirectory(directory: KeyDirectory): Promise<void> {
  await kvSet('directory', directory.toJSON());
}

export interface OrgFetchResult {
  locator: OrgLocator;
  name: string;
  keys: number;
  problems: string[];
}

/** Fetches an organisation's key file and pins its keys under the locator. Throws with a plain message on failure. */
export async function fetchOrganisation(directory: KeyDirectory, input: string): Promise<OrgFetchResult> {
  const locator = normalizeOrgLocator(input);
  if (!locator) throw new Error('That is not a valid https address.');
  let response: Response;
  try {
    response = await fetch(locator.url, { cache: 'no-store', credentials: 'omit', redirect: 'error' });
  } catch {
    throw new Error(`Could not reach ${locator.url}. The organisation may not publish LiveSeal keys.`);
  }
  if (!response.ok) throw new Error(`${locator.url} answered with status ${response.status}.`);
  let json: unknown;
  try {
    json = await response.json();
  } catch {
    throw new Error('The key file is not valid JSON.');
  }
  const file = await parseOrgFile(json);
  if (!file || file.keys.length === 0) throw new Error('The key file contains no usable keys.');
  await directory.setOrganisation(locator.locator, file, Math.floor(Date.now() / 1000));
  return { locator, name: file.name, keys: file.keys.length, problems: file.problems };
}

/** Refreshes organisations whose copy is older than a day. Failures keep the old copy. */
export async function refreshOrganisations(directory: KeyDirectory): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  for (const locator of directory.organisations()) {
    const age = directory.organisationAge(locator, now);
    if (age !== null && age < 86400) continue;
    try {
      await fetchOrganisation(directory, 'https://' + locator);
    } catch {
      // keep what we have
    }
  }
}
