// Digest research, stage 2: compare the candidate hashes on the stored
// features. For every candidate it measures how far genuine video drifts from
// what the sender signed after each codec, how far each attack lands, and what
// that means for the two verdict thresholds.
//
// Usage: node codec-sim/digest-eval.ts [detail=<candidate>]
// Output: a table on stdout and data/results/digest-eval.json

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FACE_SIZE, SNAPSHOTS, THUMB_H, THUMB_W } from '../core/src/features.ts';
import { HASH_KINDS, patchFeatures, thumbFeatures, type HashKind } from '../core/src/hashes.ts';
import { DIGEST_DIR, FLOATS_PER_PERIOD, PERIODS, readFeatures, type RunMeta } from './digest-extract.ts';
import { RESULTS } from './video.ts';

const FACE_FLOATS = FACE_SIZE * FACE_SIZE;
const THUMB_FLOATS = THUMB_W * THUMB_H;
const MAX_BITS = 64;
const BIT_OPTIONS = [32, 48, 64];
const SNAP_OPTIONS: Record<number, number[]> = { 8: [0, 1, 2, 3, 4, 5, 6, 7], 4: [0, 2, 4, 6], 2: [1, 5] };

interface Candidate {
  key: string;
  kind: HashKind | 'thumb';
  bits: number;
  snaps: number;
  weighted: boolean;
}

function candidates(): Candidate[] {
  const out: Candidate[] = [];
  for (const kind of HASH_KINDS) {
    for (const bits of BIT_OPTIONS) {
      for (const snaps of [2, 4, 8]) {
        for (const weighted of [false, true]) {
          out.push({ key: `${kind}-${bits}x${snaps}${weighted ? 'w' : ''}`, kind, bits, snaps, weighted });
        }
      }
    }
  }
  for (const snaps of [2, 4]) out.push({ key: `thumb-32x${snaps}w`, kind: 'thumb', bits: 32, snaps, weighted: true });
  return out;
}

/** All features of one period: per kind and bit option, SNAPSHOTS feature vectors. */
type PeriodFeat = Map<string, Float32Array[]>;

function featuresOfPeriod(data: Float32Array, period: number): PeriodFeat {
  const base = period * FLOATS_PER_PERIOD;
  const out: PeriodFeat = new Map();
  for (const kind of HASH_KINDS) {
    for (const bits of BIT_OPTIONS) {
      // dct and projection features are prefixes of the 64-bit version; gradient and block depend on the grid
      const prefix = kind === 'dct' || kind === 'projection';
      if (prefix && bits !== MAX_BITS) continue;
      const list: Float32Array[] = [];
      for (let s = 0; s < SNAPSHOTS; s++) {
        const crop = data.subarray(base + s * FACE_FLOATS, base + (s + 1) * FACE_FLOATS);
        list.push(patchFeatures(kind, crop, FACE_SIZE, bits));
      }
      out.set(`${kind}/${bits}`, list);
    }
  }
  const thumbs: Float32Array[] = [];
  for (let s = 0; s < SNAPSHOTS; s++) {
    const off = base + SNAPSHOTS * FACE_FLOATS + s * THUMB_FLOATS;
    thumbs.push(thumbFeatures(data.subarray(off, off + THUMB_FLOATS), THUMB_W, THUMB_H, 32));
  }
  out.set('thumb/32', thumbs);
  return out;
}

function featList(f: PeriodFeat, c: Candidate): Float32Array[] {
  if (c.kind === 'thumb') return f.get('thumb/32')!;
  const prefix = c.kind === 'dct' || c.kind === 'projection';
  return f.get(`${c.kind}/${prefix ? MAX_BITS : c.bits}`)!;
}

/** Mean over the used snapshots of the (optionally weighted) fraction of disagreeing bits. */
function distance(c: Candidate, sender: PeriodFeat, receiver: PeriodFeat): number {
  const a = featList(sender, c);
  const b = featList(receiver, c);
  let total = 0;
  let used = 0;
  for (const s of SNAP_OPTIONS[c.snaps]) {
    const fa = a[s];
    const fb = b[s];
    let rms = 0;
    for (let i = 0; i < c.bits; i++) rms += fb[i] * fb[i];
    rms = Math.sqrt(rms / c.bits) + 1e-9;
    let num = 0;
    let den = 0;
    for (let i = 0; i < c.bits; i++) {
      const w = c.weighted ? Math.min(1, Math.abs(fb[i]) / (0.5 * rms)) : 1;
      den += w;
      if ((fa[i] > 0) !== (fb[i] > 0)) num += w;
    }
    total += den > 0 ? num / den : 0.5;
    used++;
  }
  return total / used;
}

