// Candidate robust hashes. Each maps an image patch to real-valued features;
// the sign of a feature is one digest bit and its magnitude says how stable
// that bit is. The candidates were compared on real codec output and attack
// videos (docs/EVALUATION.md, section 3); the digest in digest.ts uses the
// winner.

import { prng } from './bytes.ts';

export type HashKind = 'dct' | 'gradient' | 'block' | 'projection';
export const HASH_KINDS: readonly HashKind[] = ['dct', 'gradient', 'block', 'projection'];

/** Zero mean, unit variance. Makes every hash insensitive to brightness and contrast changes. */
export function normalise(patch: ArrayLike<number>, out?: Float32Array): Float32Array {
  const n = patch.length;
  const dst = out ?? new Float32Array(n);
  let mean = 0;
  for (let i = 0; i < n; i++) mean += patch[i];
  mean /= n;
  let v = 0;
  for (let i = 0; i < n; i++) {
    const d = patch[i] - mean;
    v += d * d;
  }
  const scale = 1 / Math.sqrt(v / n + 1);
  for (let i = 0; i < n; i++) dst[i] = (patch[i] - mean) * scale;
  return dst;
}

/** Averages a w x h image into gw x gh blocks (w and h need not be multiples). */
function blocks(img: ArrayLike<number>, w: number, h: number, gw: number, gh: number): Float32Array {
  const out = new Float32Array(gw * gh);
  const cnt = new Float32Array(gw * gh);
  for (let y = 0; y < h; y++) {
    const by = Math.min(gh - 1, Math.floor((y * gh) / h));
    for (let x = 0; x < w; x++) {
      const bx = Math.min(gw - 1, Math.floor((x * gw) / w));
      out[by * gw + bx] += img[y * w + x];
      cnt[by * gw + bx]++;
    }
  }
  for (let i = 0; i < out.length; i++) out[i] /= cnt[i];
  return out;
}

const cosTables = new Map<number, Float32Array>();
function cosTable(n: number): Float32Array {
  let t = cosTables.get(n);
  if (!t) {
    t = new Float32Array(n * n);
    for (let k = 0; k < n; k++) for (let x = 0; x < n; x++) t[k * n + x] = Math.cos((Math.PI * (2 * x + 1) * k) / (2 * n));
    cosTables.set(n, t);
  }
  return t;
}

const zigzags = new Map<string, Int32Array>();
/** Coefficient order by increasing frequency, skipping the DC term. Returns u * n + v indexes. */
function zigzag(n: number, count: number): Int32Array {
  const key = `${n}/${count}`;
  let z = zigzags.get(key);
  if (!z) {
    const list: number[] = [];
    for (let s = 1; list.length < count && s < 2 * n - 1; s++) {
      for (let u = Math.max(0, s - n + 1); u <= Math.min(s, n - 1) && list.length < count; u++) list.push(u * n + (s - u));
    }
    z = Int32Array.from(list);
    zigzags.set(key, z);
  }
  return z;
}

/** Lowest `count` non-DC DCT coefficients of a square patch. */
function dctFeatures(patch: Float32Array, size: number, count: number): Float32Array {
  const table = cosTable(size);
  const order = zigzag(size, count);
  let maxU = 0;
  for (const idx of order) maxU = Math.max(maxU, Math.floor(idx / size), idx % size);
  const rows = maxU + 1;
  // horizontal pass for the needed frequencies only
  const tmp = new Float32Array(size * rows);
  for (let y = 0; y < size; y++) {
    for (let v = 0; v < rows; v++) {
      let acc = 0;
      for (let x = 0; x < size; x++) acc += patch[y * size + x] * table[v * size + x];
      tmp[y * rows + v] = acc;
    }
  }
  const out = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const u = Math.floor(order[i] / size);
    const v = order[i] % size;
    let acc = 0;
    for (let y = 0; y < size; y++) acc += tmp[y * rows + v] * table[u * size + y];
    out[i] = acc / size;
  }
  return out;
}

