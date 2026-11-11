import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prng } from '../src/bytes.ts';
import { makeFec } from '../src/frame.ts';
import { ldpcDecode, ldpcEncode, makeLdpc } from '../src/ldpc.ts';
import {
  CellSampler, DEFAULT_MODEM, Demodulator, Embedder, REDUCED_H, REDUCED_W, SealSchedule, makeLayout, makeReducer,
  slotAt, type ModemParams,
} from '../src/modem.ts';
import { RgbaCellSampler, yccToRgbOffset } from '../src/pixels.ts';
import { PERIOD_MS } from '../src/statement.ts';

const rand = prng(2024);
const uniform = () => rand() / 4294967296;
const gauss = () => Math.sqrt(-2 * Math.log(uniform() + 1e-12)) * Math.cos(2 * Math.PI * uniform());

test('ldpc: clean round-trip and correction of noise plus erasures', () => {
  for (const [n, k, q] of [[2016, 1000, 3], [6048, 1152, 4], [300, 100, 3]] as const) {
    const code = makeLdpc(n, k, 7, q);
    for (let trial = 0; trial < 20; trial++) {
      const info = Uint8Array.from({ length: k }, () => rand() & 1);
      const cw = ldpcEncode(code, info);
      assert.equal(cw.length, n);
      assert.deepEqual(cw.slice(0, k), info);
      // every parity check holds for an encoded word
      for (let i = 0; i < code.m; i++) {
        let parity = 0;
        for (let e = code.checkStart[i]; e < code.checkStart[i + 1]; e++) parity ^= cw[code.checkVars[e]];
        assert.equal(parity, 0);
      }
      const llr = new Float32Array(n);
      for (let i = 0; i < n; i++) llr[i] = uniform() < 0.2 ? 0 : ((cw[i] ? -1 : 1) + 0.45 * gauss()) * 8;
      const res = ldpcDecode(code, llr);
      assert.ok(res, `n=${n} trial ${trial} did not decode`);
      assert.deepEqual(res.info, info);
    }
  }
});

test('fec: both codes round-trip, and pure noise never produces a frame', () => {
  for (const [kind, bits, red] of [['rs', 2016, 128], ['ldpc', 2016, 125], ['ldpc', 6048, 144]] as const) {
    const fec = makeFec(kind, bits, red);
    const wire = Uint8Array.from({ length: fec.capacity }, () => rand() & 0xff);
    const coded = fec.encode(wire);
    assert.equal(coded.length, fec.codedBits);
    const llr = Float32Array.from(coded, (b) => (b ? -4 : 4));
    assert.deepEqual(fec.decode(llr)?.wire, wire);
    // a few flipped bits are reported as corrected
    for (let i = 0; i < 20; i++) llr[i * 37] = -llr[i * 37] * 0.2;
    const fixed = fec.decode(llr);
    assert.deepEqual(fixed?.wire, wire);
    assert.equal(fixed?.bitErrors, 20);
    for (let t = 0; t < 60; t++) {
      const noise = Float32Array.from({ length: fec.codedBits }, () => 3 * gauss());
      assert.equal(fec.decode(noise), null, `${kind}: noise decoded`);
    }
    assert.throws(() => fec.encode(new Uint8Array(fec.capacity + 1)));
  }
});

test('layout: every cell has one role, pilots are balanced, sizes add up', () => {
  for (const params of [DEFAULT_MODEM, { ...DEFAULT_MODEM, planes: 1, redundancy: 125 }, { ...DEFAULT_MODEM, symbols: 4 }] as ModemParams[]) {
    const layout = makeLayout(params);
    const seen = new Uint8Array(layout.cells);
    for (const c of layout.pilotCells) seen[c]++;
    for (const c of layout.dataCells) seen[c]++;
    assert.ok(seen.every((v) => v === 1));
    assert.equal(layout.cells, params.planes * params.gridW * params.gridH);
    assert.equal(layout.fec.codedBits, layout.dataCells.length * layout.bitsPerCell);
    for (let p = 0; p < layout.pilotCells.length; p++) {
      let sum = 0;
      for (let s = 0; s < params.symbols; s++) sum += layout.pilotSeq[p * params.symbols + s];
      assert.equal(sum, 0);
    }
  }
  assert.ok(makeLayout().fec.capacity >= 139, 'a statement with a 48-byte digest must fit');
});

test('slot timing: periods, slots and the cross-fade', () => {
  const layout = makeLayout();
  const t0 = 1_800_000_000_000;
  assert.equal(t0 % PERIOD_MS, 0);
  assert.deepEqual(slotAt(layout, t0 + 1), { period: t0 / PERIOD_MS, slot: 0, mix: slotAt(layout, t0 + 1).mix });
  assert.ok(slotAt(layout, t0 + 1).mix < 0.01);
  assert.equal(slotAt(layout, t0 + 100).mix, 1);
  assert.equal(slotAt(layout, t0 + 250).slot, 1);
  assert.equal(slotAt(layout, t0 + 1999.9).slot, 7);
  assert.equal(slotAt(layout, t0 + 2000).period, t0 / PERIOD_MS + 1);
});

