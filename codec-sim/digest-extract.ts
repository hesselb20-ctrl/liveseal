// Digest research, stage 1: produce genuine and attack videos, push them
// through real codecs and store the picture features the digest candidates
// work on. Stage 2 (digest-eval.ts) compares the candidates on these files.
//
// Usage: node codec-sim/digest-extract.ts [shard] [shards]
// Output: data/digest/<id>.i16 (features, 1/64 luma steps) and data/digest/index.jsonl

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { prng } from '../core/src/bytes.ts';
import { FACE_SIZE, FrameHistory, SNAPSHOTS, THUMB_H, THUMB_W, makeFaceBox } from '../core/src/features.ts';
import { SealSchedule, makeLayout, makeReducer } from '../core/src/modem.ts';
import { PERIOD_MS } from '../core/src/statement.ts';
import { AttackSource, FACES, FACE_CLIPS, attackName, attacksFor, clipSize, type AttackSpec } from './attacks.ts';
import { FrameSealer } from './channel.ts';
import { PROFILE_STRONG } from './profiles.ts';
import { DATA, RawReader, RawWriter, rawInfo, remove, tmpPath, transcode, type CodecConfig } from './video.ts';

export const DIGEST_DIR = join(DATA, 'digest');
mkdirSync(DIGEST_DIR, { recursive: true });

export const SECONDS = 30;
export const FPS = 30;
export const PERIODS = Math.floor((SECONDS * 1000) / PERIOD_MS) - 1; // period 0 (encoder warm-up) is skipped
export const FLOATS_PER_PERIOD = SNAPSHOTS * (FACE_SIZE * FACE_SIZE + THUMB_W * THUMB_H);

interface Condition {
  name: string;
  codec: CodecConfig;
  /** Factor applied to the frame size before encoding. */
  scale?: number;
  fps?: number;
}

const GENUINE: Condition[] = [
  { name: 'vp8dn-300', codec: { codec: 'vp8', kbps: 300, denoise: true } },
  { name: 'vp8dn-600', codec: { codec: 'vp8', kbps: 600, denoise: true } },
  { name: 'vp8dn-1000', codec: { codec: 'vp8', kbps: 1000, denoise: true } },
  { name: 'vp8-600', codec: { codec: 'vp8', kbps: 600 } },
  { name: 'vp9dn-300', codec: { codec: 'vp9', kbps: 300, denoise: true } },
  { name: 'vp9dn-600', codec: { codec: 'vp9', kbps: 600, denoise: true } },
  { name: 'h264-300', codec: { codec: 'h264', kbps: 300 } },
  { name: 'h264-600', codec: { codec: 'h264', kbps: 600 } },
  { name: 'av1-300', codec: { codec: 'av1', kbps: 300 } },
  { name: 'av1-600', codec: { codec: 'av1', kbps: 600 } },
  { name: 'vp8dn-600-15fps', codec: { codec: 'vp8', kbps: 600, denoise: true }, fps: 15 },
  { name: 'vp8dn-300-half', codec: { codec: 'vp8', kbps: 300, denoise: true }, scale: 0.5 },
];
const ATTACK_CONDITIONS = ['vp8dn-600', 'h264-600', 'vp9dn-300', 'av1-600'];

export interface RunMeta {
  id: string;
  clip: string;
  attack: string;
  condition: string;
  /** Per stored period: whether features could be computed. */
  ok: boolean[];
}

function writeFeatures(path: string, periods: (Float32Array | null)[]): void {
  const out = new Int16Array(periods.length * FLOATS_PER_PERIOD);
  periods.forEach((f, p) => {
    if (!f) return;
    for (let i = 0; i < FLOATS_PER_PERIOD; i++) out[p * FLOATS_PER_PERIOD + i] = Math.round(f[i] * 64);
  });
  writeFileSync(path, Buffer.from(out.buffer));
}

export function readFeatures(path: string): Float32Array {
  const buf = readFileSync(path);
  const i16 = new Int16Array(buf.buffer, buf.byteOffset, buf.byteLength / 2);
  const out = new Float32Array(i16.length);
  for (let i = 0; i < i16.length; i++) out[i] = i16[i] / 64;
  return out;
}

function featuresOf(history: FrameHistory, startMs: number, box: Uint8Array): Float32Array | null {
  const f = history.features(startMs, box);
  if (!f) return null;
  const out = new Float32Array(FLOATS_PER_PERIOD);
  out.set(f.faces, 0);
  out.set(f.thumbs, f.faces.length);
  return out;
}

/** What the sender would sign: features of the original frames. */
function reference(clip: string): void {
  const path = join(DIGEST_DIR, `ref_${clip}.i16`);
  if (existsSync(path)) return;
  const src = new AttackSource(clip, { kind: 'none' });
  const reduce = makeReducer(src.width, src.height);
  const history = new FrameHistory();
  const box = makeFaceBox(...FACES[clip]);
  const frame = new Uint8Array(src.width * src.height * 3 / 2);
  const periods: (Float32Array | null)[] = [];
  for (let k = 0; k < SECONDS * FPS; k++) {
    src.frame(k, frame);
    const t = (k * 1000) / FPS;
    history.push(t, reduce(frame, src.width));
    const p = Math.floor(t / PERIOD_MS);
    // a period is complete once the first frame of the next one has arrived
    if (k > 0 && Math.floor(((k - 1) * 1000) / FPS / PERIOD_MS) !== p && p - 1 >= 1) {
      periods.push(featuresOf(history, (p - 1) * PERIOD_MS, box));
    }
  }
  periods.push(featuresOf(history, (Math.floor((SECONDS * 1000) / PERIOD_MS) - 1) * PERIOD_MS, box));
  src.close();
  writeFeatures(path, periods.slice(0, PERIODS));
}

