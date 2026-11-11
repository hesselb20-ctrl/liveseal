// The hidden channel: how coded bits become small level changes in the frame
// and how the receiver gets them back. Pure maths on plain arrays; the WebGL
// shader in shared/ implements `Embedder` with the same formulas.
//
// Summary (docs/DESIGN.md section 7, measurements in docs/EVALUATION.md):
//  * the frame is a grid of cells; each cell is shifted up or down a little;
//  * up to three planes carry independent patterns: luma (Y) and the two
//    colour-difference planes (Cb, Cr);
//  * a period is cut into `symbols` time slots; a cell holds its value for
//    one slot and may cross-fade into the next;
//  * every coded bit is an up/down or down/up pair of consecutive slots in
//    one cell (the receiver subtracts the halves, which cancels the picture);
//  * one cell in `pilotEvery` carries a fixed public sequence used for
//    detection, timing, amplitude and drift estimation.

import { prng } from './bytes.ts';
import { makeFec, type Fec, type FecKind } from './frame.ts';
import { PERIOD_MS } from './statement.ts';

export interface ModemParams {
  gridW: number;
  gridH: number;
  /** 1: luma only. 3: luma, Cb and Cr. */
  planes: number;
  /** Time slots per period. Must be 2, 4, 8 or 16. */
  symbols: number;
  /** One cell in this many is a pilot. */
  pilotEvery: number;
  /** Fraction of a cell's width used for the smooth transition to its neighbour. */
  edge: number;
  /** Cross-fade time at the start of each slot, in milliseconds. */
  fadeMs: number;
  /** Error-correcting code. */
  fec: FecKind;
  /** Reed-Solomon parity bytes for 'rs'; information bytes per frame for 'ldpc'. */
  redundancy: number;
}

export const DEFAULT_MODEM: ModemParams = {
  gridW: 32,
  gridH: 18,
  planes: 3,
  symbols: 8,
  pilotEvery: 8,
  edge: 0.2,
  fadeMs: 34,
  fec: 'ldpc',
  redundancy: 144,
};

/** Size of the common reduction that the receiver works on. */
export const REDUCED_W = 320;
export const REDUCED_H = 180;

export interface ModemLayout {
  params: ModemParams;
  /** Cells in one plane. */
  planeCells: number;
  /** Cells in all planes. Cell index: plane * planeCells + y * gridW + x. */
  cells: number;
  symMs: number;
  pilotCells: Int32Array;
  /** pilotSeq[p * symbols + s] is +1 or -1. */
  pilotSeq: Int8Array;
  dataCells: Int32Array;
  bitsPerCell: number;
  fec: Fec;
  /** One scrambling bit per data-cell bit. */
  scramble: Uint8Array;
}

const layouts = new Map<string, ModemLayout>();

export function makeLayout(params: ModemParams = DEFAULT_MODEM): ModemLayout {
  const key = JSON.stringify(params);
  const cached = layouts.get(key);
  if (cached) return cached;
  const { gridW, gridH, symbols, pilotEvery, planes } = params;
  if (![2, 4, 8, 16].includes(symbols)) throw new Error('modem: symbols must be 2, 4, 8 or 16');
  if (planes !== 1 && planes !== 3) throw new Error('modem: planes must be 1 or 3');
  const planeCells = gridW * gridH;
  const pilots: number[] = [];
  const data: number[] = [];
  for (let pl = 0; pl < planes; pl++) {
    for (let y = 0; y < gridH; y++) {
      for (let i = 0; i < gridW; i++) {
        const x = y % 2 === 0 ? i : gridW - 1 - i; // serpentine, so consecutive data cells are neighbours
        const cell = pl * planeCells + y * gridW + x;
        // the pilot lattice is shifted per plane so the three planes never have a pilot in the same place
        if ((x + 3 * y + 3 * pl) % pilotEvery === 0) pilots.push(cell);
        else data.push(cell);
      }
    }
  }
  const rand = prng(0x4c535031);
  const pilotSeq = new Int8Array(pilots.length * symbols);
  for (let p = 0; p < pilots.length; p++) {
    // a random balanced sequence: half up, half down
    const seq: number[] = Array.from({ length: symbols }, (_, i) => (i < symbols / 2 ? 1 : -1));
    for (let i = symbols - 1; i > 0; i--) {
      const j = rand() % (i + 1);
      [seq[i], seq[j]] = [seq[j], seq[i]];
    }
    pilotSeq.set(seq, p * symbols);
  }
  const bitsPerCell = symbols / 2;
  const fec = makeFec(params.fec, data.length * bitsPerCell, params.redundancy);
  const scramble = new Uint8Array(data.length * bitsPerCell);
  for (let i = 0; i < scramble.length; i++) scramble[i] = (rand() >>> 7) & 1;
  const layout: ModemLayout = {
    params,
    planeCells,
    cells: planes * planeCells,
    symMs: PERIOD_MS / symbols,
    pilotCells: Int32Array.from(pilots),
    pilotSeq,
    dataCells: Int32Array.from(data),
    bitsPerCell,
    fec,
    scramble,
  };
  layouts.set(key, layout);
  return layout;
}

