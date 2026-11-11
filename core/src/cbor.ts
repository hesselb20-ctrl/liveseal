// Minimal deterministic CBOR (RFC 8949, core deterministic encoding).
// Supports exactly what the protocol needs: unsigned and negative integers,
// byte strings, text strings, arrays, maps, booleans and null. The decoder is
// strict: it rejects non-minimal integer encodings, indefinite lengths, tags,
// floats, unsorted or duplicate map keys and trailing bytes, so that a given
// value has exactly one accepted encoding.

import { concatBytes, fromUtf8, utf8 } from './bytes.ts';

export type CborValue =
  | number
  | string
  | boolean
  | null
  | Uint8Array
  | CborValue[]
  | Map<number | string, CborValue>;

function head(major: number, n: number): Uint8Array {
  if (!Number.isSafeInteger(n) || n < 0) throw new Error('cbor: length out of range');
  const m = major << 5;
  if (n < 24) return Uint8Array.of(m | n);
  if (n < 0x100) return Uint8Array.of(m | 24, n);
  if (n < 0x10000) return Uint8Array.of(m | 25, n >>> 8, n & 0xff);
  if (n < 0x100000000) return Uint8Array.of(m | 26, n >>> 24, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff);
  const hi = Math.floor(n / 0x100000000);
  const lo = n >>> 0;
  return Uint8Array.of(
    m | 27,
    (hi >>> 24) & 0xff, (hi >>> 16) & 0xff, (hi >>> 8) & 0xff, hi & 0xff,
    (lo >>> 24) & 0xff, (lo >>> 16) & 0xff, (lo >>> 8) & 0xff, lo & 0xff,
  );
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
}

export function encodeCbor(value: CborValue): Uint8Array {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new Error('cbor: only safe integers are supported');
    return value >= 0 ? head(0, value) : head(1, -1 - value);
  }
  if (typeof value === 'string') {
    const bytes = utf8(value);
    return concatBytes(head(3, bytes.length), bytes);
  }
  if (typeof value === 'boolean') return Uint8Array.of(value ? 0xf5 : 0xf4);
  if (value === null) return Uint8Array.of(0xf6);
  if (value instanceof Uint8Array) return concatBytes(head(2, value.length), value);
  if (Array.isArray(value)) return concatBytes(head(4, value.length), ...value.map(encodeCbor));
  if (value instanceof Map) {
    const entries: [Uint8Array, Uint8Array][] = [];
    for (const [k, v] of value) entries.push([encodeCbor(k), encodeCbor(v)]);
    entries.sort((x, y) => compareBytes(x[0], y[0]));
    for (let i = 1; i < entries.length; i++) {
      if (compareBytes(entries[i - 1][0], entries[i][0]) === 0) throw new Error('cbor: duplicate map key');
    }
    return concatBytes(head(5, entries.length), ...entries.flatMap((e) => [e[0], e[1]]));
  }
  throw new Error('cbor: unsupported value');
}

const MAX_DEPTH = 8;

export function decodeCbor(bytes: Uint8Array): CborValue {
  let pos = 0;

  function need(n: number): void {
    if (pos + n > bytes.length) throw new Error('cbor: truncated');
  }

  function readHead(): { major: number; n: number } {
    need(1);
    const first = bytes[pos++];
    const major = first >> 5;
    const info = first & 0x1f;
    if (info < 24) return { major, n: info };
    if (info === 24) {
      need(1);
      const n = bytes[pos++];
      if (n < 24) throw new Error('cbor: non-minimal integer');
      return { major, n };
    }
    if (info === 25) {
      need(2);
      const n = (bytes[pos] << 8) | bytes[pos + 1];
      pos += 2;
      if (n < 0x100) throw new Error('cbor: non-minimal integer');
      return { major, n };
    }
    if (info === 26) {
      need(4);
      const n = bytes[pos] * 0x1000000 + ((bytes[pos + 1] << 16) | (bytes[pos + 2] << 8) | bytes[pos + 3]);
      pos += 4;
      if (n < 0x10000) throw new Error('cbor: non-minimal integer');
      return { major, n };
    }
    if (info === 27) {
      need(8);
      const hi = bytes[pos] * 0x1000000 + ((bytes[pos + 1] << 16) | (bytes[pos + 2] << 8) | bytes[pos + 3]);
      const lo = bytes[pos + 4] * 0x1000000 + ((bytes[pos + 5] << 16) | (bytes[pos + 6] << 8) | bytes[pos + 7]);
      pos += 8;
      if (hi === 0) throw new Error('cbor: non-minimal integer');
      const n = hi * 0x100000000 + lo;
      if (!Number.isSafeInteger(n)) throw new Error('cbor: integer too large');
      return { major, n };
    }
    throw new Error('cbor: indefinite lengths and reserved values are not allowed');
  }

  function read(depth: number): CborValue {
    if (depth > MAX_DEPTH) throw new Error('cbor: nesting too deep');
    need(1);
    const first = bytes[pos];
    if (first === 0xf4) { pos++; return false; }
    if (first === 0xf5) { pos++; return true; }
    if (first === 0xf6) { pos++; return null; }
    const { major, n } = readHead();
    switch (major) {
      case 0:
        return n;
      case 1:
        return -1 - n;
      case 2: {
        need(n);
        const out = bytes.slice(pos, pos + n);
        pos += n;
        return out;
      }
      case 3: {
        need(n);
        const text = fromUtf8(bytes.subarray(pos, pos + n));
        pos += n;
        return text;
      }
      case 4: {
        if (n > bytes.length) throw new Error('cbor: truncated');
        const arr: CborValue[] = [];
        for (let i = 0; i < n; i++) arr.push(read(depth + 1));
        return arr;
      }
      case 5: {
        if (n > bytes.length) throw new Error('cbor: truncated');
        const map = new Map<number | string, CborValue>();
        let prevKey: Uint8Array | null = null;
        for (let i = 0; i < n; i++) {
          const start = pos;
          const key = read(depth + 1);
          if (typeof key !== 'number' && typeof key !== 'string') throw new Error('cbor: unsupported map key');
          const keyBytes = bytes.subarray(start, pos);
          if (prevKey && compareBytes(prevKey, keyBytes) >= 0) throw new Error('cbor: map keys not in canonical order');
          prevKey = keyBytes;
          map.set(key, read(depth + 1));
        }
        return map;
      }
      default:
        throw new Error('cbor: unsupported major type');
    }
  }

  const value = read(0);
  if (pos !== bytes.length) throw new Error('cbor: trailing bytes');
  return value;
}
