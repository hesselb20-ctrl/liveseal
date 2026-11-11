// The robust content digest carried in every statement, and the comparison
// the verifier runs against the frames it actually received.
//
// The hash family, bit budget and thresholds below were chosen from the
// measurements in docs/EVALUATION.md, section 3. Change them only together
// with a new measurement run (codec-sim/digest-eval.ts).

import { FACE_SIZE, SNAPSHOTS, THUMB_H, THUMB_W, hasFace, type FaceBox, type PeriodFeatures } from './features.ts';
import { getBit, packBits, patchFeatures, thumbFeatures, type HashKind } from './hashes.ts';
import { PERIOD_MS } from './statement.ts';

export interface DigestParams {
  kind: HashKind;
  /** Bits per face snapshot. */
  faceBits: number;
  /** Which of the SNAPSHOTS moments contribute a face hash. */
  faceSnaps: number[];
  /** Bits per whole-frame snapshot. */
  thumbBits: number;
  thumbSnaps: number[];
  /** Face distance at or below this is a match; at or above `faceMismatch` it is a mismatch. */
  faceMatch: number;
  faceMismatch: number;
  thumbMatch: number;
  thumbMismatch: number;
}

// Measured on 2,016 genuine and 8,736 attack periods (docs/EVALUATION.md, section 3):
// the largest genuine face distance was 0.044 and the smallest distance of a replaced
// face was 0.106; for the whole-frame hash 0.006 against 0.232 for a replaced scene.
export const DIGEST: DigestParams = {
  kind: 'gradient',
  faceBits: 48,
  faceSnaps: [0, 2, 4, 6],
  thumbBits: 32,
  thumbSnaps: [1, 5],
  faceMatch: 0.055,
  faceMismatch: 0.085,
  thumbMatch: 0.05,
  thumbMismatch: 0.12,
};

export function digestLength(p: DigestParams = DIGEST): number {
  return Math.ceil((p.faceBits * p.faceSnaps.length + p.thumbBits * p.thumbSnaps.length) / 8);
}

/**
 * The statement sent in period p describes the two seconds that end this long
 * before p starts. The gap gives the sender time to hash and sign before the
 * first frame of p goes out.
 */
export const DIGEST_LEAD_MS = 250;

/** Start of the digested window for the statement transmitted in the period that starts at `txStartMs`. */
export function digestWindowStart(txStartMs: number): number {
  return txStartMs - PERIOD_MS - DIGEST_LEAD_MS;
}

/** When, relative to the start of the transmitting period, the digested window has fully arrived. */
export const DIGEST_READY_BEFORE_MS = DIGEST_LEAD_MS + 60;

const FACE_FLOATS = FACE_SIZE * FACE_SIZE;
const THUMB_FLOATS = THUMB_W * THUMB_H;

function faceFeatures(f: PeriodFeatures, s: number, p: DigestParams): Float32Array {
  return patchFeatures(p.kind, f.faces.subarray(s * FACE_FLOATS, (s + 1) * FACE_FLOATS), FACE_SIZE, p.faceBits);
}

function frameFeatures(f: PeriodFeatures, s: number, p: DigestParams): Float32Array {
  return thumbFeatures(f.thumbs.subarray(s * THUMB_FLOATS, (s + 1) * THUMB_FLOATS), THUMB_W, THUMB_H, p.thumbBits);
}

/**
 * A patch with almost no contrast (a covered lens, a black frame) has nothing
 * to hash: its bits are decided by noise. Such snapshots are left out of the
 * comparison, so they can make a period uncertain but never a match or a
 * mismatch. The value is a standard deviation in 8-bit levels.
 */
export const MIN_CONTRAST = 5;

function contrast(patch: Float32Array): number {
  let mean = 0;
  for (let i = 0; i < patch.length; i++) mean += patch[i];
  mean /= patch.length;
  let v = 0;
  for (let i = 0; i < patch.length; i++) v += (patch[i] - mean) ** 2;
  return Math.sqrt(v / patch.length);
}