/**
 * Turns coded bits into the sign of every cell in every slot of one period.
 * Coded bit i travels in data cell floor(i / bitsPerCell), pair i % bitsPerCell.
 * Result index: slot * cells + cell, values +1 or -1.
 */
export function bitsToSigns(layout: ModemLayout, coded: Uint8Array): Int8Array {
  const { cells, params, bitsPerCell } = layout;
  if (coded.length !== layout.fec.codedBits) throw new Error('modem: wrong number of coded bits');
  const signs = new Int8Array(params.symbols * cells);
  for (let p = 0; p < layout.pilotCells.length; p++) {
    for (let s = 0; s < params.symbols; s++) signs[s * cells + layout.pilotCells[p]] = layout.pilotSeq[p * params.symbols + s];
  }
  for (let d = 0; d < layout.dataCells.length; d++) {
    const cell = layout.dataCells[d];
    for (let b = 0; b < bitsPerCell; b++) {
      const i = d * bitsPerCell + b;
      const bit = (i < coded.length ? coded[i] : 0) ^ layout.scramble[i];
      // bit 0: up then down, bit 1: down then up
      signs[(2 * b) * cells + cell] = bit ? -1 : 1;
      signs[(2 * b + 1) * cells + cell] = bit ? 1 : -1;
    }
  }
  return signs;
}

/** Signs for one period that carries this statement (wire bytes). */
export function encodePeriod(layout: ModemLayout, wire: Uint8Array): Int8Array {
  return bitsToSigns(layout, layout.fec.encode(wire));
}

function smooth(t: number): number {
  const x = t <= 0 ? 0 : t >= 1 ? 1 : t;
  return x * x * (3 - 2 * x);
}

/** Where a moment falls in the slot structure. `mix` is the cross-fade from the previous slot (0) to this one (1). */
export function slotAt(layout: ModemLayout, unixMs: number): { period: number; slot: number; mix: number } {
  const period = Math.floor(unixMs / PERIOD_MS);
  const within = unixMs - period * PERIOD_MS;
  const slot = Math.min(layout.params.symbols - 1, Math.floor(within / layout.symMs));
  const frac = within - slot * layout.symMs;
  return { period, slot, mix: layout.params.fadeMs > 0 ? smooth(frac / layout.params.fadeMs) : 1 };
}

/**
 * Keeps the sign patterns of the current and previous period and produces
 * the per-cell offset ("field") for any moment.
 */
export class SealSchedule {
  readonly layout: ModemLayout;
  private periods = new Map<number, Int8Array>();
  private idle: Int8Array;

  constructor(layout: ModemLayout) {
    this.layout = layout;
    this.idle = encodePeriod(layout, new Uint8Array(0));
  }

