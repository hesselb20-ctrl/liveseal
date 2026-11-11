// Attack videos for the digest research and the attack suite.
//
// These are proxies made with plain image operations, not a neural face-swap
// model: the test set contains other people's faces, and the project rules
// only allow face-swap models on footage we own. Each proxy is designed to
// stress one property of the digest:
//   swap   another person's face, colour-matched and feathered into the face box
//   warp   the same face with its geometry bent by a chosen amount
//   mouth  only the mouth region replaced by the same person's mouth at another moment
//   other  a completely different video
//   shift  the same video delayed (stale frames under a fresh seal)
//   still  the same video frozen at the start of every period
//
// Face boxes were set by eye for the static-camera clips of the Xiph set.
// All attack material stays in data/ (git-ignored).

import { RawReader, prepareClip, type RawInfo } from './video.ts';
import { planesOf } from './channel.ts';

/** Face position as a fraction of the frame: x, y, width, height. */
export const FACES: Record<string, [number, number, number, number]> = {
  johnny: [0.36, 0.05, 0.26, 0.42],
  kristen_sara: [0.66, 0.22, 0.22, 0.33],
  vidyo1: [0.47, 0.21, 0.16, 0.22],
  vidyo4: [0.30, 0.25, 0.24, 0.43],
  akiyo: [0.38, 0.18, 0.26, 0.47],
  news: [0.69, 0.36, 0.16, 0.31],
  silent: [0.36, 0.11, 0.20, 0.33],
  mother_daughter: [0.59, 0.25, 0.22, 0.40],
  paris: [0.72, 0.23, 0.21, 0.28],
  deadline: [0.38, 0.20, 0.30, 0.46],
  sign_irene: [0.32, 0.13, 0.19, 0.31],
  students: [0.67, 0.20, 0.16, 0.30],
};

export const FACE_CLIPS = Object.keys(FACES);

/** Native size at which each clip is used. */
export function clipSize(name: string): { width: number; height: number } {
  return ['johnny', 'kristen_sara', 'vidyo1', 'vidyo4'].includes(name) ? { width: 640, height: 360 } : { width: 352, height: 288 };
}

export type AttackSpec =
  | { kind: 'none' }
  | { kind: 'swap'; donor: string }
  | { kind: 'warp'; strength: number }
  | { kind: 'mouth'; delay: number }
  | { kind: 'other'; clip: string }
  | { kind: 'shift'; delay: number }
  | { kind: 'still' };

export function attackName(a: AttackSpec): string {
  switch (a.kind) {
    case 'none': return 'genuine';
    case 'swap': return `swap:${a.donor}`;
    case 'warp': return `warp:${a.strength}`;
    case 'mouth': return `mouth:${a.delay}`;
    case 'other': return `other:${a.clip}`;
    case 'shift': return `shift:${a.delay}`;
    case 'still': return 'still';
  }
}

function smooth(t: number): number {
  const x = t <= 0 ? 0 : t >= 1 ? 1 : t;
  return x * x * (3 - 2 * x);
}

function bilinear(img: Uint8Array, w: number, h: number, x: number, y: number): number {
  const cx = x < 0 ? 0 : x > w - 1 ? w - 1 : x;
  const cy = y < 0 ? 0 : y > h - 1 ? h - 1 : y;
  const x0 = Math.floor(cx);
  const y0 = Math.floor(cy);
  const x1 = Math.min(w - 1, x0 + 1);
  const y1 = Math.min(h - 1, y0 + 1);
  const fx = cx - x0;
  const fy = cy - y0;
  return (img[y0 * w + x0] * (1 - fx) + img[y0 * w + x1] * fx) * (1 - fy) + (img[y1 * w + x0] * (1 - fx) + img[y1 * w + x1] * fx) * fy;
}

interface Rect { x: number; y: number; w: number; h: number }

function rectOf(box: [number, number, number, number], w: number, h: number): Rect {
  return { x: box[0] * w, y: box[1] * h, w: box[2] * w, h: box[3] * h };
}

function stats(img: Uint8Array, w: number, r: Rect): { mean: number; std: number } {
  let sum = 0;
  let sq = 0;
  let n = 0;
  for (let y = Math.floor(r.y); y < Math.floor(r.y + r.h); y++) {
    for (let x = Math.floor(r.x); x < Math.floor(r.x + r.w); x++) {
      const v = img[y * w + x];
      sum += v; sq += v * v; n++;
    }
  }
  const mean = sum / n;
  return { mean, std: Math.sqrt(Math.max(1, sq / n - mean * mean)) };
}