/** Sender side: the digest of one period's features. */
export function computeDigest(f: PeriodFeatures, box: FaceBox, p: DigestParams = DIGEST): Uint8Array {
  const out = new Uint8Array(digestLength(p));
  let offset = 0;
  const withFace = hasFace(box);
  for (const s of p.faceSnaps) {
    if (withFace && f.valid[s]) packBits(faceFeatures(f, s, p), out, offset);
    offset += p.faceBits;
  }
  for (const s of p.thumbSnaps) {
    if (f.valid[s]) packBits(frameFeatures(f, s, p), out, offset);
    offset += p.thumbBits;
  }
  return out;
}

export type DigestVerdict = 'match' | 'uncertain' | 'mismatch' | 'unobserved';

export interface DigestComparison {
  verdict: DigestVerdict;
  /** Mean face distance (0 identical, 0.5 unrelated). */
  score: number;
  face: number;
  frame: number;
}

/**
 * Fraction of disagreeing bits, where each bit counts in proportion to how
 * far the receiver's own feature is from zero. A feature near zero flips
 * under the slightest codec noise, so it says little either way.
 */
function weightedDistance(digest: Uint8Array, bitOffset: number, features: Float32Array): { distance: number; weight: number } {
  const n = features.length;
  let rms = 0;
  for (let i = 0; i < n; i++) rms += features[i] * features[i];
  rms = Math.sqrt(rms / n) + 1e-9;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    const w = Math.min(1, Math.abs(features[i]) / (0.5 * rms));
    den += w;
    if ((features[i] > 0 ? 1 : 0) !== getBit(digest, bitOffset + i)) num += w;
  }
  return { distance: den > 0 ? num / den : 0.5, weight: den / n };
}

/**
 * Verifier side: compares a signed digest with the features of the frames
 * that were received for the same window.
 *
 * `features` is null when the window lies before the verifier started
 * watching ('unobserved'). Too few usable snapshots, or bits that are too
 * weak to judge, give 'uncertain': never a match.
 */
export function compareDigest(
  digest: Uint8Array, features: PeriodFeatures | null, box: FaceBox, p: DigestParams = DIGEST,
): DigestComparison {
  if (digest.length !== digestLength(p)) return { verdict: 'uncertain', score: 0.5, face: 0.5, frame: 0.5 };
  if (!features) return { verdict: 'unobserved', score: 0, face: 0, frame: 0 };
  let offset = 0;
  let faceSum = 0;
  let faceCount = 0;
  let faceWeight = 0;
  const withFace = hasFace(box);
  for (const s of p.faceSnaps) {
    if (withFace && features.valid[s] && contrast(features.faces.subarray(s * FACE_FLOATS, (s + 1) * FACE_FLOATS)) >= MIN_CONTRAST) {
      const d = weightedDistance(digest, offset, faceFeatures(features, s, p));
      faceSum += d.distance;
      faceWeight += d.weight;
      faceCount++;
    }
    offset += p.faceBits;
  }
  let frameSum = 0;
  let frameCount = 0;
  for (const s of p.thumbSnaps) {
    if (features.valid[s] && contrast(features.thumbs.subarray(s * THUMB_FLOATS, (s + 1) * THUMB_FLOATS)) >= MIN_CONTRAST) {
      frameSum += weightedDistance(digest, offset, frameFeatures(features, s, p)).distance;
      frameCount++;
    }
    offset += p.thumbBits;
  }
  // Not enough of the window was seen (or it had too little in it) to judge it.
  if (faceCount < Math.ceil(p.faceSnaps.length / 2) || frameCount === 0) {
    const none = !features.valid.some(Boolean);
    return { verdict: none ? 'unobserved' : 'uncertain', score: 0.5, face: 0.5, frame: 0.5 };
  }
  const face = faceSum / faceCount;
  const frame = frameSum / frameCount;
  let verdict: DigestVerdict = 'uncertain';
  if (face >= p.faceMismatch || frame >= p.thumbMismatch) verdict = 'mismatch';
  else if (face <= p.faceMatch && frame <= p.thumbMatch && withFace && faceWeight / faceCount >= 0.5) verdict = 'match';
  return { verdict, score: face, face, frame };
}

export { SNAPSHOTS };