function run(clip: string, attack: AttackSpec, cond: Condition, id: string): RunMeta {
  const src = new AttackSource(clip, attack);
  const { width, height } = src;
  const total = SECONDS * FPS;
  const frame = new Uint8Array(width * height * 3 / 2);
  const rawPath = tmpPath('yuv');
  const writer = new RawWriter(rawPath);
  // Genuine video carries a live seal, as it would in a call. Attack video is left unsealed: the
  // seal only adds a little noise, so leaving it out makes the attacker's job slightly easier.
  const sealing = attack.kind === 'none';
  const layout = makeLayout();
  const schedule = new SealSchedule(layout);
  const sealer = new FrameSealer(layout, width, height);
  const rand = prng(id.length * 7919 + clip.length);
  const epoch = 1_800_000_000_000;
  for (let k = 0; k < total; k++) {
    src.frame(k, frame);
    if (sealing) {
      const now = epoch + (k * 1000) / FPS;
      const p = Math.floor(now / PERIOD_MS);
      if (!schedule.hasPeriod(p)) schedule.setPeriod(p, Uint8Array.from({ length: layout.fec.capacity }, () => rand() & 0xff));
      sealer.seal(frame, schedule, now, PROFILE_STRONG.amplitude, PROFILE_STRONG.chroma, k);
    }
    writer.write(frame);
  }
  writer.close();
  src.close();

  const even = (v: number) => Math.max(2, Math.round(v / 2) * 2);
  const outW = cond.scale ? even(width * cond.scale) : width;
  const outH = cond.scale ? even(height * cond.scale) : height;
  const outFps = cond.fps ?? FPS;
  const filters = [cond.fps ? `fps=${cond.fps}` : null, cond.scale ? `scale=${outW}:${outH}` : null].filter(Boolean).join(',');
  const { out } = transcode(rawInfo(rawPath, width, height, FPS), { ...cond.codec, preFilter: filters || undefined }, { width: outW, height: outH, fps: outFps });
  remove(rawPath);

  const reader = new RawReader(out);
  const rx = new Uint8Array(outW * outH * 3 / 2);
  const reduce = makeReducer(outW, outH);
  const history = new FrameHistory();
  const box = makeFaceBox(...FACES[clip]);
  const periods: (Float32Array | null)[] = [];
  const frameMs = 1000 / outFps;
  let next = 1;
  for (let k = 0; k < out.frames; k++) {
    reader.read(k, rx);
    const t = k * frameMs;
    history.push(t, reduce(rx, outW));
    // the receiver's idea of the period start is off by up to one frame
    const jitter = ((next % 3) - 1) * 33;
    if (next <= PERIODS && t >= (next + 1) * PERIOD_MS + 40) {
      periods.push(featuresOf(history, next * PERIOD_MS + jitter, box));
      next++;
    }
  }
  while (next <= PERIODS) {
    periods.push(featuresOf(history, next * PERIOD_MS, box));
    next++;
  }
  reader.close();
  remove(out.path);
  writeFeatures(join(DIGEST_DIR, `${id}.i16`), periods);
  return { id, clip, attack: attackName(attack), condition: cond.name, ok: periods.map((p) => p !== null) };
}

export function plan(): { clip: string; attack: AttackSpec; cond: Condition; id: string }[] {
  const rows: { clip: string; attack: AttackSpec; cond: Condition; id: string }[] = [];
  for (const clip of FACE_CLIPS) {
    for (const cond of GENUINE) rows.push({ clip, attack: { kind: 'none' }, cond, id: '' });
    for (const attack of attacksFor(clip)) {
      for (const name of ATTACK_CONDITIONS) rows.push({ clip, attack, cond: GENUINE.find((c) => c.name === name)!, id: '' });
    }
  }
  rows.forEach((r) => { r.id = `${r.clip}__${attackName(r.attack).replace(/[:.]/g, '-')}__${r.cond.name}`; });
  return rows;
}

if (process.argv[1]?.endsWith('digest-extract.ts')) {
  const shard = Number(process.argv[2] ?? 0);
  const shards = Number(process.argv[3] ?? 1);
  const indexPath = join(DIGEST_DIR, 'index.jsonl');
  const done = new Set<string>();
  if (existsSync(indexPath)) {
    for (const line of readFileSync(indexPath, 'utf8').split('\n')) if (line.trim()) done.add(JSON.parse(line).id);
  }
  if (shard === 0) for (const clip of FACE_CLIPS) reference(clip);
  const rows = plan();
  let ran = 0;
  rows.forEach((row, index) => {
    if (index % shards !== shard || done.has(row.id)) return;
    try {
      const meta = run(row.clip, row.attack, row.cond, row.id);
      appendFileSync(indexPath, JSON.stringify(meta) + '\n');
      ran++;
      if (ran % 10 === 0) console.log(`shard ${shard}: ${ran} runs, at ${index + 1}/${rows.length}`);
    } catch (err) {
      console.error(`FAILED ${row.id}: ${(err as Error).message.split('\n')[0]}`);
    }
  });
  console.log(`shard ${shard}/${shards} done: ${ran} runs`);
}