test('embedder and sampler agree: a cell reads back the offset it was given', () => {
  const layout = makeLayout();
  const w = 640;
  const h = 360;
  const embed = new Embedder(layout, w, h);
  const field = new Float32Array(layout.cells);
  for (let c = 0; c < layout.cells; c++) field[c] = ((c * 7919) % 5) - 2; // -2..2
  const reduce = makeReducer(w, h);
  const sampler = new CellSampler(layout);
  for (const plane of [0, 1, 2]) {
    const img = new Uint8Array(w * h).fill(120);
    for (let f = 0; f < 4; f++) embed.apply(img, w, field, plane, f); // four frames stacked: offsets add up
    const means = sampler.sample(reduce(img, w), new Float32Array(layout.planeCells));
    for (let c = 0; c < layout.planeCells; c++) {
      assert.ok(Math.abs(means[c] - 120 - 4 * field[plane * layout.planeCells + c]) < 0.25, `plane ${plane} cell ${c}`);
    }
  }
  assert.ok(Math.abs(embed.valueAt(field, 0, 10, 10) - field[0]) < 1e-6);
});

test('reducer: area averaging is exact for integer and fractional ratios', () => {
  for (const [w, h] of [[640, 360], [1280, 720], [352, 288], [320, 180], [160, 90], [1920, 1080]]) {
    const img = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) img[y * w + x] = x < w / 2 ? 40 : 200;
    const out = makeReducer(w, h)(img, w);
    assert.equal(out.length, REDUCED_W * REDUCED_H);
    assert.ok(Math.abs(out[0] - 40) < 1e-3 && Math.abs(out[REDUCED_W - 1] - 200) < 1e-3);
    let sum = 0;
    for (const v of out) sum += v;
    assert.ok(Math.abs(sum / out.length - 120) < 0.5);
  }
});

test('rgb conversion: offsets land in the intended plane only', () => {
  const layout = makeLayout();
  const sampler = new RgbaCellSampler(layout);
  const make = (dy: number, dcb: number, dcr: number) => {
    const [dr, dg, db] = yccToRgbOffset(dy, dcb, dcr);
    const rgba = new Uint8ClampedArray(REDUCED_W * REDUCED_H * 4);
    for (let i = 0; i < rgba.length; i += 4) {
      rgba[i] = 100 + dr; rgba[i + 1] = 110 + dg; rgba[i + 2] = 120 + db; rgba[i + 3] = 255;
    }
    return sampler.sample(rgba).slice();
  };
  const base = make(0, 0, 0);
  const pc = layout.planeCells;
  for (const [dy, dcb, dcr] of [[10, 0, 0], [0, 10, 0], [0, 0, 10]]) {
    const m = make(dy, dcb, dcr);
    assert.ok(Math.abs(m[0] - base[0] - dy) < 0.8);
    assert.ok(Math.abs(m[pc] - base[pc] - dcb) < 0.8);
    assert.ok(Math.abs(m[2 * pc] - base[2 * pc] - dcr) < 0.8);
  }
});

// ---- end-to-end on synthetic video (no codec): the real schedule, embedder, sampler and demodulator

interface Scene {
  w: number;
  h: number;
  base: Uint8Array[]; // three planes
}

function makeScene(w: number, h: number): Scene {
  const planes = [[w, h], [w >> 1, h >> 1], [w >> 1, h >> 1]].map(([pw, ph], idx) => {
    const img = new Uint8Array(pw * ph);
    const waves = Array.from({ length: 6 }, () => [uniform() * 0.05, uniform() * 0.05, uniform() * 6.28, 6 + uniform() * 14]);
    for (let y = 0; y < ph; y++) {
      for (let x = 0; x < pw; x++) {
        let v = idx === 0 ? 110 : 128;
        for (const [fx, fy, ph0, amp] of waves) v += (idx === 0 ? amp : amp * 0.3) * Math.sin(x * fx + y * fy + ph0);
        img[y * pw + x] = Math.max(0, Math.min(255, Math.round(v)));
      }
    }
    return img;
  });
  return { w, h, base: planes };
}

interface RunOptions {
  amplitude: number[];
  seconds: number;
  fps: number;
  dropRate?: number;
  /** A square of this fraction of the frame width is filled with fresh noise every frame. */
  motion?: number;
  noise?: number;
}

