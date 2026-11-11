// Test support: a synthetic talking-head scene and a codec-free "call" that
// wires a SenderSession to a ReceiverSession through the real embedder,
// reducer, sampler and demodulator.

import { prng } from '../src/bytes.ts';
import type { KeyDirectory } from '../src/directory.ts';
import { CellSampler, Embedder, makeLayout, makeReducer } from '../src/modem.ts';
import { ReceiverSession, SenderSession, type PeriodReport } from '../src/session.ts';
import type { Signer } from '../src/crypto.ts';

export const W = 640;
export const H = 360;
export const FPS = 30;

export interface Planes {
  y: Uint8Array;
  u: Uint8Array;
  v: Uint8Array;
}

/** A static irregular background with an animated face-like object. Different seeds give different "people". */
export class SyntheticScene {
  readonly face: [number, number, number, number] = [0.36, 0.14, 0.28, 0.6];
  private readonly base: Planes;
  private readonly seed: number;
  private readonly eye: number;
  private readonly mouth: number;
  private readonly tone: number;
  private readonly brow: number;
  private readonly tilt: number;

  constructor(seed: number) {
    this.seed = seed;
    const rand = prng(seed * 7919 + 13);
    const u01 = () => rand() / 4294967296;
    this.eye = 0.28 + u01() * 0.2;
    this.mouth = 0.25 + u01() * 0.35;
    this.tone = 120 + u01() * 70;
    this.brow = u01() * 0.25;
    this.tilt = (u01() - 0.5) * 0.6;
    const make = (w: number, h: number, mid: number, amp: number) => {
      const img = new Uint8Array(w * h);
      const waves = Array.from({ length: 7 }, () => [u01() * 0.06, u01() * 0.06, u01() * 6.28, (4 + u01() * 12) * amp]);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          let v = mid;
          for (const [fx, fy, ph, a] of waves) v += a * Math.sin(x * fx * (640 / w) + y * fy * (640 / w) + ph);
          img[y * w + x] = Math.max(8, Math.min(247, Math.round(v)));
        }
      }
      return img;
    };
    this.base = { y: make(W, H, 105, 1), u: make(W / 2, H / 2, 128, 0.25), v: make(W / 2, H / 2, 128, 0.25) };
  }

  /** Frame `k` of the scene. `still` freezes the animation. */
  frame(k: number, noiseSeed = 0): Planes {
    const y = this.base.y.slice();
    const u = this.base.u.slice();
    const v = this.base.v.slice();
    const t = k / FPS;
    const [fx, fy, fw, fh] = this.face;
    const cx = (fx + fw / 2 + 0.012 * Math.sin(t * 1.7 + this.seed)) * W;
    const cy = (fy + fh / 2 + 0.008 * Math.sin(t * 1.1)) * H;
    const rx = (fw / 2) * W * 0.82;
    const ry = (fh / 2) * H * 0.9;
    const open = 0.25 + 0.75 * Math.abs(Math.sin(t * 5.3 + this.seed * 0.7)); // talking
    const blink = Math.sin(t * 2.1 + this.seed) > 0.96 ? 0.2 : 1;
    for (let py = Math.max(0, Math.floor(cy - ry)); py < Math.min(H, Math.ceil(cy + ry)); py++) {
      for (let px = Math.max(0, Math.floor(cx - rx)); px < Math.min(W, Math.ceil(cx + rx)); px++) {
        const a = (px - cx) / rx;
        const b = (py - cy) / ry;
        const r2 = a * a + b * b;
        if (r2 > 1) continue;
        const ar = a + this.tilt * b * 0.3;
        let val = this.tone - 30 * r2 + 18 * a; // shading
        // eyes
        for (const side of [-1, 1]) {
          const ex = (ar - side * this.eye) / 0.13;
          const ey = (b + 0.22) / (0.07 * blink);
          if (ex * ex + ey * ey < 1) val -= 75;
          const bx = (ar - side * this.eye) / 0.2;
          const by = (b + 0.38 + this.brow * 0.3) / 0.035;
          if (bx * bx + by * by < 1) val -= 45;
        }
        // nose and mouth
        if (Math.abs(ar) < 0.05 && b > -0.1 && b < 0.2) val -= 16;
        const mx = ar / this.mouth;
        const my = (b - 0.5) / (0.05 + 0.1 * open);
        if (mx * mx + my * my < 1) val -= 70;
        y[py * W + px] = Math.max(8, Math.min(247, Math.round(val)));
        if ((px & 1) === 0 && (py & 1) === 0) {
          const ci = (py >> 1) * (W / 2) + (px >> 1);
          u[ci] = 118;
          v[ci] = 142;
        }
      }
    }
    // light sensor noise
    let state = (Math.imul(k + 1 + noiseSeed, 0x9e3779b1) ^ this.seed) >>> 0;
    for (const plane of [y, u, v]) {
      for (let i = 0; i < plane.length; i++) {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        plane[i] += ((state >>> 24) % 3) - 1;
      }
    }
    return { y, u, v };
  }
}

