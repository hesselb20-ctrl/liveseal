// Pinned keys: contacts paired in person, organisation keys fetched from
// /.well-known/liveseal.json, revocations, and the per-contact call history
// that drives the "usually verifies" warning.

import { concatBytes, equalBytes, fromBase64Url, toBase64Url, toHex, utf8 } from './bytes.ts';
import { decodeCbor, encodeCbor } from './cbor.ts';
import { keyIdOf, type Signer, verifySignature } from './crypto.ts';

export type KeyKind = 'contact' | 'organisation';

export interface PinnedKey {
  publicKey: Uint8Array;
  keyId: Uint8Array;
  kind: KeyKind;
  /** Contact name chosen by the user, or the locator (domain) that served an organisation key. */
  name: string;
  /** Optional label for organisation keys, for example a department. */
  label?: string;
  addedAt: number;
  notBefore?: number;
  notAfter?: number;
  revokedAt?: number;
}

export interface CallHistory {
  sealed: number;
  unsealed: number;
}

export type AddContactResult = 'added' | 'unchanged' | 'key-changed';

// ---------------------------------------------------------------- pairing

const PAIR_PREFIX = 'liveseal:pair:';

/** Text for a pairing QR code: the user's display name and public key. */
export function encodePairing(name: string, publicKey: Uint8Array): string {
  return PAIR_PREFIX + toBase64Url(encodeCbor([1, name, publicKey]));
}

export function parsePairing(text: string): { name: string; publicKey: Uint8Array } | null {
  const t = text.trim();
  if (!t.startsWith(PAIR_PREFIX)) return null;
  try {
    const v = decodeCbor(fromBase64Url(t.slice(PAIR_PREFIX.length)));
    if (!Array.isArray(v) || v.length !== 3 || v[0] !== 1) return null;
    const [, name, publicKey] = v;
    if (typeof name !== 'string' || name.length === 0 || name.length > 64) return null;
    if (!(publicKey instanceof Uint8Array) || publicKey.length !== 32) return null;
    return { name, publicKey };
  } catch {
    return null;
  }
}

// ------------------------------------------------------------- revocation

const REVOKE_PREFIX = 'liveseal:revoke:';
const REVOKE_DOMAIN = utf8('LiveSeal revocation v1\0');

/**
 * A revocation is signed by the key it revokes. It can be created at setup
 * time and kept on paper, so that revoking does not need the lost device.
 */
export async function createRevocation(signer: Signer): Promise<string> {
  const body = encodeCbor([1, signer.publicKey]);
  const signature = await signer.sign(concatBytes(REVOKE_DOMAIN, body));
  return REVOKE_PREFIX + toBase64Url(encodeCbor([1, signer.publicKey, signature]));
}

export async function parseRevocation(text: string): Promise<{ publicKey: Uint8Array } | null> {
  const t = text.trim();
  if (!t.startsWith(REVOKE_PREFIX)) return null;
  try {
    const v = decodeCbor(fromBase64Url(t.slice(REVOKE_PREFIX.length)));
    if (!Array.isArray(v) || v.length !== 3 || v[0] !== 1) return null;
    const [, publicKey, signature] = v;
    if (!(publicKey instanceof Uint8Array) || !(signature instanceof Uint8Array)) return null;
    const body = encodeCbor([1, publicKey]);
    if (!(await verifySignature(publicKey, signature, concatBytes(REVOKE_DOMAIN, body)))) return null;
    return { publicKey };
  } catch {
    return null;
  }
}

// ------------------------------------------------------ organisation file

const SUBKEY_DOMAIN = utf8('LiveSeal sub-key v1\0');

export interface OrgKeyEntry {
  publicKey: Uint8Array;
  label?: string;
  notBefore?: number;
  notAfter?: number;
}

export interface OrgFile {
  name: string;
  keys: OrgKeyEntry[];
  revoked: { publicKey: Uint8Array; revokedAt: number }[];
  /** Entries that were ignored, with the reason. Shown to the user, never trusted. */
  problems: string[];
}

function subKeyBytes(issuer: Uint8Array, sub: Uint8Array, label: string, notBefore: number, notAfter: number): Uint8Array {
  return concatBytes(SUBKEY_DOMAIN, encodeCbor([issuer, sub, label, notBefore, notAfter]));
}

