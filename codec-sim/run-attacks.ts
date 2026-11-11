// The attack suite: every threat from docs/THREAT_MODEL.md, end to end.
//
// For each victim clip a genuine sender (real key, real statements, real
// digest) seals its camera. The attacker then does one of the things below,
// the result goes through a real codec, and the real receiver session judges
// it. One JSON row per run goes to data/results/attacks.jsonl.
//
//   genuine        nothing: the baseline that must reach and keep green
//   T1 strip       sends a fake picture with no seal
//   T2 replay      plays the sealed call back later / under another challenge
//   T3 relay       lifts the live seal perfectly onto other pictures
//   T4 process     re-encodes, scales, crops or brightens the genuine call
//   T5 impostor    seals correctly with a key the victim never verified
//   T6 revoked     seals with a key the owner has revoked
//   T7 downgrade   sends no seal while claiming to be a contact who seals
//
// Usage: node codec-sim/run-attacks.ts [shard] [shards]

import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createSigner, softwareSigner, sha256, type Signer } from '../core/src/crypto.ts';
import { utf8 } from '../core/src/bytes.ts';
import { KeyDirectory, createRevocation } from '../core/src/directory.ts';
import { makeReducer } from '../core/src/modem.ts';
import { ReceiverSession, SenderSession } from '../core/src/session.ts';
import { AttackSource, FACES, FACE_CLIPS, attackName, clipSize, type AttackSpec } from './attacks.ts';
import { FrameSampler, FrameSealer } from './channel.ts';
import { RESULTS, RawReader, RawWriter, rawInfo, remove, tmpPath, transcode, type CodecConfig } from './video.ts';

const SECONDS = 30;
const FPS = 30;

interface Case {
  threat: string;
  label: string;
  /** What the receiver is shown. */
  picture: AttackSpec;
  /** Whether the genuine seal is on the picture. */
  sealed: boolean;
  /** Group for reporting: 'must' attacks may never be green; 'limit' are edits below the digest's resolution. */
  group: 'genuine' | 'must' | 'limit' | 'process';
  clockOffsetMs?: number;
  /** [challenge the receiver set, challenge the sender answers]; 0 means none. */
  challenge?: [number, number];
  impostor?: boolean;
  revoked?: boolean;
  expected?: boolean;
  preFilter?: string;
  stages?: CodecConfig[];
}

