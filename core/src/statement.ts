// The signed statement that a seal carries. See docs/PROTOCOL.md.

import { concatBytes, utf8 } from './bytes.ts';
import { decodeCbor, encodeCbor, type CborValue } from './cbor.ts';
import { KEY_ID_LENGTH, type Signer, verifySignature } from './crypto.ts';
import { CHALLENGE_LENGTH } from './words.ts';

export const PROTOCOL_VERSION = 1;

/** Length of one seal period in milliseconds. One statement is sent per period. */
export const PERIOD_MS = 2000;

export const SESSION_LENGTH = CHALLENGE_LENGTH;
export const NO_SESSION: Uint8Array = new Uint8Array(SESSION_LENGTH);
export const FACE_BOX_LENGTH = 4;
export const MAX_DIGEST_LENGTH = 64;
export const SIGNATURE_LENGTH = 64;

const DOMAIN = utf8('LiveSeal statement v1\0');

export interface Statement {
  version: number;
  /** The verifier's challenge this seal answers, or all zero when none is active. */
  session: Uint8Array;
  /** Identifies the signing key among the verifier's pinned keys. */
  keyId: Uint8Array;
  /**
   * Index of the period in which this statement is transmitted:
   * floor(sender Unix time in ms / PERIOD_MS). It is both the timestamp and
   * the replay counter. The digest describes the frames of period - 1.
   */
  period: number;
  /** Face position in the digested frames: x, y, width, height in 1/256 of the frame. All zero: no face found. */
  faceBox: Uint8Array;
  /** Robust content digest of the previous period (core/src/digest.ts). */
  digest: Uint8Array;
  /** A challenge this sender is issuing to its peer, or empty. Lets two LiveSeal users challenge each other without typing. */
  challenge: Uint8Array;
}

export interface SignedStatement {
  statement: Statement;
  signature: Uint8Array;
}

function fields(s: Statement): CborValue[] {
  return [s.version, s.session, s.keyId, s.period, s.faceBox, s.digest, s.challenge];
}

function validate(s: Statement): void {
  if (!Number.isInteger(s.version) || s.version < 0 || s.version > 255) throw new Error('statement: bad version');
  if (s.session.length !== SESSION_LENGTH) throw new Error('statement: bad session length');
  if (s.keyId.length !== KEY_ID_LENGTH) throw new Error('statement: bad key id length');
  if (!Number.isInteger(s.period) || s.period < 0 || s.period > 0xffffffff) throw new Error('statement: bad period');
  if (s.faceBox.length !== FACE_BOX_LENGTH) throw new Error('statement: bad face box');
  if (s.digest.length < 1 || s.digest.length > MAX_DIGEST_LENGTH) throw new Error('statement: bad digest length');
  if (s.challenge.length !== 0 && s.challenge.length !== CHALLENGE_LENGTH) throw new Error('statement: bad challenge');
}

/** The exact bytes covered by the signature. */
export function signedBytes(s: Statement): Uint8Array {
  validate(s);
  return concatBytes(DOMAIN, encodeCbor(fields(s)));
}

/** Signs a statement and returns the wire encoding that is embedded in the video. */
export async function signStatement(s: Statement, signer: Signer): Promise<Uint8Array> {
  const signature = await signer.sign(signedBytes(s));
  if (signature.length !== SIGNATURE_LENGTH) throw new Error('statement: unexpected signature length');
  return encodeCbor([...fields(s), signature]);
}

/**
 * Parses wire bytes. Returns null for anything that is not exactly a
 * well-formed statement; never throws on attacker-controlled input.
 */
export function parseStatement(wire: Uint8Array): SignedStatement | null {
  let value: CborValue;
  try {
    value = decodeCbor(wire);
  } catch {
    return null;
  }
  if (!Array.isArray(value) || value.length !== 8) return null;
  const [version, session, keyId, period, faceBox, digest, challenge, signature] = value;
  if (typeof version !== 'number' || typeof period !== 'number') return null;
  if (!(session instanceof Uint8Array) || !(keyId instanceof Uint8Array) || !(faceBox instanceof Uint8Array)) return null;
  if (!(digest instanceof Uint8Array) || !(challenge instanceof Uint8Array) || !(signature instanceof Uint8Array)) return null;
  if (signature.length !== SIGNATURE_LENGTH) return null;
  const statement: Statement = { version, session, keyId, period, faceBox, digest, challenge };
  try {
    validate(statement);
  } catch {
    return null;
  }
  return { statement, signature };
}

export async function verifyStatement(signed: SignedStatement, publicKey: Uint8Array): Promise<boolean> {
  return verifySignature(publicKey, signed.signature, signedBytes(signed.statement));
}

/** Period index for a Unix time in milliseconds. */
export function periodOf(unixMs: number): number {
  return Math.floor(unixMs / PERIOD_MS);
}

/** Largest wire size for a given digest length; used to size the channel frame. */
export function maxWireLength(digestLength: number): number {
  // array head 1, version 1-2, session 1+3, key id 1+4, period 5, face box 1+4,
  // digest head (1 or 2) + n, challenge 1+3, signature 2+64
  return 1 + 2 + 4 + 5 + 5 + 5 + (digestLength < 24 ? 1 : 2) + digestLength + 4 + 66;
}