  /** Sets the statement that will be transmitted during `period`. */
  setPeriod(period: number, wire: Uint8Array): void {
    this.periods.set(period, encodePeriod(this.layout, wire));
    for (const p of this.periods.keys()) if (p < period - 2) this.periods.delete(p);
  }

  hasPeriod(period: number): boolean {
    return this.periods.has(period);
  }

  private signs(period: number): Int8Array {
    return this.periods.get(period) ?? this.idle;
  }

  /**
   * Per-cell offset at this moment for all planes, in 8-bit levels.
   * `amplitude[plane]` is the peak offset of that plane.
   */
  field(unixMs: number, amplitude: ArrayLike<number>, out?: Float32Array): Float32Array {
    const { cells, planeCells, params } = this.layout;
    const field = out ?? new Float32Array(cells);
    const { period, slot, mix } = slotAt(this.layout, unixMs);
    const cur = this.signs(period);
    const prev = slot > 0 ? cur : this.signs(period - 1);
    const prevSlot = slot > 0 ? slot - 1 : params.symbols - 1;
    const a = cur.subarray(slot * cells, (slot + 1) * cells);
    const b = prev.subarray(prevSlot * cells, (prevSlot + 1) * cells);
    for (let c = 0; c < cells; c++) field[c] = amplitude[Math.floor(c / planeCells)] * (b[c] + (a[c] - b[c]) * mix);
    return field;
  }
}

interface Axis {
  a: Int32Array;
  b: Int32Array;
  w: Float32Array;
}

function axis(pixels: number, cells: number, edge: number): Axis {
  const a = new Int32Array(pixels);
  const b = new Int32Array(pixels);
  const w = new Float32Array(pixels);
  const half = edge / 2;
  for (let x = 0; x < pixels; x++) {
    const u = ((x + 0.5) / pixels) * cells;
    const i = Math.min(cells - 1, Math.floor(u));
    const f = u - i;
    if (edge > 0 && f < half && i > 0) {
      a[x] = i - 1; b[x] = i; w[x] = smooth(f / edge + 0.5);
    } else if (edge > 0 && f > 1 - half && i < cells - 1) {
      a[x] = i; b[x] = i + 1; w[x] = smooth((f - (1 - half)) / edge);
    } else {
      a[x] = i; b[x] = i; w[x] = 1;
    }
  }
  return { a, b, w };
}

/** CPU twin of the sealing shader: adds one plane of a field to an 8-bit image plane. */
export class Embedder {
  private readonly ax: Axis;
  private readonly ay: Axis;
  private readonly gridW: number;
  private readonly planeCells: number;
  readonly width: number;
  readonly height: number;

  /** `width` and `height` are the size of the image plane being modified (chroma planes are usually half size). */
  constructor(layout: ModemLayout, width: number, height: number) {
    this.width = width;
    this.height = height;
    this.gridW = layout.params.gridW;
    this.planeCells = layout.planeCells;
    this.ax = axis(width, layout.params.gridW, layout.params.edge);
    this.ay = axis(height, layout.params.gridH, layout.params.edge);
  }

  /** Value of the smoothed field of `plane` at one pixel, before rounding. */
  valueAt(field: Float32Array, plane: number, x: number, y: number): number {
    const { ax, ay, gridW } = this;
    const base = plane * this.planeCells;
    const r0 = base + ay.a[y] * gridW;
    const r1 = base + ay.b[y] * gridW;
    const top = field[r0 + ax.a[x]] * (1 - ax.w[x]) + field[r0 + ax.b[x]] * ax.w[x];
    const bottom = field[r1 + ax.a[x]] * (1 - ax.w[x]) + field[r1 + ax.b[x]] * ax.w[x];
    return top * (1 - ay.w[y]) + bottom * ay.w[y];
  }

