// Channel frame: wraps the statement's wire bytes in a length byte, padding
// and a CRC-32, then protects everything with an error-correcting code.
// The CRC makes sure a wrongly corrected frame is reported as "unreadable"
// and can never reach the signature check, where it would look like tampering.
//
// Two codes are implemented behind one interface so that the simulator can
// compare them on the same channel:
//   'rs'    Reed-Solomon over bytes, hard decisions with reliability-guided erasures
//   'ldpc'  bit-level LDPC with soft decisions and a bit interleaver

import { crc32, prng } from './bytes.ts';
import { ldpcDecode, ldpcEncode, makeLdpc } from './ldpc.ts';
import { rsDecode, rsEncode } from './rs.ts';

export interface FrameParams {
  /** Codeword length in bytes (at most 255). */
  n: number;
  /** Reed-Solomon parity bytes. */
  parity: number;
}

export function frameCapacity(p: FrameParams): number {
  return p.n - p.parity - 1 - 4;
}

/** length(1) || wire || zero padding || CRC-32(4), exactly `k` bytes. */
export function packData(wire: Uint8Array, k: number): Uint8Array {
  if (wire.length > k - 5) throw new Error(`frame: statement of ${wire.length} bytes does not fit`);
  const data = new Uint8Array(k);
  data[0] = wire.length;
  data.set(wire, 1);
  const crc = crc32(data.subarray(0, k - 4));
  data[k - 4] = crc >>> 24;
  data[k - 3] = (crc >>> 16) & 0xff;
  data[k - 2] = (crc >>> 8) & 0xff;
  data[k - 1] = crc & 0xff;
  return data;
}

export function unpackData(data: Uint8Array): Uint8Array | null {
  const k = data.length;
  const crc = crc32(data.subarray(0, k - 4));
  const got = ((data[k - 4] << 24) | (data[k - 3] << 16) | (data[k - 2] << 8) | data[k - 1]) >>> 0;
  if (crc !== got) return null;
  const len = data[0];
  if (len > k - 5) return null;
  for (let i = 1 + len; i < k - 4; i++) if (data[i] !== 0) return null;
  return data.slice(1, 1 + len);
}

export function buildCodeword(wire: Uint8Array, p: FrameParams): Uint8Array {
  return rsEncode(packData(wire, p.n - p.parity), p.parity);
}

export interface FrameDecode {
  wire: Uint8Array;
  /** Bytes the decoder had to change. */
  corrected: number;
  /** Erasures declared in the attempt that succeeded. */
  erasures: number;
}

/**
 * Decodes a received Reed-Solomon codeword. `reliability` gives one value per
 * byte, larger meaning more trustworthy. The decoder first tries with no
 * erasures, then declares the least reliable bytes as erasures in growing
 * steps. The first attempt whose result passes the CRC wins.
 */
export function decodeCodeword(codeword: Uint8Array, reliability: ArrayLike<number> | null, p: FrameParams): FrameDecode | null {
  if (codeword.length !== p.n) throw new Error('frame: wrong codeword length');
  const order = Array.from({ length: p.n }, (_, i) => i);
  if (reliability) order.sort((a, b) => reliability[a] - reliability[b]);
  const steps = reliability ? [0, 0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875, 1] : [0];
  let last = -1;
  for (const step of steps) {
    const count = Math.round(step * p.parity);
    if (count === last) continue;
    last = count;
    const erasures = order.slice(0, count);
    const res = rsDecode(codeword, p.parity, erasures);
    if (!res) continue;
    const wire = unpackData(res.message);
    if (wire) return { wire, corrected: res.corrected, erasures: count };
  }
  return null;
}

// ---------------------------------------------------------------- generic

export type FecKind = 'rs' | 'ldpc';

export interface FecDecode {
  wire: Uint8Array;
  /** Channel bits whose hard decision disagreed with the decoded codeword. */
  bitErrors: number;
}