/** Signs an employee sub-key with an organisation root key. Used by organisation tooling. */
export async function signSubKey(
  root: Signer, sub: Uint8Array, label: string, notBefore: number, notAfter: number,
): Promise<Uint8Array> {
  return root.sign(subKeyBytes(root.publicKey, sub, label, notBefore, notAfter));
}

function parseTime(v: unknown): number | undefined {
  if (typeof v !== 'string') return undefined;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : undefined;
}

function parseKey(v: unknown): Uint8Array | null {
  if (typeof v !== 'string') return null;
  try {
    const k = fromBase64Url(v);
    return k.length === 32 ? k : null;
  } catch {
    return null;
  }
}

/**
 * Validates the JSON served at /.well-known/liveseal.json. Root keys are
 * trusted because of where the file was fetched from. Sub-keys must carry a
 * valid signature from one of the listed root keys.
 */
export async function parseOrgFile(json: unknown): Promise<OrgFile | null> {
  if (typeof json !== 'object' || json === null) return null;
  const o = json as Record<string, unknown>;
  if (o.liveseal !== 1 || typeof o.name !== 'string' || !Array.isArray(o.keys)) return null;
  const out: OrgFile = { name: o.name.slice(0, 80), keys: [], revoked: [], problems: [] };
  const roots: Uint8Array[] = [];
  for (const entry of o.keys as Record<string, unknown>[]) {
    const publicKey = parseKey(entry?.publicKey);
    if (!publicKey) { out.problems.push('a key entry has no valid publicKey'); continue; }
    roots.push(publicKey);
    out.keys.push({
      publicKey,
      label: typeof entry.label === 'string' ? entry.label.slice(0, 80) : undefined,
      notBefore: parseTime(entry.validFrom),
      notAfter: parseTime(entry.validTo),
    });
  }
  if (Array.isArray(o.subKeys)) {
    for (const entry of o.subKeys as Record<string, unknown>[]) {
      const publicKey = parseKey(entry?.publicKey);
      const issuer = parseKey(entry?.issuer);
      const label = typeof entry?.label === 'string' ? entry.label : '';
      const notBefore = parseTime(entry?.validFrom);
      const notAfter = parseTime(entry?.validTo);
      let signature: Uint8Array | null = null;
      try {
        signature = typeof entry?.signature === 'string' ? fromBase64Url(entry.signature) : null;
      } catch {
        signature = null;
      }
      if (!publicKey || !issuer || !signature || notBefore === undefined || notAfter === undefined) {
        out.problems.push('a sub-key entry is incomplete');
        continue;
      }
      if (!roots.some((r) => equalBytes(r, issuer))) {
        out.problems.push(`sub-key "${label}" names an issuer that is not a listed key`);
        continue;
      }
      if (!(await verifySignature(issuer, signature, subKeyBytes(issuer, publicKey, label, notBefore, notAfter)))) {
        out.problems.push(`sub-key "${label}" has an invalid signature`);
        continue;
      }
      out.keys.push({ publicKey, label: label.slice(0, 80), notBefore, notAfter });
    }
  }
  if (Array.isArray(o.revoked)) {
    for (const entry of o.revoked as Record<string, unknown>[]) {
      const publicKey = parseKey(entry?.publicKey);
      if (!publicKey) { out.problems.push('a revocation entry has no valid publicKey'); continue; }
      out.revoked.push({ publicKey, revokedAt: parseTime(entry.revokedAt) ?? 0 });
    }
  }
  return out;
}

export interface OrgLocator {
  /** What the badge shows: the host, plus the path when the file is not at the root of the host. */
  locator: string;
  /** Where the key file is fetched from. */
  url: string;
  /** True when the file lives under a path. Shown as a caution: only the host root proves control of a domain. */
  pathScoped: boolean;
}

/**
 * Turns what the user typed ("examplebank.com", or a full https URL) into a
 * fetch URL and a display name. Only https is accepted, except for localhost
 * during development.
 */