  /**
   * Adds plane `plane` of the field to an 8-bit image plane in place. A little
   * random dither keeps fractional amplitudes correct on average after rounding.
   */
  apply(image: Uint8Array, stride: number, field: Float32Array, plane: number, frameIndex: number): void {
    const { ax, ay, gridW, width, height } = this;
    const base = plane * this.planeCells;
    let state = (Math.imul(frameIndex + 1 + plane * 7919, 0x9e3779b1) ^ 0x5bd1e995) >>> 0;
    for (let y = 0; y < height; y++) {
      const r0 = base + ay.a[y] * gridW;
      const r1 = base + ay.b[y] * gridW;
      const wy = ay.w[y];
      const row = y * stride;
      for (let x = 0; x < width; x++) {
        const xa = ax.a[x];
        const xb = ax.b[x];
        const wx = ax.w[x];
        const top = field[r0 + xa] * (1 - wx) + field[r0 + xb] * wx;
        const v = r0 === r1 ? top : top * (1 - wy) + (field[r1 + xa] * (1 - wx) + field[r1 + xb] * wx) * wy;
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        const out = Math.floor(image[row + x] + v + state / 4294967296);
        image[row + x] = out < 0 ? 0 : out > 255 ? 255 : out;
      }
    }
  }
}

/** Area-averaging reduction of an image plane to a fixed size. Returns a reusable function. */
export function makeReducer(
  srcW: number, srcH: number, dstW: number = REDUCED_W, dstH: number = REDUCED_H,
): (plane: ArrayLike<number>, stride: number, out?: Float32Array) => Float32Array {
  const spans = (src: number, dst: number) => {
    const start = new Int32Array(dst);
    const weights: Float32Array[] = [];
    const ratio = src / dst;
    for (let i = 0; i < dst; i++) {
      const lo = i * ratio;
      const hi = (i + 1) * ratio;
      const first = Math.min(src - 1, Math.floor(lo + 1e-9));
      const last = Math.max(first, Math.min(src - 1, Math.ceil(hi - 1e-9) - 1));
      const w = new Float32Array(last - first + 1);
      let sum = 0;
      for (let k = first; k <= last; k++) {
        w[k - first] = Math.max(0, Math.min(hi, k + 1) - Math.max(lo, k));
        sum += w[k - first];
      }
      for (let k = 0; k < w.length; k++) w[k] = sum > 0 ? w[k] / sum : 1 / w.length;
      start[i] = first;
      weights.push(w);
    }
    return { start, weights };
  };
  if (srcW === dstW && srcH === dstH) {
    return (plane, stride, out) => {
      const dst = out ?? new Float32Array(dstW * dstH);
      for (let y = 0; y < dstH; y++) {
        const row = y * stride;
        const o = y * dstW;
        for (let x = 0; x < dstW; x++) dst[o + x] = plane[row + x];
      }
      return dst;
    };
  }
  if (srcW === 2 * dstW && srcH === 2 * dstH) {
    return (plane, stride, out) => {
      const dst = out ?? new Float32Array(dstW * dstH);
      for (let y = 0; y < dstH; y++) {
        const r0 = 2 * y * stride;
        const r1 = r0 + stride;
        const o = y * dstW;
        for (let x = 0; x < dstW; x++) {
          const i = 2 * x;
          dst[o + x] = (plane[r0 + i] + plane[r0 + i + 1] + plane[r1 + i] + plane[r1 + i + 1]) * 0.25;
        }
      }
      return dst;
    };
  }
  const sx = spans(srcW, dstW);
  const sy = spans(srcH, dstH);
  const tmp = new Float32Array(dstW * srcH);
  return (plane, stride, out) => {
    const dst = out ?? new Float32Array(dstW * dstH);
    for (let y = 0; y < srcH; y++) {
      const row = y * stride;
      for (let i = 0; i < dstW; i++) {
        const w = sx.weights[i];
        const s = row + sx.start[i];
        let acc = 0;
        for (let k = 0; k < w.length; k++) acc += plane[s + k] * w[k];
        tmp[y * dstW + i] = acc;
      }
    }
    for (let j = 0; j < dstH; j++) {
      const w = sy.weights[j];
      const s = sy.start[j];
      for (let i = 0; i < dstW; i++) {
        let acc = 0;
        for (let k = 0; k < w.length; k++) acc += tmp[(s + k) * dstW + i] * w[k];
        dst[j * dstW + i] = acc;
      }
    }
    return dst;
  };
}

