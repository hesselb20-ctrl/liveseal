// Browser pipelines: one that seals a camera stream, one that verifies a
// <video>. Both are thin wrappers that move pixels between the DOM and the
// sessions in core/src/session.ts.

import type { Signer } from '../core/src/crypto.ts';
import type { KeyDirectory } from '../core/src/directory.ts';
import { REDUCED_H, REDUCED_W, makeLayout } from '../core/src/modem.ts';
import { RgbaCellSampler } from '../core/src/pixels.ts';
import { ReceiverSession, SenderSession, type PeriodReport } from '../core/src/session.ts';
import type { VerifierPolicy } from '../core/src/verify.ts';
import { GlSealer, type GlCanvas } from './gl-sealer.ts';

type VideoFrameMeta = { mediaTime?: number; presentationTime?: number; expectedDisplayTime?: number };
type FrameCallback = (now: number, meta: VideoFrameMeta) => void;

/**
 * Calls `fn` for every new frame of a video element.
 *
 * The browser's per-frame callback is used when it fires. It does not fire
 * for videos that are not being painted (detached, hidden, or in a background
 * tab), so a timer watches for that and takes over at about 30 calls per
 * second until the callback comes back.
 */
export function onVideoFrames(video: HTMLVideoElement, fn: FrameCallback): () => void {
  let stopped = false;
  let lastCall = 0;
  let lastTime = -1;
  const v = video as HTMLVideoElement & {
    requestVideoFrameCallback?: (cb: FrameCallback) => number;
    cancelVideoFrameCallback?: (id: number) => void;
  };
  let id = 0;
  if (typeof v.requestVideoFrameCallback === 'function') {
    const tick: FrameCallback = (now, meta) => {
      if (stopped) return;
      lastCall = performance.now();
      lastTime = video.currentTime;
      fn(now, meta);
      id = v.requestVideoFrameCallback!(tick);
    };
    id = v.requestVideoFrameCallback(tick);
  }
  const timer = setInterval(() => {
    if (stopped || video.readyState < 2) return;
    const now = performance.now();
    if (now - lastCall < 90) return; // the frame callback is alive
    if (video.currentTime === lastTime) return; // no new picture
    lastTime = video.currentTime;
    fn(now, { mediaTime: video.currentTime });
  }, 33);
  return () => {
    stopped = true;
    clearInterval(timer);
    v.cancelVideoFrameCallback?.(id);
  };
}

/** Sender wall clock with sub-millisecond steps. */
export function unixNow(): number {
  return performance.timeOrigin + performance.now();
}

function reducedContext(): { canvas: HTMLCanvasElement | OffscreenCanvas; ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D } {
  const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(REDUCED_W, REDUCED_H) : Object.assign(document.createElement('canvas'), { width: REDUCED_W, height: REDUCED_H });
  const ctx = canvas.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'medium';
  return { canvas, ctx };
}

export interface SealPipelineOptions {
  signer: Signer;
  /** Camera (or any) video element that is already playing. */
  source: HTMLVideoElement;
  /** Canvas that receives the sealed picture. */
  output: GlCanvas;
  amplitude?: ArrayLike<number>;
  /** Optional face detector: returns the face as fractions of the frame, or null. */
  detectFace?: (video: HTMLVideoElement) => Promise<[number, number, number, number] | null> | [number, number, number, number] | null;
}

/** Seals a playing video element onto a canvas. Use `output.captureStream()` to get the sealed stream. */
export class SealPipeline {
  readonly session: SenderSession;
  enabled = true;
  /** Frames drawn so far. */
  frames = 0;
  /** Average time spent per frame in this pipeline, in ms. */
  costMs = 0;
  /** Optional observer, called after every sealed frame with the camera luma and the field that was applied. */
  tap: ((unixMs: number, luma: Float32Array, field: Float32Array, frame: number) => void) | null = null;
  private readonly sealer: GlSealer;
  private readonly source: HTMLVideoElement;
  private readonly reduced = reducedContext();
  private readonly luma = new Float32Array(REDUCED_W * REDUCED_H);
  private readonly field: Float32Array;
  private stopFrames: (() => void) | null = null;
  private readonly detectFace: SealPipelineOptions['detectFace'];
  private lastDetect = 0;
  private detecting = false;

