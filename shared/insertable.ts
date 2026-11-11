// Sealing with Insertable Streams (MediaStreamTrackProcessor and
// MediaStreamTrackGenerator): frames are taken from the camera track, sealed
// on an OffscreenCanvas and written to a new track, with no <video> or
// visible canvas involved. Used where the browser offers these APIs; the
// canvas pipeline in pipelines.ts is the fallback everywhere else.

import type { Signer } from '../core/src/crypto.ts';
import { REDUCED_H, REDUCED_W } from '../core/src/modem.ts';
import { SenderSession } from '../core/src/session.ts';
import { GlSealer } from './gl-sealer.ts';
import { unixNow } from './pipelines.ts';

interface ProcessorCtor { new (init: { track: MediaStreamTrack }): { readable: ReadableStream<VideoFrame> } }
interface GeneratorCtor { new (init: { kind: 'video' }): MediaStreamTrack & { writable: WritableStream<VideoFrame> } }

function apis(): { Processor: ProcessorCtor; Generator: GeneratorCtor } | null {
  const g = globalThis as unknown as { MediaStreamTrackProcessor?: ProcessorCtor; MediaStreamTrackGenerator?: GeneratorCtor };
  if (!g.MediaStreamTrackProcessor || !g.MediaStreamTrackGenerator || typeof OffscreenCanvas === 'undefined' || typeof VideoFrame === 'undefined') return null;
  return { Processor: g.MediaStreamTrackProcessor, Generator: g.MediaStreamTrackGenerator };
}

export function supportsInsertableStreams(): boolean {
  return apis() !== null;
}

export class TrackSealer {
  /** The sealed track. */
  readonly track: MediaStreamTrack;
  readonly session: SenderSession;
  enabled = true;
  frames = 0;
  private readonly abort = new AbortController();

  constructor(input: MediaStreamTrack, signer: Signer, amplitude?: ArrayLike<number>) {
    const api = apis();
    if (!api) throw new Error('Insertable Streams are not available');
    this.session = new SenderSession({ signer, amplitude });
    const layout = this.session.layout;
    const canvas = new OffscreenCanvas(2, 2);
    const sealer = new GlSealer(layout, canvas);
    const small = new OffscreenCanvas(REDUCED_W, REDUCED_H);
    const ctx = small.getContext('2d', { willReadFrequently: true }) as OffscreenCanvasRenderingContext2D;
    const luma = new Float32Array(REDUCED_W * REDUCED_H);
    const field = new Float32Array(layout.cells);
    const processor = new api.Processor({ track: input });
    const generator = new api.Generator({ kind: 'video' });
    this.track = generator;
    const transform = new TransformStream<VideoFrame, VideoFrame>({
      transform: (frame, controller) => {
        try {
          const now = unixNow();
          ctx.drawImage(frame, 0, 0, REDUCED_W, REDUCED_H);
          const rgba = ctx.getImageData(0, 0, REDUCED_W, REDUCED_H).data;
          for (let i = 0, p = 0; i < luma.length; i++, p += 4) luma[i] = 0.299 * rgba[p] + 0.587 * rgba[p + 1] + 0.114 * rgba[p + 2];
          this.session.pushFrame(now, luma);
          this.session.field(now, field);
          sealer.draw(frame, frame.displayWidth, frame.displayHeight, field, this.frames++, this.enabled);
          controller.enqueue(new VideoFrame(canvas, { timestamp: frame.timestamp, duration: frame.duration ?? undefined }));
        } finally {
          frame.close();
        }
      },
    });
    void processor.readable.pipeThrough(transform, { signal: this.abort.signal }).pipeTo(generator.writable).catch(() => undefined);
  }

  stop(): void {
    this.abort.abort();
    this.track.stop();
  }
}