/** Mean of the flat centre of every cell of one plane, measured on the reduced image. */
export class CellSampler {
  private readonly x0: Int32Array;
  private readonly x1: Int32Array;
  private readonly y0: Int32Array;
  private readonly y1: Int32Array;
  private readonly gridW: number;
  private readonly gridH: number;
  private readonly redW: number;

  constructor(layout: ModemLayout, redW: number = REDUCED_W, redH: number = REDUCED_H) {
    const { gridW, gridH, edge } = layout.params;
    this.gridW = gridW;
    this.gridH = gridH;
    this.redW = redW;
    const bounds = (cells: number, pixels: number) => {
      const lo = new Int32Array(cells);
      const hi = new Int32Array(cells);
      const size = pixels / cells;
      // stay clear of the transition zone, plus a margin for blur and slight misregistration
      const inset = Math.max(edge / 2, 0.15);
      for (let c = 0; c < cells; c++) {
        lo[c] = Math.ceil((c + inset) * size - 1e-6);
        hi[c] = Math.max(lo[c] + 1, Math.floor((c + 1 - inset) * size + 1e-6));
      }
      return { lo, hi };
    };
    const bx = bounds(gridW, redW);
    const by = bounds(gridH, redH);
    this.x0 = bx.lo; this.x1 = bx.hi; this.y0 = by.lo; this.y1 = by.hi;
  }

  /** Writes gridW * gridH means into `out` starting at `offset`. */
  sample(reduced: ArrayLike<number>, out: Float32Array, offset = 0): Float32Array {
    for (let cy = 0; cy < this.gridH; cy++) {
      for (let cx = 0; cx < this.gridW; cx++) {
        let acc = 0;
        for (let y = this.y0[cy]; y < this.y1[cy]; y++) {
          const row = y * this.redW;
          for (let x = this.x0[cx]; x < this.x1[cx]; x++) acc += reduced[row + x];
        }
        out[offset + cy * this.gridW + cx] = acc / ((this.y1[cy] - this.y0[cy]) * (this.x1[cx] - this.x0[cx]));
      }
    }
    return out;
  }
}

// ------------------------------------------------------------ demodulator

export interface PeriodDecode {
  /** Start of the decoded period in the receiver's timebase (the `tMs` values given to push). */
  startMs: number;
  /** Mean correlation of the pilot cells with their known sequences, -1..1 (best plane). */
  pilotScore: number;
  /** Whether the pilots were detected. */
  present: boolean;
  /** Statement bytes, when the frame decoded and passed its CRC. */
  wire: Uint8Array | null;
  /** Estimated amplitude of the seal per plane, in 8-bit levels. */
  amplitude: number[];
  /** Channel bits that error correction had to fix, when decoded. */
  bitErrors: number;
  /** Soft decisions for every coded bit (positive: 0), for measurements. */
  llr: Float32Array | null;
}

interface Rec {
  t: number;
  means: Float32Array;
}

export interface DemodOptions {
  /** Pilot score needed to declare a seal present. Set from the measured null distribution. */
  threshold: number;
}

export const DEFAULT_DEMOD: DemodOptions = { threshold: 0.3 };

/** Smallest noise level (relative to the seal amplitude) assumed for a plane when weighting soft decisions. */
const SOFT_FLOOR = 0.25;
/** Steps beyond this multiple of the expected size are progressively distrusted. */
const SOFT_CLIP = 1.6;
/** A plane whose measured amplitude is below this many levels is ignored. */
const MIN_AMPLITUDE = 0.06;

export class Demodulator {
  readonly layout: ModemLayout;
  private readonly opts: DemodOptions;
  private frames: Rec[] = [];
  private nextStart: number | null = null;
  private lastSearch = -Infinity;
  private lastEmit = -Infinity;
  private lastDecodedStart = -Infinity;
  /** pilots of each plane as indexes into layout.pilotCells */
  private readonly planePilots: number[][];

