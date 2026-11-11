// One channel experiment: seal a clip, push it through a real codec, run the
// real receiver on the result and compare with what was sent.

import { prng } from '../core/src/bytes.ts';
import {
  CellSampler, Demodulator, Embedder, SealSchedule, makeLayout, makeReducer, type DemodOptions, type ModemLayout,
  type ModemParams, DEFAULT_DEMOD, DEFAULT_MODEM,
} from '../core/src/modem.ts';
import { PERIOD_MS } from '../core/src/statement.ts';
import { RawReader, RawWriter, prepareClip, psnr, remove, tmpPath, transcode, rawInfo, type CodecConfig, type RawInfo } from './video.ts';

export interface ChannelConfig {
  clip: string;
  width: number;
  height: number;
  seconds: number;
  codec: CodecConfig;
  /** Further encode/decode passes applied after the first (re-encoding, re-filming). */
  stages?: CodecConfig[];
  modem?: ModemParams;
  /** Peak luma offset per cell, in 8-bit levels. 0 sends unsealed video. */
  amplitude: number;
  /** Peak offset in the Cb and Cr planes (three-plane modems only). Defaults to `amplitude`. */
  chroma?: number;
  demod?: DemodOptions;
  /** Size and frame rate of the decoded video when filters change them. */
  outSize?: { width: number; height: number; fps?: number };
  /** Fraction of frames the receiver never sees (random, on top of any filter). */
  dropRate?: number;
  seed?: number;
}

export interface ChannelResult {
  config: ChannelConfig;
  kbps: number;
  /** Periods that were completely inside the clip and carried a statement. */
  periodsSent: number;
  /** Periods where the receiver reported pilots. */
  periodsDetected: number;
  /** Periods whose statement was recovered bit-exact. */
  periodsRecovered: number;
  /** Recovered periods, not counting the first two after the stream starts (encoder warm-up). */
  steadySent: number;
  steadyRecovered: number;
  /** Periods that decoded to something other than what was sent (must be 0). */
  periodsWrong: number;
  /** Error rate of the hard decisions before error correction, over detected periods. */
  rawBitErrorRate: number;
  meanPilotScore: number;
  minPilotScore: number;
  /** Highest pilot score reported while no seal was found (for threshold setting). */
  maxAbsentScore: number;
  /** Mean measured amplitude per plane. */
  meanAmplitude: number[];
  /** PSNR of the seal alone (sealed vs. original, before the codec), luma. */
  sealPsnr: number;
  /** PSNR of the codec (decoded vs. sealed input), luma; only when sizes match. */
  codecPsnr: number;
  /** Receiver time from the first frame to the first recovered statement, ms. */
  firstRecoveryMs: number;
  perPeriod: { period: number; score: number; bitErrors: number; ok: boolean; planeErrors: number[]; amplitude: number[] }[];
}

export const SENDER_EPOCH = 1_800_000_000_000 + 370; // an arbitrary sender clock, deliberately not on a period boundary
export const RECEIVER_OFFSET = 51_234.5; // the receiver's timebase is unrelated to the sender's

/** Splits an I420 frame buffer into its planes (views, no copy). */
export function planesOf(frame: Uint8Array, width: number, height: number): { y: Uint8Array; u: Uint8Array; v: Uint8Array; cw: number; ch: number } {
  const cw = (width + 1) >> 1;
  const ch = (height + 1) >> 1;
  const ySize = width * height;
  return {
    y: frame.subarray(0, ySize),
    u: frame.subarray(ySize, ySize + cw * ch),
    v: frame.subarray(ySize + cw * ch, ySize + 2 * cw * ch),
    cw,
    ch,
  };
}

/** Adds the seal for one moment to an I420 frame in place. */
export class FrameSealer {
  private readonly layout: ModemLayout;
  private readonly luma: Embedder;
  private readonly chroma: Embedder;
  private readonly field: Float32Array;
  private readonly width: number;
  private readonly height: number;

