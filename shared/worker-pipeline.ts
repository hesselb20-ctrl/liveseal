// Main-thread half of the worker verifier: samples video frames and ships
// them to shared/verify-worker.ts. Same surface as VerifyPipeline, so callers
// can fall back to the in-thread version where workers are not allowed.

import type { DirectorySnapshot } from '../core/src/directory.ts';
import { REDUCED_H, REDUCED_W } from '../core/src/modem.ts';
import type { PeriodReport } from '../core/src/session.ts';
import type { Badge, BadgeContext } from '../core/src/verify.ts';
import { onVideoFrames } from './pipelines.ts';

export interface Verifier {
  start(): void;
  stop(): void;
  setChallenge(challenge: Uint8Array | null): void;
  getChallenge(): Uint8Array | null;
  setContext(context: BadgeContext): void;
  readonly badge: Badge | null;
}

export class WorkerVerifier implements Verifier {
  badge: Badge | null = null;
  private readonly worker: Worker;
  private readonly video: HTMLVideoElement;
  private readonly onReport: (report: PeriodReport) => void;
  private stopFrames: (() => void) | null = null;
  private busy = false;
  private ready = false;
  private challenge: Uint8Array | null = null;
  private timeBase: number | null = null;
  private resolveReady: (ok: boolean) => void = () => undefined;
  private readonly readyPromise = new Promise<boolean>((resolve) => { this.resolveReady = resolve; });

  /** Resolves true once the worker has started, or false if it has not within `timeoutMs` (blocked by the page, for example). */
  whenReady(timeoutMs: number): Promise<boolean> {
    return Promise.race([this.readyPromise, new Promise<boolean>((resolve) => setTimeout(() => resolve(false), timeoutMs))]);
  }

  constructor(worker: Worker, video: HTMLVideoElement, directory: DirectorySnapshot, onReport: (report: PeriodReport) => void) {
    this.worker = worker;
    this.video = video;
    this.onReport = onReport;
    worker.onmessage = (e: MessageEvent<{ type: string; report?: PeriodReport }>) => {
      if (e.data.type === 'ready') { this.ready = true; this.resolveReady(true); }
      if (e.data.type === 'report' && e.data.report) {
        this.badge = e.data.report.badge;
        this.onReport(e.data.report);
      }
    };
    worker.onerror = () => this.resolveReady(false);
    worker.postMessage({ type: 'init', directory });
  }

  updateDirectory(directory: DirectorySnapshot): void {
    this.worker.postMessage({ type: 'directory', directory });
  }

  start(): void {
    if (this.stopFrames) return;
    this.stopFrames = onVideoFrames(this.video, (now, meta) => {
      if (!this.ready || this.busy || !this.video.videoWidth) return;
      let t = now;
      if (typeof meta.mediaTime === 'number' && meta.mediaTime > 0) {
        if (this.timeBase === null) this.timeBase = now - meta.mediaTime * 1000;
        t = this.timeBase + meta.mediaTime * 1000;
      }
      this.busy = true;
      createImageBitmap(this.video, { resizeWidth: REDUCED_W, resizeHeight: REDUCED_H, resizeQuality: 'medium' }).then((bitmap) => {
        this.worker.postMessage({ type: 'frame', t, unixMs: Date.now(), bitmap }, [bitmap]);
      }).catch(() => undefined).finally(() => { this.busy = false; });
    });
  }

  stop(): void {
    this.stopFrames?.();
    this.stopFrames = null;
    this.worker.terminate();
  }

  setChallenge(challenge: Uint8Array | null): void {
    this.challenge = challenge;
    this.worker.postMessage({ type: 'challenge', challenge });
  }

  getChallenge(): Uint8Array | null {
    return this.challenge;
  }

  setContext(context: BadgeContext): void {
    this.worker.postMessage({ type: 'context', context });
  }
}
