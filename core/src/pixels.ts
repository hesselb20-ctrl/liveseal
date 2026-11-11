// Colour conversion between RGBA pixels (what a browser canvas gives) and the
// Y, Cb, Cr planes the modem works in. BT.601 full-range coefficients; the
// same matrix is used by the sealing shader.

import { CellSampler, REDUCED_H, REDUCED_W, type ModemLayout } from './modem.ts';

/** RGB offset that changes Y, Cb, Cr by (dy, dcb, dcr) and nothing else. */
export function yccToRgbOffset(dy: number, dcb: number, dcr: number): [number, number, number] {
  return [dy + 1.402 * dcr, dy - 0.344136 * dcb - 0.714136 * dcr, dy + 1.772 * dcb];
}

/**
 * A browser encoder stores video in "limited range": luma is scaled by
 * 219/255 and chroma by 224/255 on the way in. Seal amplitudes are defined in
 * the encoder's units, so offsets applied to canvas RGB are scaled up by
 * these factors.
 */
export const RGB_LUMA_GAIN = 255 / 219;
export const RGB_CHROMA_GAIN = 255 / 224;

/** Splits RGBA pixels into float Y, Cb, Cr planes (Cb and Cr centred on 128). */
export function rgbaToPlanes(
  rgba: ArrayLike<number>, pixels: number, y: Float32Array, cb: Float32Array, cr: Float32Array,
): void {
  for (let i = 0, p = 0; i < pixels; i++, p += 4) {
    const r = rgba[p];
    const g = rgba[p + 1];
    const b = rgba[p + 2];
    y[i] = 0.299 * r + 0.587 * g + 0.114 * b;
    cb[i] = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
    cr[i] = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;
  }
}

/**
 * Receiver front end for browser use: takes an RGBA image that is already
 * REDUCED_W x REDUCED_H (the page draws the video into a canvas of that size)
 * and returns the cell means of all planes for the demodulator.
 */
export class RgbaCellSampler {
  private readonly layout: ModemLayout;
  private readonly sampler: CellSampler;
  private readonly cb: Float32Array;
  private readonly cr: Float32Array;
  private readonly means: Float32Array;
  /** Reduced luma of the last frame, for the content digest. */
  readonly luma: Float32Array;

  constructor(layout: ModemLayout) {
    this.layout = layout;
    this.sampler = new CellSampler(layout);
    const n = REDUCED_W * REDUCED_H;
    this.luma = new Float32Array(n);
    this.cb = new Float32Array(n);
    this.cr = new Float32Array(n);
    this.means = new Float32Array(layout.cells);
  }

  sample(rgba: ArrayLike<number>): Float32Array {
    rgbaToPlanes(rgba, REDUCED_W * REDUCED_H, this.luma, this.cb, this.cr);
    this.sampler.sample(this.luma, this.means, 0);
    if (this.layout.params.planes === 3) {
      this.sampler.sample(this.cb, this.means, this.layout.planeCells);
      this.sampler.sample(this.cr, this.means, 2 * this.layout.planeCells);
    }
    return this.means;
  }
}
