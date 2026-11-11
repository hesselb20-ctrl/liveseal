// Picture features that the content digest is built from.
//
// Both ends keep a short history of reduced luma frames. For one seal period
// they cut out SNAPSHOTS short moments, and for each moment produce
//   * a FACE_SIZE x FACE_SIZE crop of the signed face box, and
//   * a THUMB_W x THUMB_H thumbnail of the whole frame.
// The digest candidates in digest.ts turn these into bits.

import { REDUCED_H, REDUCED_W, makeReducer } from './modem.ts';
import { PERIOD_MS } from './statement.ts';

/** Moments sampled per period. */
export const SNAPSHOTS = 8;
export const FACE_SIZE = 32;
export const THUMB_W = 64;
export const THUMB_H = 36;
/** Frames within this many ms of a snapshot's centre are averaged into it. */
const SNAPSHOT_HALF_WINDOW_MS = 55;
/** If no frame lies in the window, the nearest frame within this distance is used. */
const SNAPSHOT_REACH_MS = 130;

export interface PeriodFeatures {
  /** SNAPSHOTS crops, each FACE_SIZE * FACE_SIZE luma values. */
  faces: Float32Array;
  /** SNAPSHOTS thumbnails, each THUMB_W * THUMB_H luma values. */
  thumbs: Float32Array;
  /** Which snapshots had at least one frame. */
  valid: boolean[];
}

/** Face box in 1/256 units of the frame (x, y, width, height), as carried in the statement. */
export type FaceBox = Uint8Array;

export function makeFaceBox(x: number, y: number, w: number, h: number): FaceBox {
  const q = (v: number) => Math.max(0, Math.min(255, Math.round(v * 256)));
  return Uint8Array.of(q(x), q(y), Math.max(1, q(w)), Math.max(1, q(h)));
}

export function hasFace(box: FaceBox): boolean {
  return box[2] > 0 && box[3] > 0;
}

/** The face box in reduced-image pixels, clamped to the image and at least 8 pixels on each side. */
export function boxPixels(box: FaceBox): { x: number; y: number; w: number; h: number } {
  let x = Math.round((box[0] / 256) * REDUCED_W);
  let y = Math.round((box[1] / 256) * REDUCED_H);
  let w = Math.max(8, Math.round((box[2] / 256) * REDUCED_W));
  let h = Math.max(8, Math.round((box[3] / 256) * REDUCED_H));
  w = Math.min(w, REDUCED_W);
  h = Math.min(h, REDUCED_H);
  x = Math.max(0, Math.min(REDUCED_W - w, x));
  y = Math.max(0, Math.min(REDUCED_H - h, y));
  return { x, y, w, h };
}

const thumbReducer = makeReducer(REDUCED_W, REDUCED_H, THUMB_W, THUMB_H);
const cropReducers = new Map<number, ReturnType<typeof makeReducer>>();

/** Resamples the face box of a reduced luma image to FACE_SIZE x FACE_SIZE. */
export function cropFace(reduced: ArrayLike<number>, box: FaceBox, out?: Float32Array): Float32Array {
  const { x, y, w, h } = boxPixels(box);
  const key = w * 1024 + h;
  let reducer = cropReducers.get(key);
  if (!reducer) {
    reducer = makeReducer(w, h, FACE_SIZE, FACE_SIZE);
    cropReducers.set(key, reducer);
    if (cropReducers.size > 64) cropReducers.delete(cropReducers.keys().next().value as number);
  }
  const sub = new Float32Array(w * h);
  for (let j = 0; j < h; j++) {
    const row = (y + j) * REDUCED_W + x;
    for (let i = 0; i < w; i++) sub[j * w + i] = reduced[row + i];
  }
  return reducer(sub, w, out);
}

/** A few seconds of reduced luma frames with their times. */
export class FrameHistory {
  private times: number[] = [];
  private frames: Uint8ClampedArray[] = [];
  private readonly keepMs: number;

  constructor(keepMs: number = 3 * PERIOD_MS + 500) {
    this.keepMs = keepMs;
  }

  /** `reduced` is REDUCED_W * REDUCED_H luma values in 0..255. */
  push(tMs: number, reduced: ArrayLike<number>): void {
    const n = this.times.length;
    if (n > 0 && tMs <= this.times[n - 1]) return;
    this.times.push(tMs);
    const copy = new Uint8ClampedArray(reduced.length);
    copy.set(reduced);
    this.frames.push(copy);
    while (this.times.length > 0 && this.times[0] < tMs - this.keepMs) {
      this.times.shift();
      this.frames.shift();
    }
  }

  get span(): [number, number] | null {
    return this.times.length ? [this.times[0], this.times[this.times.length - 1]] : null;
  }

  /**
   * Features of the period that starts at `startMs`. Returns null when fewer
   * than three quarters of the snapshots have a frame (too many frames lost).
   */
  features(startMs: number, box: FaceBox): PeriodFeatures | null {
    const faces = new Float32Array(SNAPSHOTS * FACE_SIZE * FACE_SIZE);
    const thumbs = new Float32Array(SNAPSHOTS * THUMB_W * THUMB_H);
    const valid: boolean[] = [];
    const acc = new Float32Array(REDUCED_W * REDUCED_H);
    const withFace = hasFace(box);
    let count = 0;
    for (let s = 0; s < SNAPSHOTS; s++) {
      const centre = startMs + ((s + 0.5) * PERIOD_MS) / SNAPSHOTS;
      const picked: number[] = [];
      let nearest = -1;
      let nearestDist = Infinity;
      for (let i = 0; i < this.times.length; i++) {
        const d = Math.abs(this.times[i] - centre);
        if (d <= SNAPSHOT_HALF_WINDOW_MS) picked.push(i);
        if (d < nearestDist) { nearestDist = d; nearest = i; }
      }
      if (picked.length === 0 && nearest >= 0 && nearestDist <= SNAPSHOT_REACH_MS) picked.push(nearest);
      if (picked.length === 0) { valid.push(false); continue; }
      acc.fill(0);
      for (const i of picked) {
        const f = this.frames[i];
        for (let p = 0; p < acc.length; p++) acc[p] += f[p];
      }
      for (let p = 0; p < acc.length; p++) acc[p] /= picked.length;
      if (withFace) cropFace(acc, box, faces.subarray(s * FACE_SIZE * FACE_SIZE, (s + 1) * FACE_SIZE * FACE_SIZE));
      thumbReducer(acc, REDUCED_W, thumbs.subarray(s * THUMB_W * THUMB_H, (s + 1) * THUMB_W * THUMB_H));
      valid.push(true);
      count++;
    }
    if (count < (SNAPSHOTS * 3) / 4) return null;
    return { faces, thumbs, valid };
  }
}
