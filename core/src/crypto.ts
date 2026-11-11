// Ed25519 and hashing through WebCrypto, with a software fallback.
//
// The preferred key is a non-extractable WebCrypto key: page script can ask
// it to sign but can never read the private bytes. Browsers that do not offer
// Ed25519 in WebCrypto use a software key instead; callers must surface the
// `software` flag to the user as a warning.

import { concatBytes, toHex, utf8 } from './bytes.ts';

export interface Signer {
  /** Raw 32-byte Ed25519 public key. */
  publicKey: Uint8Array;
  /** True when the private key is held in script-readable memory. */
  software: boolean;
  sign(message: Uint8Array): Promise<Uint8Array>;
}

const ED: AlgorithmIdentifier = { name: 'Ed25519' };

function subtle(): SubtleCrypto {
  const c = globalThis.crypto;
  if (!c || !c.subtle) throw new Error('WebCrypto is not available');
  return c.subtle;
}

let nativeSupport: Promise<boolean> | null = null;

/** Whether this runtime can create and use Ed25519 keys in WebCrypto. */
export function supportsNativeEd25519(): Promise<boolean> {
  if (!nativeSupport) {
    nativeSupport = (async () => {
      try {
        const pair = (await subtle().generateKey(ED, false, ['sign', 'verify'])) as CryptoKeyPair;
        const sig = await subtle().sign(ED, pair.privateKey, new Uint8Array(1));
        return sig.byteLength === 64;
      } catch {
        return false;
      }
    })();
  }
  return nativeSupport;
}

/** For tests: force the software path. */
export function overrideNativeSupport(value: boolean | null): void {
  nativeSupport = value === null ? null : Promise.resolve(value);
}

export interface NativeIdentity {
  privateKey: CryptoKey;
  publicKey: Uint8Array;
}

/** Creates a non-extractable Ed25519 key pair. */
export async function generateNativeIdentity(): Promise<NativeIdentity> {
  const pair = (await subtle().generateKey(ED, false, ['sign', 'verify'])) as CryptoKeyPair;
  const raw = new Uint8Array(await subtle().exportKey('raw', pair.publicKey));
  return { privateKey: pair.privateKey, publicKey: raw };
}

export function nativeSigner(identity: NativeIdentity): Signer {
  return {
    publicKey: identity.publicKey,
    software: false,
    async sign(message) {
      return new Uint8Array(await subtle().sign(ED, identity.privateKey, message as BufferSource));
    },
  };
}

async function noble(): Promise<typeof import('@noble/ed25519')> {
  return import('@noble/ed25519');
}

/** Creates 32 random secret bytes for a software key. */
export function generateSoftwareSecret(): Uint8Array {
  return globalThis.crypto.getRandomValues(new Uint8Array(32));
}

export async function softwareSigner(secret: Uint8Array): Promise<Signer> {
  if (secret.length !== 32) throw new Error('software key must be 32 bytes');
  const ed = await noble();
  const publicKey = await ed.getPublicKeyAsync(secret);
  return {
    publicKey,
    software: true,
    async sign(message) {
      return ed.signAsync(message, secret);
    },
  };
}

/** Creates the best signer this runtime supports. */
export async function createSigner(): Promise<{ signer: Signer; native?: NativeIdentity; secret?: Uint8Array }> {
  if (await supportsNativeEd25519()) {
    const native = await generateNativeIdentity();
    return { signer: nativeSigner(native), native };
  }
  const secret = generateSoftwareSecret();
  return { signer: await softwareSigner(secret), secret };
}

const importedKeys = new Map<string, Promise<CryptoKey>>();

export async function verifySignature(
  publicKey: Uint8Array,
  signature: Uint8Array,
  message: Uint8Array,
): Promise<boolean> {
  if (publicKey.length !== 32 || signature.length !== 64) return false;
  try {
    if (await supportsNativeEd25519()) {
      const id = toHex(publicKey);
      let key = importedKeys.get(id);
      if (!key) {
        key = subtle().importKey('raw', publicKey as BufferSource, ED, true, ['verify']);
        importedKeys.set(id, key);
        if (importedKeys.size > 256) importedKeys.delete(importedKeys.keys().next().value as string);
      }
      return await subtle().verify(ED, await key, signature as BufferSource, message as BufferSource);
    }
    const ed = await noble();
    return await ed.verifyAsync(signature, message, publicKey);
  } catch {
    return false;
  }
}

export async function sha256(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await subtle().digest('SHA-256', data as BufferSource));
}

export const KEY_ID_LENGTH = 4;

/** Short identifier carried in every statement so the verifier knows which pinned key to try. */
export async function keyIdOf(publicKey: Uint8Array): Promise<Uint8Array> {
  const h = await sha256(concatBytes(utf8('LiveSeal key id v1\0'), publicKey));
  return h.slice(0, KEY_ID_LENGTH);
}

/** Human-readable fingerprint of one key: 8 groups of 4 hex digits. */
export async function fingerprintOf(publicKey: Uint8Array): Promise<string> {
  const h = await sha256(concatBytes(utf8('LiveSeal fingerprint v1\0'), publicKey));
  return (toHex(h.slice(0, 16)).match(/.{4}/g) as string[]).join(' ');
}

/**
 * Safety number for a pair of keys: the same on both devices regardless of who
 * computes it. Two people compare it over another channel to confirm that
 * they hold each other's real keys. 6 groups of 5 digits (about 100 bits).
 */
export async function safetyNumber(a: Uint8Array, b: Uint8Array): Promise<string> {
  let first = a;
  let second = b;
  for (let i = 0; i < 32; i++) {
    if (a[i] !== b[i]) {
      if (a[i] > b[i]) { first = b; second = a; }
      break;
    }
  }
  let h = concatBytes(utf8('LiveSeal safety number v1\0'), first, second);
  // Iterated hashing makes a brute-force search for a look-alike number slower.
  for (let i = 0; i < 2048; i++) h = await sha256(h);
  const groups: string[] = [];
  for (let g = 0; g < 6; g++) {
    const o = g * 5;
    const v = h[o] * 0x100000000 + (h[o + 1] * 0x1000000 + ((h[o + 2] << 16) | (h[o + 3] << 8) | h[o + 4]));
    groups.push(String(v % 100000).padStart(5, '0'));
  }
  return groups.join(' ');
}

export function randomBytes(n: number): Uint8Array {
  return globalThis.crypto.getRandomValues(new Uint8Array(n));
}