const projections = new Map<string, Float32Array[]>();
/** Fixed smooth random patterns: blurred white noise, zero mean, unit energy. */
function projectionPatterns(size: number, count: number): Float32Array[] {
  const key = `${size}/${count}`;
  let p = projections.get(key);
  if (!p) {
    const rand = prng(0x70a77e21);
    p = [];
    for (let k = 0; k < count; k++) {
      const noise = new Float32Array(size * size);
      for (let i = 0; i < noise.length; i++) noise[i] = (rand() / 2147483648) - 1;
      // two box blurs approximate a Gaussian with a radius that keeps mid-scale structure
      let cur = noise;
      for (let pass = 0; pass < 2; pass++) {
        const next = new Float32Array(size * size);
        const r = 2;
        for (let y = 0; y < size; y++) {
          for (let x = 0; x < size; x++) {
            let acc = 0;
            let n = 0;
            for (let dy = -r; dy <= r; dy++) {
              for (let dx = -r; dx <= r; dx++) {
                const yy = y + dy;
                const xx = x + dx;
                if (yy < 0 || yy >= size || xx < 0 || xx >= size) continue;
                acc += cur[yy * size + xx];
                n++;
              }
            }
            next[y * size + x] = acc / n;
          }
        }
        cur = next;
      }
      p.push(normalise(cur));
    }
    projections.set(key, p);
  }
  return p;
}

/**
 * Real-valued features of a square patch (`size` x `size`, any luma scale).
 * The digest bit is `feature > 0`.
 */
export function patchFeatures(kind: HashKind, patch: ArrayLike<number>, size: number, bits: number): Float32Array {
  const norm = normalise(patch);
  switch (kind) {
    case 'dct':
      return dctFeatures(norm, size, bits);
    case 'gradient': {
      // differences between neighbouring block means, alternating horizontal and vertical
      const g = Math.ceil(Math.sqrt(bits / 2)) + 1;
      const b = blocks(norm, size, size, g, g);
      const out = new Float32Array(bits);
      let i = 0;
      for (let y = 0; y < g && i < bits; y++) {
        for (let x = 0; x < g - 1 && i < bits; x++) {
          out[i++] = b[y * g + x + 1] - b[y * g + x];
          if (i < bits && y < g - 1) out[i++] = b[(y + 1) * g + x] - b[y * g + x];
        }
      }
      return out;
    }
    case 'block': {
      // each block mean against the median of all block means
      const g = Math.ceil(Math.sqrt(bits));
      const b = blocks(norm, size, size, g, g);
      const sorted = Float32Array.from(b).sort();
      const median = (sorted[(sorted.length - 1) >> 1] + sorted[sorted.length >> 1]) / 2;
      const out = new Float32Array(bits);
      for (let i = 0; i < bits; i++) out[i] = b[i] - median;
      return out;
    }
    case 'projection': {
      const pats = projectionPatterns(size, bits);
      const out = new Float32Array(bits);
      for (let k = 0; k < bits; k++) {
        let acc = 0;
        const p = pats[k];
        for (let i = 0; i < norm.length; i++) acc += norm[i] * p[i];
        out[k] = acc / Math.sqrt(norm.length);
      }
      return out;
    }
  }
}

/** Features of a rectangular thumbnail: DCT of its block means. Used for the whole-frame part. */
export function thumbFeatures(thumb: ArrayLike<number>, w: number, h: number, bits: number): Float32Array {
  const g = 16;
  const b = normalise(blocks(thumb, w, h, g, g));
  return dctFeatures(b, g, bits);
}

export function packBits(features: ArrayLike<number>, out: Uint8Array, bitOffset: number): void {
  for (let i = 0; i < features.length; i++) {
    if (features[i] > 0) out[(bitOffset + i) >> 3] |= 1 << (7 - ((bitOffset + i) & 7));
  }
}

export function getBit(bytes: Uint8Array, index: number): number {
  return (bytes[index >> 3] >> (7 - (index & 7))) & 1;
}