  constructor(layout: ModemLayout, width: number, height: number) {
    this.layout = layout;
    this.width = width;
    this.height = height;
    this.luma = new Embedder(layout, width, height);
    this.chroma = new Embedder(layout, (width + 1) >> 1, (height + 1) >> 1);
    this.field = new Float32Array(layout.cells);
  }

  seal(frame: Uint8Array, schedule: SealSchedule, unixMs: number, amplitude: number, chroma: number, frameIndex: number): void {
    const p = planesOf(frame, this.width, this.height);
    schedule.field(unixMs, [amplitude, chroma, chroma], this.field);
    this.luma.apply(p.y, this.width, this.field, 0, frameIndex);
    if (this.layout.params.planes === 3) {
      this.chroma.apply(p.u, p.cw, this.field, 1, frameIndex);
      this.chroma.apply(p.v, p.cw, this.field, 2, frameIndex);
    }
  }
}

/** Turns decoded I420 frames into the cell means the demodulator consumes. */
export class FrameSampler {
  private readonly layout: ModemLayout;
  private readonly reduceY: ReturnType<typeof makeReducer>;
  private readonly reduceC: ReturnType<typeof makeReducer>;
  private readonly sampler: CellSampler;
  private readonly width: number;
  private readonly height: number;
  private readonly means: Float32Array;
  /** The reduced luma of the last frame given to `sample`. */
  reducedLuma: Float32Array = new Float32Array(0);

  constructor(layout: ModemLayout, width: number, height: number) {
    this.layout = layout;
    this.width = width;
    this.height = height;
    this.reduceY = makeReducer(width, height);
    this.reduceC = makeReducer((width + 1) >> 1, (height + 1) >> 1);
    this.sampler = new CellSampler(layout);
    this.means = new Float32Array(layout.cells);
  }

  sample(frame: Uint8Array): Float32Array {
    const p = planesOf(frame, this.width, this.height);
    this.reducedLuma = this.reduceY(p.y, this.width);
    this.sampler.sample(this.reducedLuma, this.means, 0);
    if (this.layout.params.planes === 3) {
      this.sampler.sample(this.reduceC(p.u, p.cw), this.means, this.layout.planeCells);
      this.sampler.sample(this.reduceC(p.v, p.cw), this.means, 2 * this.layout.planeCells);
    }
    return this.means;
  }
}

export function runChannel(cfg: ChannelConfig): ChannelResult {
  const layout = makeLayout(cfg.modem ?? DEFAULT_MODEM);
  const src = prepareClip(cfg.clip, cfg.width, cfg.height);
  const total = Math.round(cfg.seconds * src.fps);
  const frameMs = 1000 / src.fps;
  const lumaSize = cfg.width * cfg.height;
  const rand = prng(cfg.seed ?? 1);
  const epoch = SENDER_EPOCH + ((cfg.seed ?? 1) - 1) * 437;
  const chromaAmp = cfg.chroma ?? cfg.amplitude;

  // --- sender
  const schedule = new SealSchedule(layout);
  const sealer = new FrameSealer(layout, cfg.width, cfg.height);
  const sent = new Map<number, { wire: Uint8Array; bits: Uint8Array }>();
  const firstPeriod = Math.floor(epoch / PERIOD_MS);
  const lastPeriod = Math.floor((epoch + total * frameMs) / PERIOD_MS);
  for (let p = firstPeriod; p <= lastPeriod; p++) {
    const wire = Uint8Array.from({ length: layout.fec.capacity }, () => rand() & 0xff);
    sent.set(p, { wire, bits: layout.fec.encode(wire) });
  }
  const reader = new RawReader(src);
  const sealedPath = tmpPath('yuv');
  const writer = new RawWriter(sealedPath);
  const frame = new Uint8Array(src.width * src.height * 3 / 2);
  const original = new Uint8Array(lumaSize);
  let sealPsnrSum = 0;
  let sealPsnrCount = 0;
  const sealing = cfg.amplitude > 0 || chromaAmp > 0;
  for (let k = 0; k < total; k++) {
    reader.read(k, frame, true);
    if (sealing) {
      const measure = k % 30 === 15;
      if (measure) original.set(frame.subarray(0, lumaSize));
      const now = epoch + k * frameMs;
      const p = Math.floor(now / PERIOD_MS);
      if (!schedule.hasPeriod(p)) schedule.setPeriod(p, sent.get(p)!.wire);
      sealer.seal(frame, schedule, now, cfg.amplitude, chromaAmp, k);
      if (measure) {
        sealPsnrSum += psnr(original, frame, lumaSize);
        sealPsnrCount++;
      }
    }
    writer.write(frame);
  }
  writer.close();
  reader.close();

  // --- codec
  const sealed = rawInfo(sealedPath, cfg.width, cfg.height, src.fps);
  let { out, kbps } = transcode(sealed, cfg.codec, cfg.outSize);
  for (const stage of cfg.stages ?? []) {
    const next = transcode(out, stage, { width: out.width, height: out.height, fps: out.fps });
    remove(out.path);
    out = next.out;
  }
  const result = receive(cfg, layout, out, sent, firstPeriod, lastPeriod, sealing, sealed, total, rand, epoch);
  remove(sealedPath);
  remove(out.path);
  return { ...result, kbps: Math.round(kbps), sealPsnr: sealPsnrCount ? sealPsnrSum / sealPsnrCount : 99 };
}

