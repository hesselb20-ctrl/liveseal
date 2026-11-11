// Reed-Solomon over GF(2^8), primitive polynomial 0x11d, generator 2,
// first consecutive root 2^0. Systematic encoder and an errors-and-erasures
// decoder (Forney syndromes, Berlekamp-Massey, Chien search, Forney algorithm).
// Polynomials are arrays with the highest-degree coefficient first.

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
}

function mul(a: number, b: number): number {
  return a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]];
}

function div(a: number, b: number): number {
  if (b === 0) throw new Error('rs: division by zero');
  return a === 0 ? 0 : EXP[LOG[a] + 255 - LOG[b]];
}

function pow(a: number, power: number): number {
  return EXP[(((LOG[a] * power) % 255) + 255) % 255];
}

function inverse(a: number): number {
  return EXP[255 - LOG[a]];
}

type Poly = number[];

function polyScale(p: Poly, x: number): Poly {
  return p.map((c) => mul(c, x));
}

function polyAdd(p: Poly, q: Poly): Poly {
  const r = new Array<number>(Math.max(p.length, q.length)).fill(0);
  for (let i = 0; i < p.length; i++) r[i + r.length - p.length] = p[i];
  for (let i = 0; i < q.length; i++) r[i + r.length - q.length] ^= q[i];
  return r;
}

function polyMul(p: Poly, q: Poly): Poly {
  const r = new Array<number>(p.length + q.length - 1).fill(0);
  for (let j = 0; j < q.length; j++) {
    if (q[j] === 0) continue;
    for (let i = 0; i < p.length; i++) r[i + j] ^= mul(p[i], q[j]);
  }
  return r;
}

function polyEval(p: ArrayLike<number>, x: number): number {
  let y = p[0];
  for (let i = 1; i < p.length; i++) y = mul(y, x) ^ p[i];
  return y;
}

/** Remainder of dividend / divisor for a monic divisor. */
function polyRemainder(dividend: Poly, divisor: Poly): Poly {
  const out = dividend.slice();
  for (let i = 0; i < dividend.length - (divisor.length - 1); i++) {
    const coef = out[i];
    if (coef === 0) continue;
    for (let j = 1; j < divisor.length; j++) {
      if (divisor[j] !== 0) out[i + j] ^= mul(divisor[j], coef);
    }
  }
  return out.slice(out.length - (divisor.length - 1));
}

const generatorCache = new Map<number, Poly>();

function generatorPoly(nsym: number): Poly {
  let g = generatorCache.get(nsym);
  if (!g) {
    g = [1];
    for (let i = 0; i < nsym; i++) g = polyMul(g, [1, pow(2, i)]);
    generatorCache.set(nsym, g);
  }
  return g;
}

/** Returns message followed by `nsym` parity bytes. Total length must be at most 255. */
export function rsEncode(message: Uint8Array, nsym: number): Uint8Array {
  if (message.length + nsym > 255) throw new Error('rs: codeword longer than 255 bytes');
  const gen = generatorPoly(nsym);
  const out = new Uint8Array(message.length + nsym);
  out.set(message);
  for (let i = 0; i < message.length; i++) {
    const coef = out[i];
    if (coef === 0) continue;
    for (let j = 1; j < gen.length; j++) out[i + j] ^= mul(gen[j], coef);
  }
  out.set(message);
  return out;
}

function syndromes(codeword: ArrayLike<number>, nsym: number): Poly {
  const synd = new Array<number>(nsym + 1).fill(0);
  for (let i = 0; i < nsym; i++) synd[i + 1] = polyEval(codeword, pow(2, i));
  return synd;
}

function forneySyndromes(synd: Poly, erasePos: number[], n: number): Poly {
  const fsynd = synd.slice(1);
  for (const p of erasePos) {
    const x = pow(2, n - 1 - p);
    for (let j = 0; j < fsynd.length - 1; j++) fsynd[j] = mul(fsynd[j], x) ^ fsynd[j + 1];
  }
  return fsynd;
}