/** Replaces the elliptical face region of `dst` with the donor's, matched in brightness and contrast. */
function pasteFace(dst: Uint8Array, dw: number, dh: number, dr: Rect, src: Uint8Array, sw: number, sh: number, sr: Rect, matchContrast: boolean): void {
  const a = stats(dst, dw, dr);
  const b = stats(src, sw, sr);
  const gain = matchContrast ? Math.min(2, Math.max(0.5, a.std / b.std)) : 1;
  const x0 = Math.max(0, Math.floor(dr.x));
  const x1 = Math.min(dw, Math.ceil(dr.x + dr.w));
  const y0 = Math.max(0, Math.floor(dr.y));
  const y1 = Math.min(dh, Math.ceil(dr.y + dr.h));
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const u = ((x + 0.5 - dr.x) / dr.w) * 2 - 1;
      const v = ((y + 0.5 - dr.y) / dr.h) * 2 - 1;
      const m = smooth((1 - Math.sqrt(u * u + v * v)) / 0.3);
      if (m <= 0) continue;
      const s = bilinear(src, sw, sh, sr.x + ((u + 1) / 2) * sr.w - 0.5, sr.y + ((v + 1) / 2) * sr.h - 0.5);
      const matched = (s - b.mean) * gain + a.mean;
      const out = dst[y * dw + x] * (1 - m) + matched * m;
      dst[y * dw + x] = out < 0 ? 0 : out > 255 ? 255 : Math.round(out);
    }
  }
}

/** Bends the geometry inside the face region by up to `strength` times the face size. */
function warpFace(dst: Uint8Array, w: number, h: number, r: Rect, strength: number, orig: Uint8Array): void {
  const x0 = Math.max(0, Math.floor(r.x));
  const x1 = Math.min(w, Math.ceil(r.x + r.w));
  const y0 = Math.max(0, Math.floor(r.y));
  const y1 = Math.min(h, Math.ceil(r.y + r.h));
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const u = ((x + 0.5 - r.x) / r.w) * 2 - 1;
      const v = ((y + 0.5 - r.y) / r.h) * 2 - 1;
      const m = smooth((1 - Math.sqrt(u * u + v * v)) / 0.4);
      if (m <= 0) continue;
      const sx = x - strength * r.w * m * Math.sin(Math.PI * v);
      const sy = y - strength * r.h * m * Math.sin(Math.PI * u);
      dst[y * w + x] = Math.round(bilinear(orig, w, h, sx, sy));
    }
  }
}

/** Copies the mouth region (lower middle of the face box) from another frame of the same clip. */
function pasteMouth(dst: Uint8Array, w: number, h: number, r: Rect, src: Uint8Array): void {
  const m: Rect = { x: r.x + 0.22 * r.w, y: r.y + 0.58 * r.h, w: 0.56 * r.w, h: 0.36 * r.h };
  const x0 = Math.max(0, Math.floor(m.x));
  const x1 = Math.min(w, Math.ceil(m.x + m.w));
  const y0 = Math.max(0, Math.floor(m.y));
  const y1 = Math.min(h, Math.ceil(m.y + m.h));
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const u = Math.abs(((x + 0.5 - m.x) / m.w) * 2 - 1);
      const v = Math.abs(((y + 0.5 - m.y) / m.h) * 2 - 1);
      const a = smooth((1 - u) / 0.3) * smooth((1 - v) / 0.3);
      const out = dst[y * w + x] * (1 - a) + src[y * w + x] * a;
      dst[y * w + x] = Math.round(out);
    }
  }
}

/** Produces the frames of one attack on one victim clip. */
export class AttackSource {
  readonly width: number;
  readonly height: number;
  private readonly spec: AttackSpec;
  private readonly victim: RawReader;
  private readonly other: RawReader | null = null;
  private readonly otherInfo: RawInfo | null = null;
  private readonly box: [number, number, number, number];
  private readonly donorBox: [number, number, number, number] | null = null;
  private readonly scratch: Uint8Array;
  private readonly scratch2: Uint8Array;