function receive(
  cfg: ChannelConfig, layout: ModemLayout, out: RawInfo, sent: Map<number, { wire: Uint8Array; bits: Uint8Array }>,
  firstPeriod: number, lastPeriod: number, sealing: boolean, sealed: RawInfo, total: number, rand: () => number,
  epoch: number,
): ChannelResult {
  const sampler = new FrameSampler(layout, out.width, out.height);
  const demod = new Demodulator(layout, cfg.demod ?? DEFAULT_DEMOD);
  const rx = new RawReader(out);
  const rxFrame = new Uint8Array(out.width * out.height * 3 / 2);
  const outFrameMs = 1000 / out.fps;
  const lumaSize = cfg.width * cfg.height;
  const sameSize = out.width === cfg.width && out.height === cfg.height && out.fps === sealed.fps && out.frames === total;
  const sealedReader = sameSize ? new RawReader(sealed) : null;
  const sealedFrame = sameSize ? new Uint8Array(rxFrame.length) : null;
  let codecPsnrSum = 0;
  let codecPsnrCount = 0;

  const perPeriod: ChannelResult['perPeriod'] = [];
  let detected = 0;
  let recovered = 0;
  let steadyRecovered = 0;
  let wrong = 0;
  let bitErrors = 0;
  let bitsSeen = 0;
  let scoreSum = 0;
  let minScore = 1;
  let maxAbsent = -1;
  const ampSum = new Array<number>(layout.params.planes).fill(0);
  let firstRecoveryMs = -1;
  const dropRate = cfg.dropRate ?? 0;
  const startOf = (p: number) => p * PERIOD_MS - epoch; // ms into the clip
  const isSteady = (p: number) => startOf(p) >= 2 * PERIOD_MS;

  for (let k = 0; k < out.frames; k++) {
    rx.read(k, rxFrame);
    if (sealedReader && sealedFrame && k % 30 === 15) {
      sealedReader.read(k, sealedFrame);
      codecPsnrSum += psnr(sealedFrame, rxFrame, lumaSize);
      codecPsnrCount++;
    }
    if (dropRate > 0 && rand() / 4294967296 < dropRate) continue;
    const t = RECEIVER_OFFSET + k * outFrameMs;
    demod.push(t, sampler.sample(rxFrame));
    const res = demod.poll();
    if (!res) continue;
    if (!res.present) {
      if (res.pilotScore > maxAbsent) maxAbsent = res.pilotScore;
      continue;
    }
    const senderMs = res.startMs - RECEIVER_OFFSET + epoch;
    const period = Math.round(senderMs / PERIOD_MS);
    const truth = sealing ? sent.get(period) : undefined;
    detected++;
    scoreSum += res.pilotScore;
    res.amplitude.forEach((a, i) => { ampSum[i] += a; });
    if (res.pilotScore < minScore) minScore = res.pilotScore;
    let errs = 0;
    const planeErrors = new Array<number>(layout.params.planes).fill(0);
    if (truth && res.llr) {
      for (let i = 0; i < truth.bits.length; i++) {
        if ((res.llr[i] < 0 ? 1 : 0) !== truth.bits[i]) {
          errs++;
          planeErrors[Math.floor(layout.dataCells[Math.floor(i / layout.bitsPerCell)] / layout.planeCells)]++;
        }
      }
      bitErrors += errs;
      bitsSeen += truth.bits.length;
    }
    let ok = false;
    if (res.wire) {
      ok = !!truth && res.wire.length === truth.wire.length && res.wire.every((b, i) => b === truth.wire[i]);
      if (ok) {
        recovered++;
        if (isSteady(period)) steadyRecovered++;
        if (firstRecoveryMs < 0) firstRecoveryMs = k * outFrameMs;
      } else {
        wrong++;
      }
    }
    perPeriod.push({
      period: period - firstPeriod, score: +res.pilotScore.toFixed(3), bitErrors: errs, ok, planeErrors,
      amplitude: res.amplitude.map((a) => +a.toFixed(2)),
    });
  }
  rx.close();
  sealedReader?.close();

  // periods that lie completely inside the clip
  const durationMs = out.frames * outFrameMs;
  let periodsSent = 0;
  let steadySent = 0;
  for (let p = firstPeriod; p <= lastPeriod; p++) {
    const start = startOf(p);
    if (start >= 0 && start + PERIOD_MS <= durationMs) {
      periodsSent++;
      if (isSteady(p)) steadySent++;
    }
  }

  return {
    config: cfg,
    kbps: 0,
    periodsSent: sealing ? periodsSent : 0,
    periodsDetected: detected,
    periodsRecovered: recovered,
    steadySent: sealing ? steadySent : 0,
    steadyRecovered,
    periodsWrong: wrong,
    rawBitErrorRate: bitsSeen ? bitErrors / bitsSeen : 0,
    meanPilotScore: detected ? scoreSum / detected : 0,
    minPilotScore: detected ? minScore : 0,
    maxAbsentScore: maxAbsent,
    meanAmplitude: ampSum.map((a) => (detected ? a / detected : 0)),
    sealPsnr: 99,
    codecPsnr: codecPsnrCount ? codecPsnrSum / codecPsnrCount : 0,
    firstRecoveryMs,
    perPeriod,
  };
}