function runSynthetic(params: ModemParams, opts: RunOptions) {
  const layout = makeLayout(params);
  const scene = makeScene(640, 360);
  const schedule = new SealSchedule(layout);
  const embedY = new Embedder(layout, 640, 360);
  const embedC = new Embedder(layout, 320, 180);
  const reduceY = makeReducer(640, 360);
  const reduceC = makeReducer(320, 180);
  const sampler = new CellSampler(layout);
  const demod = new Demodulator(layout);
  const t0 = 1_800_000_000_000 + 613;
  const offset = 987_654.25;
  const sent = new Map<number, Uint8Array>();
  const decoded: { period: number; wire: Uint8Array | null }[] = [];
  let present = 0;
  const field = new Float32Array(layout.cells);
  const means = new Float32Array(layout.cells);
  const frames = Math.round(opts.seconds * opts.fps);
  const noise = opts.noise ?? 1.2;
  for (let k = 0; k < frames; k++) {
    const now = t0 + (k * 1000) / opts.fps;
    const period = Math.floor(now / PERIOD_MS);
    if (!schedule.hasPeriod(period) && opts.amplitude.some((a) => a > 0)) {
      const wire = Uint8Array.from({ length: 100 }, () => rand() & 0xff);
      sent.set(period, wire);
      schedule.setPeriod(period, wire);
    }
    schedule.field(now, opts.amplitude, field);
    const planes = scene.base.map((b) => b.slice());
    for (let pl = 0; pl < 3; pl++) {
      const img = planes[pl];
      const pw = pl === 0 ? 640 : 320;
      const ph = pl === 0 ? 360 : 180;
      for (let i = 0; i < img.length; i++) img[i] = Math.max(0, Math.min(255, Math.round(img[i] + noise * gauss())));
      if (opts.motion) {
        const size = Math.round(pw * opts.motion);
        for (let y = ph >> 2; y < Math.min(ph, (ph >> 2) + size); y++) {
          for (let x = pw >> 2; x < (pw >> 2) + size; x++) img[y * pw + x] = rand() & 0xff;
        }
      }
      if (pl < params.planes && opts.amplitude[pl] > 0) (pl === 0 ? embedY : embedC).apply(img, pw, field, pl, k);
    }
    if (opts.dropRate && uniform() < opts.dropRate) continue;
    sampler.sample(reduceY(planes[0], 640), means, 0);
    if (params.planes === 3) {
      sampler.sample(reduceC(planes[1], 320), means, layout.planeCells);
      sampler.sample(reduceC(planes[2], 320), means, 2 * layout.planeCells);
    }
    demod.push(now - t0 + offset, means);
    const res = demod.poll();
    if (!res) continue;
    if (res.present) {
      present++;
      decoded.push({ period: Math.round((res.startMs - offset + t0) / PERIOD_MS), wire: res.wire });
    }
  }
  return { sent, decoded, present };
}

function assertAllRecovered(run: ReturnType<typeof runSynthetic>, minimum: number): void {
  assert.ok(run.decoded.length >= minimum, `only ${run.decoded.length} periods detected`);
  for (const d of run.decoded) {
    assert.ok(d.wire, `period ${d.period} was detected but not decoded`);
    assert.deepEqual(d.wire, run.sent.get(d.period), `period ${d.period} decoded to the wrong statement`);
  }
  const periods = run.decoded.map((d) => d.period);
  assert.deepEqual(periods, [...new Set(periods)].sort((a, b) => a - b), 'each period is reported once, in order');
}

test('end to end, synthetic: every complete period is recovered (three planes)', () => {
  assertAllRecovered(runSynthetic(DEFAULT_MODEM, { amplitude: [1.5, 2, 2], seconds: 9, fps: 30 }), 3);
});

test('end to end, synthetic: luma-only modem, 15 fps, 20% dropped frames', () => {
  const luma: ModemParams = { ...DEFAULT_MODEM, planes: 1, redundancy: 125 };
  assertAllRecovered(runSynthetic(luma, { amplitude: [2, 0, 0], seconds: 9, fps: 30 }), 3);
  assertAllRecovered(runSynthetic(DEFAULT_MODEM, { amplitude: [1.5, 2, 2], seconds: 9, fps: 15 }), 3);
  assertAllRecovered(runSynthetic(DEFAULT_MODEM, { amplitude: [1.5, 2, 2], seconds: 9, fps: 30, dropRate: 0.2 }), 3);
});

test('end to end, synthetic: a quarter of the frame in violent motion is tolerated', () => {
  assertAllRecovered(runSynthetic(DEFAULT_MODEM, { amplitude: [1.5, 2, 2], seconds: 9, fps: 30, motion: 0.5 }), 3);
});

test('end to end, synthetic: one surviving plane is enough', () => {
  assertAllRecovered(runSynthetic(DEFAULT_MODEM, { amplitude: [0, 2, 0], seconds: 9, fps: 30 }), 3);
});

test('end to end, synthetic: unsealed video is never reported as sealed', () => {
  const quiet = runSynthetic(DEFAULT_MODEM, { amplitude: [0, 0, 0], seconds: 12, fps: 30 });
  assert.equal(quiet.present, 0);
  const busy = runSynthetic(DEFAULT_MODEM, { amplitude: [0, 0, 0], seconds: 12, fps: 30, motion: 0.5, noise: 4 });
  assert.equal(busy.present, 0);
});