  constructor(layout: ModemLayout, opts: DemodOptions = DEFAULT_DEMOD) {
    this.layout = layout;
    this.opts = opts;
    this.planePilots = Array.from({ length: layout.params.planes }, () => []);
    layout.pilotCells.forEach((cell, p) => this.planePilots[Math.floor(cell / layout.planeCells)].push(p));
  }

  get locked(): boolean {
    return this.nextStart !== null;
  }

  /** Adds one received frame: its time in ms (any monotonic timebase) and the cell means of all planes. */
  push(tMs: number, means: Float32Array): void {
    const last = this.frames[this.frames.length - 1];
    if (last && tMs <= last.t) return; // repeated or out-of-order frame
    this.frames.push({ t: tMs, means: means.slice() });
    const horizon = tMs - 3 * PERIOD_MS - 500;
    let drop = 0;
    while (drop < this.frames.length && this.frames[drop].t < horizon) drop++;
    if (drop > 0) this.frames.splice(0, drop);
  }

  /** Returns a result at most once per period: a decode attempt, or a "nothing found" report. */
  poll(): PeriodDecode | null {
    const n = this.frames.length;
    if (n < 4) return null;
    const first = this.frames[0].t;
    const latest = this.frames[n - 1].t;
    const step = this.layout.symMs / 8;
    const margin = 45;

    if (this.nextStart !== null) {
      if (latest < this.nextStart + PERIOD_MS + margin) return null;
      let best = -2;
      let bestStart = this.nextStart;
      for (let k = -2; k <= 2; k++) {
        const start = this.nextStart + k * step;
        const score = this.pilotScore(start);
        // prefer the predicted position unless another is clearly better
        if (score - 0.02 * Math.abs(k) > best) { best = score - 0.02 * Math.abs(k); bestStart = start; }
      }
      const score = this.pilotScore(bestStart);
      this.lastEmit = latest;
      if (score >= this.opts.threshold) {
        this.nextStart = bestStart + PERIOD_MS;
        return this.decode(bestStart, score);
      }
      const lost = this.nextStart;
      this.nextStart = null;
      this.lastDecodedStart = lost;
      return this.absent(lost, score);
    }

    // acquisition
    if (latest - this.lastSearch < this.layout.symMs / 2) return null;
    this.lastSearch = latest;
    const hi = latest - PERIOD_MS - margin;
    const lo = Math.max(first, latest - 2 * PERIOD_MS - margin, this.lastDecodedStart + PERIOD_MS - 2 * step);
    let best = -2;
    let bestStart = 0;
    for (let start = hi; start >= lo; start -= step) {
      const score = this.pilotScore(start);
      if (score > best) { best = score; bestStart = start; }
    }
    // Candidates become available from early to late as frames arrive, so the best one so far can sit
    // just before the true start and still score above the threshold. Lock only once the peak is
    // bracketed, that is, when later candidates exist and score lower.
    const bracketed = bestStart <= hi - 3 * step;
    if (best >= this.opts.threshold && bracketed) {
      let span = step / 2;
      for (let round = 0; round < 3; round++) {
        for (const d of [-span, span]) {
          const score = this.pilotScore(bestStart + d);
          if (score > best) { best = score; bestStart += d; }
        }
        span /= 2;
      }
      this.nextStart = bestStart + PERIOD_MS;
      this.lastEmit = latest;
      return this.decode(bestStart, best);
    }
    if (best < this.opts.threshold && latest - first >= 2 * PERIOD_MS && latest - this.lastEmit >= PERIOD_MS) {
      this.lastEmit = latest;
      return this.absent(latest - PERIOD_MS, Math.max(best, 0));
    }
    return null;
  }

  private absent(startMs: number, pilotScore: number): PeriodDecode {
    return { startMs, pilotScore, present: false, wire: null, amplitude: [], bitErrors: 0, llr: null };
  }