  constructor(victimClip: string, spec: AttackSpec) {
    const size = clipSize(victimClip);
    this.width = size.width;
    this.height = size.height;
    this.spec = spec;
    this.victim = new RawReader(prepareClip(victimClip, size.width, size.height));
    this.box = FACES[victimClip];
    const frameSize = size.width * size.height * 3 / 2;
    this.scratch = new Uint8Array(frameSize);
    this.scratch2 = new Uint8Array(frameSize);
    if (spec.kind === 'swap') {
      const ds = clipSize(spec.donor);
      this.otherInfo = prepareClip(spec.donor, ds.width, ds.height);
      this.other = new RawReader(this.otherInfo);
      this.donorBox = FACES[spec.donor];
      this.scratch2 = new Uint8Array(ds.width * ds.height * 3 / 2);
    } else if (spec.kind === 'other') {
      this.otherInfo = prepareClip(spec.clip, size.width, size.height);
      this.other = new RawReader(this.otherInfo);
    }
  }

  /** Writes attacked frame `k` into `out` (I420, victim size). */
  frame(k: number, out: Uint8Array): void {
    const { width: w, height: h, spec } = this;
    switch (spec.kind) {
      case 'none':
        this.victim.read(k, out, true);
        return;
      case 'other':
        this.other!.read(k, out, true);
        return;
      case 'shift':
        this.victim.read(Math.max(0, k - spec.delay), out, true);
        return;
      case 'still':
        this.victim.read(Math.floor(k / 60) * 60, out, true);
        return;
      case 'swap': {
        this.victim.read(k, out, true);
        this.other!.read(k, this.scratch2, true);
        const d = planesOf(out, w, h);
        const oi = this.otherInfo!;
        const s = planesOf(this.scratch2, oi.width, oi.height);
        pasteFace(d.y, w, h, rectOf(this.box, w, h), s.y, oi.width, oi.height, rectOf(this.donorBox!, oi.width, oi.height), true);
        pasteFace(d.u, d.cw, d.ch, rectOf(this.box, d.cw, d.ch), s.u, s.cw, s.ch, rectOf(this.donorBox!, s.cw, s.ch), false);
        pasteFace(d.v, d.cw, d.ch, rectOf(this.box, d.cw, d.ch), s.v, s.cw, s.ch, rectOf(this.donorBox!, s.cw, s.ch), false);
        return;
      }
      case 'warp': {
        this.victim.read(k, out, true);
        this.scratch.set(out);
        const d = planesOf(out, w, h);
        const o = planesOf(this.scratch, w, h);
        warpFace(d.y, w, h, rectOf(this.box, w, h), spec.strength, o.y);
        warpFace(d.u, d.cw, d.ch, rectOf(this.box, d.cw, d.ch), spec.strength, o.u);
        warpFace(d.v, d.cw, d.ch, rectOf(this.box, d.cw, d.ch), spec.strength, o.v);
        return;
      }
      case 'mouth': {
        this.victim.read(k, out, true);
        this.victim.read(k + spec.delay, this.scratch, true);
        const d = planesOf(out, w, h);
        const o = planesOf(this.scratch, w, h);
        pasteMouth(d.y, w, h, rectOf(this.box, w, h), o.y);
        pasteMouth(d.u, d.cw, d.ch, rectOf(this.box, d.cw, d.ch), o.u);
        pasteMouth(d.v, d.cw, d.ch, rectOf(this.box, d.cw, d.ch), o.v);
        return;
      }
    }
  }

  close(): void {
    this.victim.close();
    this.other?.close();
  }
}

/** The attacks run against every clip. `index` picks donors so that each clip meets different people. */
export function attacksFor(clip: string): AttackSpec[] {
  const others = FACE_CLIPS.filter((c) => c !== clip);
  const i = FACE_CLIPS.indexOf(clip);
  const pick = (n: number) => others[(i * 3 + n * 5) % others.length];
  return [
    { kind: 'swap', donor: pick(0) }, { kind: 'swap', donor: pick(1) }, { kind: 'swap', donor: pick(2) },
    { kind: 'warp', strength: 0.03 }, { kind: 'warp', strength: 0.06 }, { kind: 'warp', strength: 0.12 },
    { kind: 'mouth', delay: 8 }, { kind: 'mouth', delay: 20 },
    { kind: 'other', clip: pick(3) }, { kind: 'other', clip: pick(4) },
    { kind: 'shift', delay: 15 }, { kind: 'shift', delay: 60 },
    { kind: 'still' },
  ];
}