export interface Fec {
  kind: FecKind;
  /** Channel bits this code fills. */
  codedBits: number;
  /** Largest statement, in bytes, that fits in one frame. */
  capacity: number;
  /** Returns `codedBits` values, each 0 or 1. */
  encode(wire: Uint8Array): Uint8Array;
  /** `llr[i]` is positive when channel bit i is more likely 0; 0 means unknown. */
  decode(llr: Float32Array): FecDecode | null;
}

function bytesToBits(bytes: Uint8Array, out: Uint8Array): void {
  for (let i = 0; i < bytes.length; i++) for (let b = 0; b < 8; b++) out[i * 8 + b] = (bytes[i] >> (7 - b)) & 1;
}

function countDisagreements(llr: Float32Array, bits: Uint8Array): number {
  let n = 0;
  for (let i = 0; i < bits.length; i++) if ((llr[i] < 0 ? 1 : 0) !== bits[i]) n++;
  return n;
}

function makeRsFec(availableBits: number, parity: number): Fec {
  const n = Math.min(255, Math.floor(availableBits / 8));
  const p: FrameParams = { n, parity };
  const codedBits = n * 8;
  return {
    kind: 'rs',
    codedBits,
    capacity: frameCapacity(p),
    encode(wire) {
      const bits = new Uint8Array(codedBits);
      bytesToBits(buildCodeword(wire, p), bits);
      return bits;
    },
    decode(llr) {
      const codeword = new Uint8Array(n);
      const reliability = new Float32Array(n).fill(Infinity);
      for (let i = 0; i < codedBits; i++) {
        const v = llr[i];
        if (v < 0) codeword[i >> 3] |= 1 << (7 - (i & 7));
        const a = v < 0 ? -v : v;
        if (a < reliability[i >> 3]) reliability[i >> 3] = a;
      }
      const res = decodeCodeword(codeword, reliability, p);
      if (!res) return null;
      const bits = new Uint8Array(codedBits);
      bytesToBits(buildCodeword(res.wire, p), bits);
      return { wire: res.wire, bitErrors: countDisagreements(llr, bits) };
    },
  };
}

function makeLdpcFec(availableBits: number, infoBytes: number): Fec {
  const n = availableBits;
  const k = infoBytes * 8;
  // each information bit takes part in this many checks: 3 near rate 1/2, more for lower rates
  const code = makeLdpc(n, k, 0x1d9c, Math.max(3, Math.round((n - k) / k)));
  // Fixed pseudo-random interleaver: code bit i travels in channel position perm[i].
  // Neighbouring cells (which tend to fail together) then land far apart in the code.
  const perm = Int32Array.from({ length: n }, (_, i) => i);
  const rand = prng(0x1e4f);
  for (let i = n - 1; i > 0; i--) {
    const j = rand() % (i + 1);
    const t = perm[i]; perm[i] = perm[j]; perm[j] = t;
  }
  const encodeBits = (wire: Uint8Array): Uint8Array => {
    const info = new Uint8Array(k);
    bytesToBits(packData(wire, infoBytes), info);
    const cw = ldpcEncode(code, info);
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) out[perm[i]] = cw[i];
    return out;
  };
  return {
    kind: 'ldpc',
    codedBits: n,
    capacity: infoBytes - 5,
    encode: encodeBits,
    decode(llr) {
      const ordered = new Float32Array(n);
      for (let i = 0; i < n; i++) ordered[i] = llr[perm[i]];
      const res = ldpcDecode(code, ordered);
      if (!res) return null;
      const data = new Uint8Array(infoBytes);
      for (let i = 0; i < k; i++) if (res.info[i]) data[i >> 3] |= 1 << (7 - (i & 7));
      const wire = unpackData(data);
      if (!wire) return null;
      return { wire, bitErrors: countDisagreements(llr, encodeBits(wire)) };
    },
  };
}

/**
 * `redundancy` is the number of Reed-Solomon parity bytes for 'rs', and the
 * number of information bytes (length, statement, padding, CRC) for 'ldpc'.
 */
export function makeFec(kind: FecKind, availableBits: number, redundancy: number): Fec {
  return kind === 'rs' ? makeRsFec(availableBits, redundancy) : makeLdpcFec(availableBits, redundancy);
}
