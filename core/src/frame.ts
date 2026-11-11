// Channel frame: wraps the statement's wire bytes in a length byte, padding
// and a CRC-32, then protects everything with Reed-Solomon. The CRC makes
// sure a wrongly corrected codeword is reported as "unreadable" and can never
// reach the signature check, where it would look like tampering.

import { crc32 } from './bytes.ts';
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

export function buildCodeword(wire: Uint8Array, p: FrameParams): Uint8Array {
  const k = p.n - p.parity;
  if (wire.length > frameCapacity(p)) throw new Error(`frame: statement of ${wire.length} bytes does not fit`);
  const data = new Uint8Array(k);
  data[0] = wire.length;
  data.set(wire, 1);
  const crc = crc32(data.subarray(0, k - 4));
  data[k - 4] = crc >>> 24;
  data[k - 3] = (crc >>> 16) & 0xff;
  data[k - 2] = (crc >>> 8) & 0xff;
  data[k - 1] = crc & 0xff;
  return rsEncode(data, p.parity);
}

function unpack(data: Uint8Array): Uint8Array | null {
  const k = data.length;
  const crc = crc32(data.subarray(0, k - 4));
  const got = ((data[k - 4] << 24) | (data[k - 3] << 16) | (data[k - 2] << 8) | data[k - 1]) >>> 0;
  if (crc !== got) return null;
  const len = data[0];
  if (len > k - 5) return null;
  for (let i = 1 + len; i < k - 4; i++) if (data[i] !== 0) return null;
  return data.slice(1, 1 + len);
}

export interface FrameDecode {
  wire: Uint8Array;
  /** Bytes the decoder had to change. */
  corrected: number;
  /** Erasures declared in the attempt that succeeded. */
  erasures: number;
}

/**
 * Decodes a received codeword. `reliability` gives one value per byte, larger
 * meaning more trustworthy. The decoder first tries with no erasures, then
 * declares the least reliable bytes as erasures in growing steps. The first
 * attempt whose result passes the CRC wins.
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
    const wire = unpack(res.message);
    if (wire) return { wire, corrected: res.corrected, erasures: count };
  }
  return null;
}