export function summarize(r: ChannelResult): string {
  const c = r.config;
  const m = c.modem ?? DEFAULT_MODEM;
  return [
    c.clip.padEnd(13), `${c.width}x${c.height}`.padEnd(9), c.codec.codec.padEnd(4), String(c.codec.kbps).padStart(5),
    c.codec.denoise ? 'dn' : '  ', `A=${c.amplitude}/${c.chroma ?? c.amplitude}`.padEnd(8), `${m.fec}${m.planes}`.padEnd(5),
    `got ${r.kbps}k`.padEnd(9), `rec ${r.periodsRecovered}/${r.periodsSent}`.padEnd(9),
    `steady ${r.steadyRecovered}/${r.steadySent}`.padEnd(12), `det ${r.periodsDetected}`.padEnd(6),
    `wrong ${r.periodsWrong}`, `bitER ${(r.rawBitErrorRate * 100).toFixed(1)}%`.padEnd(11),
    `pilot ${r.meanPilotScore.toFixed(2)}/${r.minPilotScore.toFixed(2)}`,
    `amp ${r.meanAmplitude.map((a) => a.toFixed(2)).join(',')}`, `null ${r.maxAbsentScore.toFixed(2)}`,
    `sealPSNR ${r.sealPsnr.toFixed(1)}`, `codecPSNR ${r.codecPsnr.toFixed(1)}`, `first ${r.firstRecoveryMs.toFixed(0)}ms`,
  ].join(' ');
}