function cases(clip: string): Case[] {
  const others = FACE_CLIPS.filter((c) => c !== clip);
  const i = FACE_CLIPS.indexOf(clip);
  const pick = (n: number) => others[(i * 3 + n * 5) % others.length];
  const none: AttackSpec = { kind: 'none' };
  const { width, height } = clipSize(clip);
  return [
    { threat: 'genuine', label: 'genuine call', picture: none, sealed: true, group: 'genuine' },
    { threat: 'T1', label: 'another person, no seal', picture: { kind: 'other', clip: pick(0) }, sealed: false, group: 'must' },
    { threat: 'T1', label: 'swapped face, no seal', picture: { kind: 'swap', donor: pick(1) }, sealed: false, group: 'must' },
    { threat: 'T2', label: 'recording played one hour later', picture: none, sealed: true, group: 'must', clockOffsetMs: 3_600_000 },
    { threat: 'T2', label: 'recording from a call with another challenge', picture: none, sealed: true, group: 'must', challenge: [77, 78] },
    { threat: 'T2', label: 'unchallenged recording against a fresh challenge', picture: none, sealed: true, group: 'must', challenge: [77, 0] },
    { threat: 'T3', label: 'seal lifted onto a swapped face (a)', picture: { kind: 'swap', donor: pick(0) }, sealed: true, group: 'must' },
    { threat: 'T3', label: 'seal lifted onto a swapped face (b)', picture: { kind: 'swap', donor: pick(1) }, sealed: true, group: 'must' },
    { threat: 'T3', label: 'seal lifted onto a swapped face (c)', picture: { kind: 'swap', donor: pick(2) }, sealed: true, group: 'must' },
    { threat: 'T3', label: 'seal lifted onto another person (a)', picture: { kind: 'other', clip: pick(3) }, sealed: true, group: 'must' },
    { threat: 'T3', label: 'seal lifted onto another person (b)', picture: { kind: 'other', clip: pick(4) }, sealed: true, group: 'must' },
    { threat: 'T3', label: 'seal lifted, challenge relayed, swapped face', picture: { kind: 'swap', donor: pick(3) }, sealed: true, group: 'must', challenge: [77, 77] },
    { threat: 'T3', label: 'seal lifted onto a face bent by 12%', picture: { kind: 'warp', strength: 0.12 }, sealed: true, group: 'must' },
    { threat: 'T3-limit', label: 'face bent by 6%', picture: { kind: 'warp', strength: 0.06 }, sealed: true, group: 'limit' },
    { threat: 'T3-limit', label: 'face bent by 3%', picture: { kind: 'warp', strength: 0.03 }, sealed: true, group: 'limit' },
    { threat: 'T3-limit', label: 'mouth replaced (0.7 s offset)', picture: { kind: 'mouth', delay: 20 }, sealed: true, group: 'limit' },
    { threat: 'T3-limit', label: 'mouth replaced (0.3 s offset)', picture: { kind: 'mouth', delay: 8 }, sealed: true, group: 'limit' },
    { threat: 'T3-limit', label: 'picture frozen every period', picture: { kind: 'still' }, sealed: true, group: 'limit' },
    { threat: 'T3-limit', label: 'picture delayed by 0.5 s', picture: { kind: 'shift', delay: 15 }, sealed: true, group: 'limit' },
    { threat: 'T3-limit', label: 'picture delayed by 2 s', picture: { kind: 'shift', delay: 60 }, sealed: true, group: 'limit' },
    { threat: 'T4', label: 're-encoded once more (H.264 600 kbps)', picture: none, sealed: true, group: 'process', stages: [{ codec: 'h264', kbps: 600 }] },
    { threat: 'T4', label: 'sent at half size', picture: none, sealed: true, group: 'process', preFilter: `scale=${width / 2}:${height / 2}` },
    { threat: 'T4', label: 'cropped by 4%', picture: none, sealed: true, group: 'process', preFilter: `crop=iw*0.96:ih*0.96,scale=${width}:${height}` },
    { threat: 'T4', label: 'brightened', picture: none, sealed: true, group: 'process', preFilter: 'eq=brightness=0.07:contrast=1.15' },
    { threat: 'T5', label: 'sealed with an unverified key', picture: { kind: 'other', clip: pick(2) }, sealed: true, group: 'must', impostor: true },
    { threat: 'T6', label: 'sealed with a revoked key', picture: none, sealed: true, group: 'must', revoked: true },
    { threat: 'T7', label: 'no seal, claims to be a contact who seals', picture: { kind: 'swap', donor: pick(4) }, sealed: false, group: 'must', expected: true },
  ];
}

const CODECS: [string, CodecConfig][] = [
  ['vp8dn-600', { codec: 'vp8', kbps: 600, denoise: true }],
  ['h264-600', { codec: 'h264', kbps: 600 }],
  ['vp9dn-300', { codec: 'vp9', kbps: 300, denoise: true }],
  ['av1-600', { codec: 'av1', kbps: 600 }],
];

async function keyFor(name: string): Promise<Signer> {
  return softwareSigner(await sha256(utf8('LiveSeal attack suite key ' + name)));
}

interface Result {
  key: string;
  clip: string;
  codec: string;
  threat: string;
  label: string;
  group: string;
  periods: number;
  green: number;
  amber: number;
  red: number;
  strong: number;
  codes: Record<string, number>;
  /** Badge level per period: g, a or r. */
  levels: string;
}