  /** Index range of buffered frames with start <= t < end. */
  private range(start: number, end: number): [number, number] {
    const f = this.frames;
    let lo = 0;
    let hi = f.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (f[mid].t < start) lo = mid + 1; else hi = mid;
    }
    let e = lo;
    while (e < f.length && f[e].t < end) e++;
    return [lo, e];
  }

  /** For each slot, the frames that lie in its settled part (after the cross-fade). */
  private slotFrames(start: number): [number, number][] {
    const { symMs, params } = this.layout;
    const guard = params.fadeMs + 12;
    const out: [number, number][] = [];
    for (let s = 0; s < params.symbols; s++) {
      let r = this.range(start + s * symMs + guard, start + (s + 1) * symMs - 4);
      // at low frame rates the settled part may hold no frame; fall back to the later half of the slot
      if (r[0] === r[1]) r = this.range(start + s * symMs + symMs / 2 - 4, start + (s + 1) * symMs + 4);
      out.push(r);
    }
    return out;
  }

  /** Best per-plane mean correlation between pilot cells and their sequences. */
  private pilotScore(start: number): number {
    const { params, pilotCells, pilotSeq } = this.layout;
    const S = params.symbols;
    const slots = this.slotFrames(start);
    let empty = 0;
    for (const [a, b] of slots) if (a === b) empty++;
    if (empty > S / 4) return -1;
    const m = new Float64Array(S);
    let best = -1;
    for (const list of this.planePilots) {
      let total = 0;
      for (const p of list) {
        const cell = pilotCells[p];
        let mean = 0;
        let used = 0;
        for (let s = 0; s < S; s++) {
          const [a, b] = slots[s];
          if (a === b) { m[s] = NaN; continue; }
          let acc = 0;
          for (let i = a; i < b; i++) acc += this.frames[i].means[cell];
          m[s] = acc / (b - a);
          mean += m[s];
          used++;
        }
        mean /= used;
        let dot = 0;
        let energy = 0;
        for (let s = 0; s < S; s++) {
          if (Number.isNaN(m[s])) continue;
          const d = m[s] - mean;
          dot += d * pilotSeq[p * S + s];
          energy += d * d;
        }
        // the small floor keeps perfectly static synthetic input from dividing by zero
        total += dot / Math.sqrt((energy + 0.0004 * used) * used);
      }
      const score = total / list.length;
      if (score > best) best = score;
    }
    return best;
  }

  private decode(start: number, pilotScore: number): PeriodDecode {
    const layout = this.layout;
    const { params, cells, planeCells, pilotCells, pilotSeq, dataCells, bitsPerCell } = layout;
    const S = params.symbols;
    const slots = this.slotFrames(start);
    const mean = new Float32Array(S * cells);
    const noise = new Float32Array(cells);
    const slotOk = new Uint8Array(S);
    for (let s = 0; s < S; s++) {
      const [a, b] = slots[s];
      if (a === b) continue;
      slotOk[s] = 1;
      const count = b - a;
      for (let c = 0; c < cells; c++) {
        let acc = 0;
        for (let i = a; i < b; i++) acc += this.frames[i].means[c];
        const mu = acc / count;
        mean[s * cells + c] = mu;
        if (count > 1) {
          let v = 0;
          for (let i = a; i < b; i++) {
            const d = this.frames[i].means[c] - mu;
            v += d * d;
          }
          noise[c] += v / (count - 1) / S;
        }
      }
    }
    for (let c = 0; c < cells; c++) noise[c] = Math.sqrt(noise[c]);

    // Per plane: amplitude from pilot pairs whose two slots differ in sign, and the
    // drift between the two halves of each pair. Medians are robust to moving pilots.
    const amplitude: number[] = [];
    const drift = new Float32Array(params.planes * (S / 2));
    for (let pl = 0; pl < params.planes; pl++) {
      const amps: number[] = [];
      for (const p of this.planePilots[pl]) {
        const cell = pilotCells[p];
        for (let b = 0; b < S / 2; b++) {
          const q0 = pilotSeq[p * S + 2 * b];
          const q1 = pilotSeq[p * S + 2 * b + 1];
          if (q0 === q1 || !slotOk[2 * b] || !slotOk[2 * b + 1]) continue;
          amps.push(((mean[2 * b * cells + cell] - mean[(2 * b + 1) * cells + cell]) * q0) / 2);
        }
      }
      amps.sort((x, y) => x - y);
      const amp = amps.length ? amps[amps.length >> 1] : 0;
      amplitude.push(amp);
      for (let b = 0; b < S / 2; b++) {
        const res: number[] = [];
        for (const p of this.planePilots[pl]) {
          const cell = pilotCells[p];
          const expected = amp * (pilotSeq[p * S + 2 * b] - pilotSeq[p * S + 2 * b + 1]);
          res.push(mean[2 * b * cells + cell] - mean[(2 * b + 1) * cells + cell] - expected);
        }
        res.sort((x, y) => x - y);
        drift[pl * (S / 2) + b] = res[res.length >> 1];
      }
    }

    // How well does each plane actually follow the pattern? The pilots are known, so their
    // normalised steps should be exactly -1, 0 or +1. The spread around those values (robust:
    // median absolute deviation) is the plane's real noise level. A plane the encoder has
    // flattened shows a huge spread and its bits get almost no say in the decoding.
    const spread: number[] = [];
    for (let pl = 0; pl < params.planes; pl++) {
      const amp = amplitude[pl];
      if (amp < MIN_AMPLITUDE) { spread.push(Infinity); continue; }
      const dev: number[] = [];
      for (const p of this.planePilots[pl]) {
        const cell = pilotCells[p];
        for (let b = 0; b < S / 2; b++) {
          if (!slotOk[2 * b] || !slotOk[2 * b + 1]) continue;
          const expected = (pilotSeq[p * S + 2 * b] - pilotSeq[p * S + 2 * b + 1]) / 2;
          const z = (mean[2 * b * cells + cell] - mean[(2 * b + 1) * cells + cell] - drift[pl * (S / 2) + b]) / (2 * amp);
          dev.push(Math.abs(z - expected));
        }
      }
      dev.sort((x, y) => x - y);
      spread.push(Math.max(SOFT_FLOOR, dev.length ? 1.4826 * dev[dev.length >> 1] : Infinity));
    }

    const n = layout.fec.codedBits;
    const llr = new Float32Array(n);
    for (let d = 0; d < dataCells.length; d++) {
      const cell = dataCells[d];
      const pl = Math.floor(cell / planeCells);
      const amp = amplitude[pl];
      if (amp < MIN_AMPLITUDE || !Number.isFinite(spread[pl])) continue; // this plane did not survive; its bits stay "unknown"
      const weight = 1 / (spread[pl] * spread[pl] + (noise[cell] / amp) ** 2);
      for (let b = 0; b < bitsPerCell; b++) {
        const i = d * bitsPerCell + b;
        if (i >= n) break;
        if (!slotOk[2 * b] || !slotOk[2 * b + 1]) continue;
        // +1 is a clean "up then down" step, -1 a clean "down then up" step
        let z = (mean[2 * b * cells + cell] - mean[(2 * b + 1) * cells + cell] - drift[pl * (S / 2) + b]) / (2 * amp);
        // a step far larger than the seal can make is picture motion, not signal
        const a = Math.abs(z);
        if (a > SOFT_CLIP) z *= (SOFT_CLIP / a) ** 3;
        llr[i] = (layout.scramble[i] ? -z : z) * weight;
      }
    }
    const res = layout.fec.decode(llr);
    this.lastDecodedStart = start;
    return {
      startMs: start,
      pilotScore,
      present: true,
      wire: res ? res.wire : null,
      amplitude,
      bitErrors: res ? res.bitErrors : 0,
      llr,
    };
  }
}