function findErrorLocator(synd: Poly, nsym: number, eraseCount: number): Poly | null {
  let errLoc: Poly = [1];
  let oldLoc: Poly = [1];
  const shift = synd.length > nsym ? synd.length - nsym : 0;
  for (let i = 0; i < nsym - eraseCount; i++) {
    const k = i + shift;
    let delta = synd[k];
    for (let j = 1; j < errLoc.length; j++) delta ^= mul(errLoc[errLoc.length - 1 - j], synd[k - j]);
    oldLoc = oldLoc.concat([0]);
    if (delta !== 0) {
      if (oldLoc.length > errLoc.length) {
        const newLoc = polyScale(oldLoc, delta);
        oldLoc = polyScale(errLoc, inverse(delta));
        errLoc = newLoc;
      }
      errLoc = polyAdd(errLoc, polyScale(oldLoc, delta));
    }
  }
  while (errLoc.length > 0 && errLoc[0] === 0) errLoc = errLoc.slice(1);
  const errs = errLoc.length - 1;
  if ((errs - eraseCount) * 2 + eraseCount > nsym) return null;
  return errLoc;
}

function findErrors(errLocReversed: Poly, n: number): number[] | null {
  const errs = errLocReversed.length - 1;
  const positions: number[] = [];
  for (let i = 0; i < n; i++) {
    if (polyEval(errLocReversed, pow(2, i)) === 0) positions.push(n - 1 - i);
  }
  return positions.length === errs ? positions : null;
}

function correctErrata(codeword: Uint8Array, synd: Poly, errPos: number[]): void {
  const n = codeword.length;
  const coefPos = errPos.map((p) => n - 1 - p);
  let errLoc: Poly = [1];
  for (const i of coefPos) errLoc = polyMul(errLoc, polyAdd([1], [pow(2, i), 0]));
  const product = polyMul(synd.slice().reverse(), errLoc);
  const divisor: Poly = [1].concat(new Array<number>(errLoc.length).fill(0));
  const errEval = polyRemainder(product, divisor);
  const X = coefPos.map((c) => pow(2, c - 255));
  for (let i = 0; i < X.length; i++) {
    const xiInv = inverse(X[i]);
    let locPrime = 1;
    for (let j = 0; j < X.length; j++) {
      if (j !== i) locPrime = mul(locPrime, 1 ^ mul(xiInv, X[j]));
    }
    if (locPrime === 0) throw new Error('rs: repeated error position');
    const y = mul(X[i], polyEval(errEval, xiInv));
    codeword[errPos[i]] ^= div(y, locPrime);
  }
}

export interface RsResult {
  /** The corrected message without parity. */
  message: Uint8Array;
  /** Number of byte positions that were changed (errors plus erasures that held wrong values). */
  corrected: number;
}

/**
 * Decodes a codeword of message plus `nsym` parity bytes. `erasures` lists
 * positions the caller already knows to be unreliable. Corrects any pattern
 * with 2 * errors + erasures <= nsym. Returns null when the codeword cannot
 * be corrected.
 */
export function rsDecode(codeword: Uint8Array, nsym: number, erasures: number[] = []): RsResult | null {
  const n = codeword.length;
  if (n > 255 || n <= nsym) throw new Error('rs: invalid codeword length');
  if (erasures.length > nsym) return null;
  const work = codeword.slice();
  for (const p of erasures) {
    if (p < 0 || p >= n) throw new Error('rs: erasure position out of range');
    work[p] = 0;
  }
  let synd = syndromes(work, nsym);
  let clean = true;
  for (let i = 1; i < synd.length; i++) if (synd[i] !== 0) { clean = false; break; }
  if (!clean) {
    const fsynd = forneySyndromes(synd, erasures, n);
    const errLoc = findErrorLocator(fsynd, nsym, erasures.length);
    if (!errLoc) return null;
    const errPos = findErrors(errLoc.slice().reverse(), n);
    if (!errPos) return null;
    try {
      correctErrata(work, synd, erasures.concat(errPos));
    } catch {
      return null;
    }
    synd = syndromes(work, nsym);
    for (let i = 1; i < synd.length; i++) if (synd[i] !== 0) return null;
  }
  let corrected = 0;
  for (let i = 0; i < n; i++) if (work[i] !== codeword[i]) corrected++;
  return { message: work.slice(0, n - nsym), corrected };
}