async function run(clip: string, c: Case, codecName: string, codec: CodecConfig, key: string): Promise<Result> {
  const { width, height } = clipSize(clip);
  const genuineSigner = await keyFor(clip);
  const signer = c.impostor ? await keyFor('impostor of ' + clip) : genuineSigner;
  const directory = new KeyDirectory();
  await directory.addContact('Victim contact', genuineSigner.publicKey, 1);
  if (c.revoked) await directory.importRevocation(await createRevocation(genuineSigner), 2);
  if (c.expected) { directory.recordCall('Victim contact', true); directory.recordCall('Victim contact', true); }

  const sender = new SenderSession({ signer });
  sender.setFace(...FACES[clip]);
  if (c.challenge && c.challenge[1]) sender.answerChallenge(Uint8Array.of(c.challenge[1], 1, 2));
  const genuine = new AttackSource(clip, { kind: 'none' });
  const shown = c.picture.kind === 'none' ? null : new AttackSource(clip, c.picture);
  const reduce = makeReducer(width, height);
  const sealer = new FrameSealer(sender.layout, width, height);
  const field = new Float32Array(sender.layout.cells);
  const frame = new Uint8Array(width * height * 3 / 2);
  const out = new Uint8Array(frame.length);
  const rawPath = tmpPath('yuv');
  const writer = new RawWriter(rawPath);
  const epoch = 1_800_000_000_000 + 260;
  const total = SECONDS * FPS;
  for (let k = 0; k < total; k++) {
    const now = epoch + (k * 1000) / FPS;
    genuine.frame(k, frame);
    // the genuine device seals its own camera picture...
    sender.pushFrame(now, reduce(frame, width));
    await sender.whenIdle();
    sender.field(now, field);
    // ...and the attacker shows something else, with or without that seal on top
    if (shown) shown.frame(k, out);
    else out.set(frame);
    if (c.sealed) sealer.applyField(out, field, k);
    writer.write(out);
  }
  writer.close();
  genuine.close();
  shown?.close();

  const even = (v: number) => Math.max(2, Math.round(v / 2) * 2);
  const half = c.preFilter?.startsWith('scale=');
  const outSize = half ? { width: even(width / 2), height: even(height / 2) } : undefined;
  let decoded = transcode(rawInfo(rawPath, width, height, FPS), { ...codec, preFilter: c.preFilter }, outSize).out;
  remove(rawPath);
  for (const stage of c.stages ?? []) {
    const next = transcode(decoded, stage, { width: decoded.width, height: decoded.height }).out;
    remove(decoded.path);
    decoded = next;
  }

  const receiver = new ReceiverSession({ directory });
  if (c.challenge) receiver.checker.setChallenge(Uint8Array.of(c.challenge[0], 1, 2));
  if (c.expected) receiver.setContext({ expectedName: 'Victim contact', expectedUsuallySeals: directory.usuallySeals('Victim contact') });
  const sampler = new FrameSampler(receiver.layout, decoded.width, decoded.height);
  const reader = new RawReader(decoded);
  const rx = new Uint8Array(decoded.width * decoded.height * 3 / 2);
  const result: Result = { key, clip, codec: codecName, threat: c.threat, label: c.label, group: c.group, periods: 0, green: 0, amber: 0, red: 0, strong: 0, codes: {}, levels: '' };
  for (let k = 0; k < decoded.frames; k++) {
    reader.read(k, rx);
    const t = (k * 1000) / FPS;
    const means = sampler.sample(rx);
    const report = await receiver.pushFrame(9000 + t, means, sampler.reducedLuma, epoch + t + 150 + (c.clockOffsetMs ?? 0));
    if (!report) continue;
    result.periods++;
    result[report.badge.level]++;
    if (report.badge.strong) result.strong++;
    result.levels += report.badge.level[0];
    const code = report.outcome.code === 'valid' && !report.outcome.checked ? 'valid-unchecked' : report.outcome.code;
    result.codes[code] = (result.codes[code] ?? 0) + 1;
  }
  reader.close();
  remove(decoded.path);
  return result;
}

const shard = Number(process.argv[2] ?? 0);
const shards = Number(process.argv[3] ?? 1);
const file = join(RESULTS, 'attacks.jsonl');
const done = new Set<string>();
if (existsSync(file)) {
  for (const line of readFileSync(file, 'utf8').split('\n')) if (line.trim()) done.add(JSON.parse(line).key);
}
await createSigner(); // warm up WebCrypto
let index = 0;
let ran = 0;
for (const clip of FACE_CLIPS) {
  for (const c of cases(clip)) {
    for (const [codecName, codec] of CODECS) {
      if ((c.group === 'limit' || c.group === 'process') && codecName !== 'vp8dn-600' && codecName !== 'h264-600') continue;
      const key = `${clip}|${c.threat}|${c.label}|${attackName(c.picture)}|${codecName}`;
      const mine = index++ % shards === shard;
      if (!mine || done.has(key)) continue;
      try {
        const r = await run(clip, c, codecName, codec, key);
        appendFileSync(file, JSON.stringify(r) + '\n');
        ran++;
        if (r.group === 'must' && r.green > 0) console.log(`FALSE GREEN ${key}: ${r.levels}`);
        if (ran % 10 === 0) console.log(`shard ${shard}: ${ran} runs`);
      } catch (err) {
        console.error(`FAILED ${key}: ${(err as Error).message.split('\n')[0]}`);
      }
    }
  }
}
console.log(`shard ${shard}/${shards} done: ${ran} runs`);