export interface CallOptions {
  signer: Signer;
  directory: KeyDirectory;
  seconds: number;
  /** Scene the genuine sender films. */
  scene: SyntheticScene;
  /**
   * What the receiver is shown. 'genuine': the sealed frames. 'relay': the
   * genuine seal lifted onto another scene's frames. 'unsealed': the scene
   * with no seal.
   */
  mode?: 'genuine' | 'relay' | 'unsealed';
  attackerScene?: SyntheticScene;
  /** Added to the verifier's clock: a positive value plays the call back later (replay). */
  receiverDelayMs?: number;
  /** Hook called once per frame before the receiver sees it. */
  each?: (k: number, sender: SenderSession, receiver: ReceiverSession) => void;
  amplitude?: ArrayLike<number>;
  senderEpoch?: number;
}

/** Runs a synthetic call without a codec and returns one report per seal period. */
export async function runCall(opts: CallOptions): Promise<PeriodReport[]> {
  const layout = makeLayout();
  const sender = new SenderSession({ signer: opts.signer, amplitude: opts.amplitude });
  const receiver = new ReceiverSession({ directory: opts.directory });
  const embedY = new Embedder(layout, W, H);
  const embedC = new Embedder(layout, W / 2, H / 2);
  const reduceY = makeReducer(W, H);
  const reduceC = makeReducer(W / 2, H / 2);
  const sampler = new CellSampler(layout);
  const means = new Float32Array(layout.cells);
  const field = new Float32Array(layout.cells);
  const epoch = opts.senderEpoch ?? 1_800_000_000_000 + 440;
  const reports: PeriodReport[] = [];
  const mode = opts.mode ?? 'genuine';
  for (let k = 0; k < opts.seconds * FPS; k++) {
    const now = epoch + (k * 1000) / FPS;
    const real = opts.scene.frame(k);
    sender.pushFrame(now, reduceY(real.y, W));
    await new Promise<void>((resolve) => setTimeout(resolve, 0)); // let the signature finish, as it would between frames
    sender.field(now, field);
    opts.each?.(k, sender, receiver);
    // the picture the receiver gets
    const shown = mode === 'relay' ? opts.attackerScene!.frame(k, 99) : real;
    if (mode !== 'unsealed') {
      embedY.apply(shown.y, W, field, 0, k);
      embedC.apply(shown.u, W / 2, field, 1, k);
      embedC.apply(shown.v, W / 2, field, 2, k);
    }
    const luma = reduceY(shown.y, W);
    sampler.sample(luma, means, 0);
    sampler.sample(reduceC(shown.u, W / 2), means, layout.planeCells);
    sampler.sample(reduceC(shown.v, W / 2), means, 2 * layout.planeCells);
    const report = await receiver.pushFrame(5000 + (k * 1000) / FPS, means, luma, now + 180 + (opts.receiverDelayMs ?? 0));
    if (report) reports.push(report);
  }
  return reports;
}

export function codes(reports: PeriodReport[]): string[] {
  return reports.map((r) => r.outcome.code);
}

export function levels(reports: PeriodReport[]): string[] {
  return reports.map((r) => r.badge.level);
}