export function normalizeOrgLocator(input: string): OrgLocator | null {
  let text = input.trim();
  if (!text) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = 'https://' + text;
  let u: URL;
  try {
    u = new URL(text);
  } catch {
    return null;
  }
  const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
  if (u.protocol !== 'https:' && !(local && u.protocol === 'http:')) return null;
  if (!local && !u.hostname.includes('.')) return null;
  if (u.username || u.password) return null;
  let path = u.pathname.replace(/\/\.well-known\/liveseal\.json$/, '').replace(/\/+$/, '');
  if (path === '/') path = '';
  const host = u.host.toLowerCase();
  return {
    locator: host + path,
    url: `${u.protocol}//${host}${path}/.well-known/liveseal.json`,
    pathScoped: path !== '',
  };
}

// -------------------------------------------------------------- directory

interface StoredKey {
  publicKey: string;
  kind: KeyKind;
  name: string;
  label?: string;
  addedAt: number;
  notBefore?: number;
  notAfter?: number;
  revokedAt?: number;
}

export interface DirectorySnapshot {
  version: 1;
  keys: StoredKey[];
  history: Record<string, CallHistory>;
  orgFetchedAt: Record<string, number>;
}

export class KeyDirectory {
  private keys: PinnedKey[] = [];
  private history = new Map<string, CallHistory>();
  private orgFetchedAt = new Map<string, number>();

  list(): readonly PinnedKey[] {
    return this.keys;
  }

  /** All pinned keys with this key id. Usually zero or one. */
  find(keyId: Uint8Array): PinnedKey[] {
    return this.keys.filter((k) => equalBytes(k.keyId, keyId));
  }

  findByName(name: string): PinnedKey[] {
    return this.keys.filter((k) => k.name === name);
  }

  /**
   * Pins a contact. If the name already has a different active key, nothing
   * changes and 'key-changed' is returned: the UI must warn and ask the user
   * to confirm with `replaceContactKey`.
   */
  async addContact(name: string, publicKey: Uint8Array, nowUnix: number): Promise<AddContactResult> {
    if (publicKey.length !== 32) throw new Error('directory: public key must be 32 bytes');
    const existing = this.keys.filter((k) => k.kind === 'contact' && k.name === name && k.revokedAt === undefined);
    if (existing.some((k) => equalBytes(k.publicKey, publicKey))) return 'unchanged';
    if (this.keys.some((k) => equalBytes(k.publicKey, publicKey) && k.revokedAt !== undefined)) {
      throw new Error('directory: this key has been revoked');
    }
    if (existing.length > 0) return 'key-changed';
    this.keys.push({ publicKey, keyId: await keyIdOf(publicKey), kind: 'contact', name, addedAt: nowUnix });
    return 'added';
  }

  /** Explicit re-pairing after the user has confirmed a key change. The old key is kept as revoked. */
  async replaceContactKey(name: string, publicKey: Uint8Array, nowUnix: number): Promise<void> {
    for (const k of this.keys) {
      if (k.kind === 'contact' && k.name === name && k.revokedAt === undefined) k.revokedAt = nowUnix;
    }
    this.keys.push({ publicKey, keyId: await keyIdOf(publicKey), kind: 'contact', name, addedAt: nowUnix });
  }

  removeName(name: string, kind: KeyKind): void {
    this.keys = this.keys.filter((k) => !(k.name === name && k.kind === kind));
    this.history.delete(name);
    if (kind === 'organisation') this.orgFetchedAt.delete(name);
  }

  /** Marks a key as revoked. Returns the affected entries. Unknown keys are remembered as revoked too. */
  async revoke(publicKey: Uint8Array, nowUnix: number): Promise<PinnedKey[]> {
    const hit = this.keys.filter((k) => equalBytes(k.publicKey, publicKey));
    for (const k of hit) if (k.revokedAt === undefined) k.revokedAt = nowUnix;
    return hit;
  }

  /** Imports a signed revocation statement. Returns the names it applied to, or null if it is not valid. */
  async importRevocation(text: string, nowUnix: number): Promise<string[] | null> {
    const parsed = await parseRevocation(text);
    if (!parsed) return null;
    const hit = await this.revoke(parsed.publicKey, nowUnix);
    return hit.map((k) => k.name);
  }

