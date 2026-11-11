// A systematic repeat-accumulate LDPC code with soft-decision decoding.
//
// Parity-check matrix H = [A | D]:
//   A (m x k) is sparse and pseudo-random, with `infoWeight` ones per column;
//   D (m x m) is dual-diagonal, so parity bits form an accumulator chain and
//   encoding is one pass: p[0] = s[0], p[i] = p[i-1] xor s[i], with s = A*u.
// The construction is deterministic from (n, k, seed), so both ends build
// the same code. Decoding is normalised min-sum belief propagation on
// log-likelihood ratios (positive means the bit is more likely 0).

import { prng } from './bytes.ts';

export interface LdpcCode {
  n: number;
  k: number;
  m: number;
  /** For each check, the variables it involves (info bits 0..k-1, parity bits k..n-1), flattened. */
  checkVars: Int32Array;
  /** Offsets into checkVars, length m + 1. */
  checkStart: Int32Array;
  /** For each variable, the edge indices (positions in checkVars) it owns, flattened. */
  varEdges: Int32Array;
  varStart: Int32Array;
  /** For encoding: the checks of each info bit, k * infoWeight entries. */
  infoChecks: Int32Array;
  infoWeight: number;
}

const codes = new Map<string, LdpcCode>();

export function makeLdpc(n: number, k: number, seed = 0x1d9c, infoWeight = 3): LdpcCode {
  const key = `${n}/${k}/${seed}/${infoWeight}`;
  const cached = codes.get(key);
  if (cached) return cached;
  const m = n - k;
  if (m < 8 || k < 8) throw new Error('ldpc: code too small');
  const rand = prng(seed);
  const degree = new Int32Array(m);
  const infoChecks = new Int32Array(k * infoWeight);
  const usedPairs = new Set<number>();
  const pairKey = (a: number, b: number) => (a < b ? a * m + b : b * m + a);
  for (let j = 0; j < k; j++) {
    let chosen: number[] = [];
    for (let attempt = 0; attempt < 200; attempt++) {
      chosen = [];
      // prefer lightly loaded checks so row weights stay even
      const limit = Math.floor((j * infoWeight) / m) + 1 + (attempt > 50 ? 1 : 0);
      let guard = 0;
      while (chosen.length < infoWeight && guard++ < 4000) {
        const c = rand() % m;
        if (degree[c] >= limit) continue;
        // no repeated check, no neighbouring checks (they share a parity bit), no pair used by another column
        if (chosen.some((x) => Math.abs(x - c) <= 1 || usedPairs.has(pairKey(x, c)))) continue;
        chosen.push(c);
      }
      if (chosen.length === infoWeight) break;
    }
    if (chosen.length !== infoWeight) throw new Error('ldpc: construction failed');
    for (let a = 0; a < infoWeight; a++) {
      degree[chosen[a]]++;
      infoChecks[j * infoWeight + a] = chosen[a];
      for (let b = a + 1; b < infoWeight; b++) usedPairs.add(pairKey(chosen[a], chosen[b]));
    }
  }
  // adjacency lists
  const perCheck: number[][] = Array.from({ length: m }, () => []);
  for (let j = 0; j < k; j++) for (let a = 0; a < infoWeight; a++) perCheck[infoChecks[j * infoWeight + a]].push(j);
  for (let i = 0; i < m; i++) {
    perCheck[i].push(k + i);
    if (i > 0) perCheck[i].push(k + i - 1);
  }
  const checkStart = new Int32Array(m + 1);
  for (let i = 0; i < m; i++) checkStart[i + 1] = checkStart[i] + perCheck[i].length;
  const edges = checkStart[m];
  const checkVars = new Int32Array(edges);
  const perVar: number[][] = Array.from({ length: n }, () => []);
  for (let i = 0; i < m; i++) {
    perCheck[i].forEach((v, idx) => {
      const e = checkStart[i] + idx;
      checkVars[e] = v;
      perVar[v].push(e);
    });
  }
  const varStart = new Int32Array(n + 1);
  for (let v = 0; v < n; v++) varStart[v + 1] = varStart[v] + perVar[v].length;
  const varEdges = new Int32Array(edges);
  for (let v = 0; v < n; v++) varEdges.set(perVar[v], varStart[v]);
  const code: LdpcCode = { n, k, m, checkVars, checkStart, varEdges, varStart, infoChecks, infoWeight };
  codes.set(key, code);
  return code;
}

/** Encodes k info bits (one per array element) into n code bits: info bits first, then parity. */
export function ldpcEncode(code: LdpcCode, info: Uint8Array): Uint8Array {
  if (info.length !== code.k) throw new Error('ldpc: wrong info length');
  const out = new Uint8Array(code.n);
  out.set(info);
  const s = new Uint8Array(code.m);
  for (let j = 0; j < code.k; j++) {
    if (!info[j]) continue;
    for (let a = 0; a < code.infoWeight; a++) s[code.infoChecks[j * code.infoWeight + a]] ^= 1;
  }
  let acc = 0;
  for (let i = 0; i < code.m; i++) {
    acc ^= s[i];
    out[code.k + i] = acc;
  }
  return out;
}

export interface LdpcResult {
  /** The k decoded info bits. */
  info: Uint8Array;
  iterations: number;
}

/**
 * Belief-propagation decoding (normalised min-sum, layered schedule). Checks
 * are visited in chain order, alternating forwards and backwards, so one
 * sweep carries information along the whole accumulator. Returns null when
 * no valid codeword is found within `maxIterations`. A returned result
 * always satisfies every parity check, but callers must still verify their
 * own checksum.
 */
export function ldpcDecode(code: LdpcCode, llr: Float32Array, maxIterations = 60): LdpcResult | null {
  const { n, k, m, checkVars, checkStart } = code;
  if (llr.length !== n) throw new Error('ldpc: wrong LLR length');
  const post = Float32Array.from(llr);
  const c2v = new Float32Array(checkVars.length);
  const ALPHA = 0.8;
  for (let iter = 1; iter <= maxIterations; iter++) {
    const forward = iter % 2 === 1;
    for (let step = 0; step < m; step++) {
      const i = forward ? step : m - 1 - step;
      const from = checkStart[i];
      const to = checkStart[i + 1];
      let min1 = Infinity;
      let min2 = Infinity;
      let minIdx = -1;
      let sign = 0;
      for (let e = from; e < to; e++) {
        const x = post[checkVars[e]] - c2v[e];
        post[checkVars[e]] = x; // now holds the variable-to-check message
        const a = x < 0 ? -x : x;
        if (x < 0) sign ^= 1;
        if (a < min1) { min2 = min1; min1 = a; minIdx = e; } else if (a < min2) min2 = a;
      }
      for (let e = from; e < to; e++) {
        const x = post[checkVars[e]];
        const mag = ALPHA * (e === minIdx ? min2 : min1);
        const msg = (sign ^ (x < 0 ? 1 : 0)) ? -mag : mag;
        c2v[e] = msg;
        post[checkVars[e]] = x + msg;
      }
    }
    let ok = true;
    for (let i = 0; i < m && ok; i++) {
      let parity = 0;
      for (let e = checkStart[i]; e < checkStart[i + 1]; e++) if (post[checkVars[e]] < 0) parity ^= 1;
      if (parity) ok = false;
    }
    if (ok) {
      const info = new Uint8Array(k);
      for (let j = 0; j < k; j++) info[j] = post[j] < 0 ? 1 : 0;
      return { info, iterations: iter };
    }
  }
  return null;
}
