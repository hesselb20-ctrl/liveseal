// Verifier worker: receives frames as ImageBitmaps, draws them into an
// OffscreenCanvas and runs the receiver session off the page's main thread.

import { KeyDirectory, type DirectorySnapshot } from '../core/src/directory.ts';
import { REDUCED_H, REDUCED_W, makeLayout } from '../core/src/modem.ts';
import { RgbaCellSampler } from '../core/src/pixels.ts';
import { ReceiverSession } from '../core/src/session.ts';
import type { BadgeContext } from '../core/src/verify.ts';

export type ToWorker =
  | { type: 'init'; directory: DirectorySnapshot }
  | { type: 'directory'; directory: DirectorySnapshot }
  | { type: 'frame'; t: number; unixMs: number; bitmap: ImageBitmap }
  | { type: 'challenge'; challenge: Uint8Array | null }
  | { type: 'context'; context: BadgeContext };

const scope = self as unknown as { postMessage(message: unknown): void; onmessage: ((e: MessageEvent<ToWorker>) => void) | null };
const canvas = new OffscreenCanvas(REDUCED_W, REDUCED_H);
const ctx = canvas.getContext('2d', { willReadFrequently: true }) as OffscreenCanvasRenderingContext2D;
const sampler = new RgbaCellSampler(makeLayout());
const directory = new KeyDirectory();
let session: ReceiverSession | null = null;
let queue: Promise<void> = Promise.resolve();

scope.onmessage = (e) => {
  const m = e.data;
  queue = queue.then(async () => {
    if (m.type === 'init') {
      directory.assign(await KeyDirectory.fromJSON(m.directory));
      session = new ReceiverSession({ directory });
      scope.postMessage({ type: 'ready' });
    } else if (m.type === 'directory') {
      directory.assign(await KeyDirectory.fromJSON(m.directory));
    } else if (m.type === 'challenge') {
      session?.checker.setChallenge(m.challenge);
    } else if (m.type === 'context') {
      session?.setContext(m.context);
    } else if (m.type === 'frame') {
      if (!session) { m.bitmap.close(); return; }
      ctx.drawImage(m.bitmap, 0, 0, REDUCED_W, REDUCED_H);
      m.bitmap.close();
      const rgba = ctx.getImageData(0, 0, REDUCED_W, REDUCED_H).data;
      const report = await session.pushFrame(m.t, sampler.sample(rgba), sampler.luma, m.unixMs);
      if (report) scope.postMessage({ type: 'report', report });
    }
  }).catch(() => undefined);
};