  constructor(opts: SealPipelineOptions) {
    this.session = new SenderSession({ signer: opts.signer, amplitude: opts.amplitude });
    this.sealer = new GlSealer(this.session.layout, opts.output);
    this.source = opts.source;
    this.field = new Float32Array(this.session.layout.cells);
    this.detectFace = opts.detectFace;
  }

  start(): void {
    if (this.stopFrames) return;
    this.stopFrames = onVideoFrames(this.source, () => this.frame());
  }

  stop(): void {
    this.stopFrames?.();
    this.stopFrames = null;
  }

  private frame(): void {
    const video = this.source;
    const w = video.videoWidth;
    const h = video.videoHeight;
    if (!w || !h) return;
    const t0 = performance.now();
    const now = unixNow();
    // the digest is computed from the camera picture, before the seal is added
    this.reduced.ctx.drawImage(video, 0, 0, REDUCED_W, REDUCED_H);
    const rgba = this.reduced.ctx.getImageData(0, 0, REDUCED_W, REDUCED_H).data;
    for (let i = 0, p = 0; i < this.luma.length; i++, p += 4) this.luma[i] = 0.299 * rgba[p] + 0.587 * rgba[p + 1] + 0.114 * rgba[p + 2];
    this.session.pushFrame(now, this.luma);
    this.session.field(now, this.field);
    this.sealer.draw(video, w, h, this.field, this.frames, this.enabled);
    this.tap?.(now, this.luma, this.field, this.frames);
    this.frames++;
    this.costMs += (performance.now() - t0 - this.costMs) / Math.min(this.frames, 120);
    if (this.detectFace && !this.detecting && t0 - this.lastDetect > 400) {
      this.detecting = true;
      this.lastDetect = t0;
      Promise.resolve(this.detectFace(video)).then((box) => {
        if (box) this.session.setFace(box[0], box[1], box[2], box[3]);
      }).catch(() => undefined).finally(() => { this.detecting = false; });
    }
  }
}

/** A quadrilateral in source-pixel fractions (top-left, top-right, bottom-right, bottom-left). */
export type Quad = [[number, number], [number, number], [number, number], [number, number]];
export const FULL_FRAME: Quad = [[0, 0], [1, 0], [1, 1], [0, 1]];

export interface VerifyPipelineOptions {
  video: HTMLVideoElement;
  directory: KeyDirectory;
  onReport: (report: PeriodReport) => void;
  /** Region of the video that shows the sealed picture. Defaults to the full frame. */
  region?: () => Quad;
  /** Clock used for freshness; override for recordings. */
  clock?: () => number;
  /** Verification policy; the recording checker relaxes the freshness rule. */
  policy?: VerifierPolicy;
}

/** Verifies whatever a <video> element is showing. */
export class VerifyPipeline {
  readonly session: ReceiverSession;
  frames = 0;
  costMs = 0;
  private readonly video: HTMLVideoElement;
  private readonly sampler: RgbaCellSampler;
  private readonly reduced = reducedContext();
  private readonly grab: { canvas: HTMLCanvasElement | OffscreenCanvas; ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D } | null = null;
  private readonly warped = new Uint8ClampedArray(REDUCED_W * REDUCED_H * 4);
  private readonly opts: VerifyPipelineOptions;
  private stopFrames: (() => void) | null = null;
  private timeBase: number | null = null;
  private lastMedia = -1;

  constructor(opts: VerifyPipelineOptions) {
    this.opts = opts;
    this.video = opts.video;
    this.session = new ReceiverSession({ directory: opts.directory, policy: opts.policy });
    this.sampler = new RgbaCellSampler(makeLayout());
    if (opts.region) {
      const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(640, 360) : Object.assign(document.createElement('canvas'), { width: 640, height: 360 });
      this.grab = { canvas, ctx: canvas.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D };
    }
  }

  start(): void {
    if (this.stopFrames) return;
    this.stopFrames = onVideoFrames(this.video, (now, meta) => this.frame(now, meta));
  }

  stop(): void {
    this.stopFrames?.();
    this.stopFrames = null;
  }