  /** Replaces the pinned keys of an organisation with a freshly fetched file. */
  async setOrganisation(locator: string, file: OrgFile, nowUnix: number): Promise<void> {
    const previous = this.keys.filter((k) => k.kind === 'organisation' && k.name === locator);
    this.keys = this.keys.filter((k) => !(k.kind === 'organisation' && k.name === locator));
    const revoked = (pk: Uint8Array) => file.revoked.find((r) => equalBytes(r.publicKey, pk));
    for (const entry of file.keys) {
      const r = revoked(entry.publicKey);
      const before = previous.find((k) => equalBytes(k.publicKey, entry.publicKey));
      this.keys.push({
        publicKey: entry.publicKey,
        keyId: await keyIdOf(entry.publicKey),
        kind: 'organisation',
        name: locator,
        label: entry.label,
        addedAt: before?.addedAt ?? nowUnix,
        notBefore: entry.notBefore,
        notAfter: entry.notAfter,
        revokedAt: r ? r.revokedAt || nowUnix : undefined,
      });
    }
    // Revoked keys that are no longer listed stay known, so their seals are red and not "unknown".
    for (const r of file.revoked) {
      if (this.keys.some((k) => k.name === locator && equalBytes(k.publicKey, r.publicKey))) continue;
      this.keys.push({
        publicKey: r.publicKey,
        keyId: await keyIdOf(r.publicKey),
        kind: 'organisation',
        name: locator,
        addedAt: nowUnix,
        revokedAt: r.revokedAt || nowUnix,
      });
    }
    this.orgFetchedAt.set(locator, nowUnix);
  }

  organisationAge(locator: string, nowUnix: number): number | null {
    const t = this.orgFetchedAt.get(locator);
    return t === undefined ? null : nowUnix - t;
  }

  organisations(): string[] {
    return [...this.orgFetchedAt.keys()];
  }

  /** Records whether a finished call from this identity was sealed. */
  recordCall(name: string, sealed: boolean): void {
    const h = this.history.get(name) ?? { sealed: 0, unsealed: 0 };
    if (sealed) h.sealed++;
    else h.unsealed++;
    this.history.set(name, h);
  }

  historyOf(name: string): CallHistory {
    return this.history.get(name) ?? { sealed: 0, unsealed: 0 };
  }

  /**
   * Whether an unsealed call from this identity should raise the strong
   * warning. Organisations that publish keys are expected to seal every call.
   * Contacts qualify once they have sealed at least 2 calls and most of
   * their calls.
   */
  usuallySeals(name: string): boolean {
    const keys = this.keys.filter((k) => k.name === name && k.revokedAt === undefined);
    if (keys.length === 0) return false;
    if (keys.some((k) => k.kind === 'organisation')) return true;
    const h = this.historyOf(name);
    return h.sealed >= 2 && h.sealed >= 2 * h.unsealed;
  }

  toJSON(): DirectorySnapshot {
    return {
      version: 1,
      keys: this.keys.map((k) => ({
        publicKey: toBase64Url(k.publicKey),
        kind: k.kind,
        name: k.name,
        label: k.label,
        addedAt: k.addedAt,
        notBefore: k.notBefore,
        notAfter: k.notAfter,
        revokedAt: k.revokedAt,
      })),
      history: Object.fromEntries(this.history),
      orgFetchedAt: Object.fromEntries(this.orgFetchedAt),
    };
  }

  static async fromJSON(snapshot: unknown): Promise<KeyDirectory> {
    const dir = new KeyDirectory();
    const s = snapshot as DirectorySnapshot | null;
    if (!s || s.version !== 1 || !Array.isArray(s.keys)) return dir;
    for (const k of s.keys) {
      try {
        const publicKey = fromBase64Url(k.publicKey);
        if (publicKey.length !== 32) continue;
        dir.keys.push({
          publicKey,
          keyId: await keyIdOf(publicKey),
          kind: k.kind === 'organisation' ? 'organisation' : 'contact',
          name: String(k.name),
          label: k.label,
          addedAt: Number(k.addedAt) || 0,
          notBefore: k.notBefore,
          notAfter: k.notAfter,
          revokedAt: k.revokedAt,
        });
      } catch {
        // skip unreadable entries
      }
    }
    for (const [name, h] of Object.entries(s.history ?? {})) {
      dir.history.set(name, { sealed: Number(h.sealed) || 0, unsealed: Number(h.unsealed) || 0 });
    }
    for (const [name, t] of Object.entries(s.orgFetchedAt ?? {})) dir.orgFetchedAt.set(name, Number(t) || 0);
    return dir;
  }
}

export function publicKeyLabel(publicKey: Uint8Array): string {
  return toHex(publicKey.slice(0, 6));
}