function classOf(attack: string): string {
  if (attack === 'genuine' || attack === 'still') return attack;
  const [kind, arg] = attack.split(':');
  return kind === 'swap' || kind === 'other' ? kind : `${kind}:${arg}`;
}

interface Sample {
  clip: string;
  cls: string;
  condition: string;
  d: Float32Array; // one distance per candidate
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return NaN;
  const pos = Math.min(sorted.length - 1, Math.max(0, q * (sorted.length - 1)));
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function auc(neg: number[], pos: number[]): number {
  // probability that a random attack distance exceeds a random genuine distance
  const all = neg.map((v) => [v, 0]).concat(pos.map((v) => [v, 1])).sort((x, y) => x[0] - y[0]);
  let rankSum = 0;
  for (let i = 0; i < all.length; i++) if (all[i][1] === 1) rankSum += i + 1;
  return (rankSum - (pos.length * (pos.length + 1)) / 2) / (neg.length * pos.length);
}

const indexPath = join(DIGEST_DIR, 'index.jsonl');
if (!existsSync(indexPath)) throw new Error('run codec-sim/digest-extract.ts first');
const metas: RunMeta[] = readFileSync(indexPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const cands = candidates();
const refCache = new Map<string, PeriodFeat[]>();
function refOf(clip: string): PeriodFeat[] {
  let r = refCache.get(clip);
  if (!r) {
    const data = readFeatures(join(DIGEST_DIR, `ref_${clip}.i16`));
    r = Array.from({ length: PERIODS }, (_, p) => featuresOfPeriod(data, p));
    refCache.set(clip, r);
  }
  return r;
}

const samples: Sample[] = [];
let skipped = 0;
for (const meta of metas) {
  const data = readFeatures(join(DIGEST_DIR, `${meta.id}.i16`));
  const ref = refOf(meta.clip);
  for (let p = 0; p < PERIODS; p++) {
    if (!meta.ok[p]) { skipped++; continue; }
    const f = featuresOfPeriod(data, p);
    const d = new Float32Array(cands.length);
    cands.forEach((c, i) => { d[i] = distance(c, ref[p], f); });
    samples.push({ clip: meta.clip, cls: classOf(meta.attack), condition: meta.condition, d });
  }
}

const classes = [...new Set(samples.map((s) => s.cls))].filter((c) => c !== 'genuine').sort();
const conditions = [...new Set(samples.filter((s) => s.cls === 'genuine').map((s) => s.condition))];
console.log(`runs ${metas.length}, periods ${samples.length} (${samples.filter((s) => s.cls === 'genuine').length} genuine, ${samples.filter((s) => s.cls !== 'genuine').length} attack), skipped ${skipped}`);

/** Attack classes that replace the person or the scene: the digest must never match these. */
const MUST_REJECT = ['swap', 'other'];

interface Row {
  key: string;
  bytes: number;
  genuine: { p50: number; p95: number; p99: number; max: number };
  perCondition: Record<string, { p95: number; max: number }>;
  attacks: Record<string, { min: number; p05: number; p50: number; auc: number; n: number }>;
  /** Largest threshold below every must-reject attack sample (with a 10% margin). */
  matchThreshold: number;
  /** Genuine periods that would not reach "match" at that threshold. */
  genuineNotMatched: number;
  /** Smallest threshold above every genuine sample (with a 10% margin). */
  mismatchThreshold: number;
  /** Per class: share of attack periods at or above the mismatch threshold (red), and below the match threshold (false match). */
  red: Record<string, number>;
  falseMatch: Record<string, number>;
}

const rows: Row[] = [];
cands.forEach((c, i) => {
  const gen = samples.filter((s) => s.cls === 'genuine').map((s) => s.d[i]).sort((a, b) => a - b);
  const perCondition: Row['perCondition'] = {};
  for (const cond of conditions) {
    const v = samples.filter((s) => s.cls === 'genuine' && s.condition === cond).map((s) => s.d[i]).sort((a, b) => a - b);
    perCondition[cond] = { p95: quantile(v, 0.95), max: v[v.length - 1] };
  }
  const attacks: Row['attacks'] = {};
  const byClass = new Map<string, number[]>();
  for (const cls of classes) {
    const v = samples.filter((s) => s.cls === cls).map((s) => s.d[i]).sort((a, b) => a - b);
    byClass.set(cls, v);
    attacks[cls] = { min: v[0], p05: quantile(v, 0.05), p50: quantile(v, 0.5), auc: auc(gen, v), n: v.length };
  }
  const must = MUST_REJECT.flatMap((cls) => byClass.get(cls) ?? []);
  const matchThreshold = Math.min(...must) * 0.9;
  const mismatchThreshold = Math.max(gen[gen.length - 1] * 1.1, matchThreshold);
  const red: Row['red'] = {};
  const falseMatch: Row['falseMatch'] = {};
  for (const cls of classes) {
    const v = byClass.get(cls)!;
    red[cls] = v.filter((x) => x >= mismatchThreshold).length / v.length;
    falseMatch[cls] = v.filter((x) => x <= matchThreshold).length / v.length;
  }
  rows.push({
    key: c.key,
    bytes: c.kind === 'thumb' ? (c.bits * c.snaps) / 8 : (c.bits * c.snaps) / 8,
    genuine: { p50: quantile(gen, 0.5), p95: quantile(gen, 0.95), p99: quantile(gen, 0.99), max: gen[gen.length - 1] },
    perCondition,
    attacks,
    matchThreshold,
    genuineNotMatched: gen.filter((x) => x > matchThreshold).length / gen.length,
    mismatchThreshold,
    red,
    falseMatch,
  });
});

const f3 = (v: number) => v.toFixed(3);
const pct = (v: number) => `${(100 * v).toFixed(1)}%`;
console.log('\ncandidate            bytes  genuine p50/p99/max     swap min/p05   T-match  genuine-not-matched  T-mismatch  red: ' + classes.join(' '));
for (const r of rows.slice().sort((a, b) => a.genuineNotMatched - b.genuineNotMatched || a.bytes - b.bytes)) {
  console.log(
    r.key.padEnd(20), String(r.bytes).padStart(4), ' ',
    `${f3(r.genuine.p50)}/${f3(r.genuine.p99)}/${f3(r.genuine.max)}`.padEnd(22),
    `${f3(r.attacks.swap.min)}/${f3(r.attacks.swap.p05)}`.padEnd(14),
    f3(r.matchThreshold).padEnd(8), pct(r.genuineNotMatched).padStart(8).padEnd(20), f3(r.mismatchThreshold).padEnd(11),
    classes.map((cls) => pct(r.red[cls]).padStart(6)).join(' '),
  );
}

const detail = process.argv.find((a) => a.startsWith('detail='))?.slice(7);
if (detail) {
  const r = rows.find((x) => x.key === detail);
  if (!r) throw new Error('unknown candidate ' + detail);
  console.log(`\n== ${r.key}: genuine distance by condition (p95 / max)`);
  for (const [cond, v] of Object.entries(r.perCondition)) console.log(`  ${cond.padEnd(18)} ${f3(v.p95)} / ${f3(v.max)}`);
  console.log('== attacks: n, min / p05 / median, AUC, red share, false-match share');
  for (const cls of classes) {
    const a = r.attacks[cls];
    console.log(`  ${cls.padEnd(12)} n=${String(a.n).padEnd(5)} ${f3(a.min)} / ${f3(a.p05)} / ${f3(a.p50)}  auc ${a.auc.toFixed(4)}  red ${pct(r.red[cls])}  false-match ${pct(r.falseMatch[cls])}`);
  }
  // ROC points for the swap class
  const i = cands.findIndex((c) => c.key === detail);
  const gen = samples.filter((s) => s.cls === 'genuine').map((s) => s.d[i]);
  const swap = samples.filter((s) => s.cls === 'swap').map((s) => s.d[i]);
  console.log('== ROC, genuine vs swap: threshold, genuine rejected, swap accepted');
  for (let t = 0.02; t <= 0.5; t += 0.02) {
    console.log(`  ${t.toFixed(2)}  ${pct(gen.filter((x) => x > t).length / gen.length).padStart(7)}  ${pct(swap.filter((x) => x <= t).length / swap.length).padStart(7)}`);
  }
}

writeFileSync(join(RESULTS, 'digest-eval.json'), JSON.stringify({
  runs: metas.length,
  periods: samples.length,
  genuinePeriods: samples.filter((s) => s.cls === 'genuine').length,
  attackPeriods: samples.filter((s) => s.cls !== 'genuine').length,
  classes,
  conditions,
  rows,
}, null, 1));