  private frame(now: number, meta: VideoFrameMeta): void {
    const video = this.video;
    if (!video.videoWidth || !video.videoHeight) return;
    const t0 = performance.now();
    // Prefer the media timeline (it follows the sender's capture clock); fall back to arrival time.
    let t = now;
    if (typeof meta.mediaTime === 'number' && meta.mediaTime > 0 && meta.mediaTime !== this.lastMedia) {
      if (this.timeBase === null) this.timeBase = now - meta.mediaTime * 1000;
      t = this.timeBase + meta.mediaTime * 1000;
      this.lastMedia = meta.mediaTime;
    }
    let rgba: Uint8ClampedArray;
    const quad = this.opts.region?.();
    if (quad && this.grab && !isFullFrame(quad)) {
      // perspective sampling for phone mode and screen regions
      const gw = this.grab.canvas.width;
      const gh = this.grab.canvas.height;
      this.grab.ctx.drawImage(video, 0, 0, gw, gh);
      const src = this.grab.ctx.getImageData(0, 0, gw, gh).data;
      warpQuad(src, gw, gh, quad, this.warped);
      rgba = this.warped;
    } else {
      this.reduced.ctx.drawImage(video, 0, 0, REDUCED_W, REDUCED_H);
      rgba = this.reduced.ctx.getImageData(0, 0, REDUCED_W, REDUCED_H).data;
    }
    const means = this.sampler.sample(rgba);
    const clock = this.opts.clock ? this.opts.clock() : Date.now();
    this.frames++;
    void this.session.pushFrame(t, means, this.sampler.luma, clock).then((report) => {
      if (report) this.opts.onReport(report);
    });
    this.costMs += (performance.now() - t0 - this.costMs) / Math.min(this.frames, 120);
  }
}

function isFullFrame(q: Quad): boolean {
  return q[0][0] === 0 && q[0][1] === 0 && q[1][0] === 1 && q[1][1] === 0 && q[2][0] === 1 && q[2][1] === 1 && q[3][0] === 0 && q[3][1] === 1;
}

/** Homography that maps the unit square to `quad` (in pixels). Returns 8 coefficients. */
function squareToQuad(q: [number, number][]): number[] {
  const [[x0, y0], [x1, y1], [x2, y2], [x3, y3]] = q;
  const dx1 = x1 - x2;
  const dx2 = x3 - x2;
  const dx3 = x0 - x1 + x2 - x3;
  const dy1 = y1 - y2;
  const dy2 = y3 - y2;
  const dy3 = y0 - y1 + y2 - y3;
  const den = dx1 * dy2 - dx2 * dy1;
  const g = den === 0 ? 0 : (dx3 * dy2 - dx2 * dy3) / den;
  const h = den === 0 ? 0 : (dx1 * dy3 - dx3 * dy1) / den;
  return [x1 - x0 + g * x1, x3 - x0 + h * x3, x0, y1 - y0 + g * y1, y3 - y0 + h * y3, y0, g, h];
}

/** Samples the quadrilateral region of an RGBA image into a REDUCED_W x REDUCED_H RGBA image (bilinear). */
export function warpQuad(src: Uint8ClampedArray, sw: number, sh: number, quad: Quad, out: Uint8ClampedArray): void {
  const [a, b, c, d, e, f, g, h] = squareToQuad(quad.map(([x, y]) => [x * (sw - 1), y * (sh - 1)]));
  for (let j = 0; j < REDUCED_H; j++) {
    const v = (j + 0.5) / REDUCED_H;
    for (let i = 0; i < REDUCED_W; i++) {
      const u = (i + 0.5) / REDUCED_W;
      const w = g * u + h * v + 1;
      let x = (a * u + b * v + c) / w;
      let y = (d * u + e * v + f) / w;
      x = x < 0 ? 0 : x > sw - 1.001 ? sw - 1.001 : x;
      y = y < 0 ? 0 : y > sh - 1.001 ? sh - 1.001 : y;
      const x0 = x | 0;
      const y0 = y | 0;
      const fx = x - x0;
      const fy = y - y0;
      const p = (y0 * sw + x0) * 4;
      const o = (j * REDUCED_W + i) * 4;
      for (let ch = 0; ch < 3; ch++) {
        const top = src[p + ch] * (1 - fx) + src[p + 4 + ch] * fx;
        const bottom = src[p + sw * 4 + ch] * (1 - fx) + src[p + sw * 4 + 4 + ch] * fx;
        out[o + ch] = top * (1 - fy) + bottom * fy;
      }
      out[o + 3] = 255;
    }
  }
}
