// Channel measurement suites. Each run is one row of JSON appended to
// data/results/channel-<suite>.jsonl, so a sweep can be split over several
// processes and resumed. docs/EVALUATION.md is generated from these files.
//
// Usage: node codec-sim/run-channel.ts <suite> [shard] [shards]
// Suites: matrix, long, null, impair, impair2, hd, design

import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_MODEM, type ModemParams } from '../core/src/modem.ts';
import { runChannel, summarize, type ChannelConfig } from './channel.ts';
import { RESULTS, type CodecConfig, type CodecName } from './video.ts';

export const PROFILES = { standard: { amplitude: 1.5, chroma: 2 }, strong: { amplitude: 2, chroma: 3 } } as const;

const HD_CLIPS = ['johnny', 'kristen_sara', 'vidyo1', 'vidyo4'];
const CIF_CLIPS = ['akiyo', 'news', 'silent', 'mother_daughter', 'paris', 'deadline', 'sign_irene', 'students', 'foreman'];

/** Codec set that mirrors real call stacks: VP8 and VP9 with their encoder denoiser on. */
function codecs(kbps: number): CodecConfig[] {
  return [
    { codec: 'vp8', kbps, denoise: true },
    { codec: 'vp8', kbps, denoise: false },
    { codec: 'vp9', kbps, denoise: true },
    { codec: 'h264', kbps },
    { codec: 'av1', kbps },
  ];
}

interface Row extends ChannelConfig {
  suite: string;
  note?: string;
}

function suite(name: string): Row[] {
  const rows: Row[] = [];
  const add = (r: Omit<Row, 'suite'>) => rows.push({ suite: name, ...r });
  switch (name) {
    case 'matrix':
      // every codec at every target bitrate, talking-head clips at 360p and CIF
      for (const profile of ['standard', 'strong'] as const) {
        for (const kbps of [300, 600, 1000, 2000]) {
          for (const codec of codecs(kbps)) {
            for (const clip of HD_CLIPS) add({ clip, width: 640, height: 360, seconds: 20, codec, ...PROFILES[profile], note: profile });
          }
        }
        for (const kbps of [300, 600]) {
          for (const codec of codecs(kbps)) {
            for (const clip of CIF_CLIPS) add({ clip, width: 352, height: 288, seconds: 20, codec, ...PROFILES[profile], note: profile });
          }
        }
      }
      break;
    case 'hd':
      // 720p, and 1080p upscaled from 720p sources (no native 1080p conference footage in the test set)
      for (const profile of ['standard', 'strong'] as const) {
        for (const kbps of [600, 1000, 2000]) {
          for (const codec of codecs(kbps)) {
            for (const clip of HD_CLIPS) add({ clip, width: 1280, height: 720, seconds: 20, codec, ...PROFILES[profile], note: profile });
          }
        }
        for (const codec of codecs(2000)) add({ clip: 'johnny', width: 1920, height: 1080, seconds: 12, codec, ...PROFILES[profile], note: profile + ' upscaled' });
      }
      break;
    case 'long':
      // the headline condition, many periods: VP8 at 600 kbps, 360p, encoder denoiser on
      for (const profile of ['standard', 'strong'] as const) {
        for (const seed of [1, 2, 3]) {
          for (const clip of HD_CLIPS) {
            add({ clip, width: 640, height: 360, seconds: 60, codec: { codec: 'vp8', kbps: 600, denoise: true }, ...PROFILES[profile], seed, note: profile });
          }
        }
      }
      break;
    case 'null':
      // unsealed video: the receiver must never report a seal
      for (const kbps of [300, 1000]) {
        for (const codec of codecs(kbps)) {
          for (const clip of HD_CLIPS) add({ clip, width: 640, height: 360, seconds: 30, codec, amplitude: 0, chroma: 0 });
          for (const clip of CIF_CLIPS) add({ clip, width: 352, height: 288, seconds: 30, codec, amplitude: 0, chroma: 0 });
        }
      }
      break;
    case 'impair':
    case 'impair2': {
      // 'impair' uses the light seal, 'impair2' the default one
      const base = { width: 640, height: 360, seconds: 20, ...(name === 'impair2' ? PROFILES.strong : PROFILES.standard) };
      const vp8: CodecConfig = { codec: 'vp8', kbps: 600, denoise: true };
      for (const clip of HD_CLIPS) {
        add({ clip, ...base, codec: vp8, note: 'baseline' });
        add({ clip, ...base, codec: { ...vp8, preFilter: 'fps=15' }, outSize: { width: 640, height: 360, fps: 15 }, note: '15 fps' });
        add({ clip, ...base, codec: vp8, dropRate: 0.1, note: '10% frames lost' });
        add({ clip, ...base, codec: vp8, dropRate: 0.3, note: '30% frames lost' });
        add({ clip, ...base, codec: { ...vp8, kbps: 300, preFilter: 'scale=320:180' }, outSize: { width: 320, height: 180 }, note: 'sent at 320x180, 300 kbps' });
        add({ clip, ...base, codec: { ...vp8, preFilter: 'scale=480:270' }, outSize: { width: 480, height: 270 }, note: 'sent at 480x270' });
        add({ clip, ...base, codec: { ...vp8, postFilter: 'scale=960:540:flags=bilinear' }, outSize: { width: 960, height: 540 }, note: 'upscaled by the receiver' });
        for (const pct of [1, 2, 4, 8]) {
          const f = (1 - pct / 100).toFixed(2);
          add({ clip, ...base, codec: { ...vp8, preFilter: `crop=iw*${f}:ih*${f},scale=640:360` }, note: `crop ${pct}%` });
        }
        add({ clip, ...base, codec: { ...vp8, postFilter: 'eq=brightness=0.06:contrast=1.15' }, note: 'brighter, more contrast' });
        add({ clip, ...base, codec: { ...vp8, postFilter: 'eq=brightness=-0.08:gamma=0.85' }, note: 'darker' });
        add({ clip, ...base, codec: vp8, stages: [{ codec: 'h264', kbps: 600 }], note: 're-encoded: VP8 then H.264 600 kbps' });
        add({ clip, ...base, codec: vp8, stages: [{ codec: 'vp9', kbps: 300, denoise: true }], note: 're-encoded: VP8 then VP9 300 kbps' });
        // "re-filmed screen": blur, gamma, sensor noise and a mild keystone, undone with a registration error of a few pixels
        for (const err of [0, 2, 5]) {
          const fwd = 'perspective=x0=18:y0=10:x1=628:y1=4:x2=8:y2=352:x3=634:y3=356:sense=destination';
          const inv = `perspective=x0=${18 + err}:y0=${10 - err}:x1=${628 + err}:y1=${4 + err}:x2=${8 - err}:y2=${352 + err}:x3=${634 - err}:y3=${356 - err}:sense=source`;
          add({
            clip, ...base, codec: vp8,
            stages: [{ codec: 'h264', kbps: 2000, preFilter: `${fwd},gblur=sigma=0.9,eq=gamma=1.12:contrast=1.08,noise=alls=5:allf=t`, postFilter: inv }],
            note: `re-filmed model, ${err}px registration error`,
          });
        }
      }
      break;
    }
    case 'design': {
      // the alternatives that were considered, on the same condition
      const cond = { width: 640, height: 360, seconds: 20 };
      const variants: [string, Partial<ModemParams>, { amplitude: number; chroma: number }][] = [
        ['luma only, Reed-Solomon', { planes: 1, fec: 'rs', redundancy: 104 }, { amplitude: 2, chroma: 0 }],
        ['luma only, LDPC', { planes: 1 }, { amplitude: 2, chroma: 0 }],
        ['luma only, LDPC, strong', { planes: 1 }, { amplitude: 3, chroma: 0 }],
        ['three planes, LDPC (chosen)', {}, PROFILES.standard],
        ['three planes, soft edges 0.6', { edge: 0.6 }, PROFILES.standard],
        ['three planes, hard edges', { edge: 0 }, PROFILES.standard],
        ['three planes, 100 ms cross-fade', { fadeMs: 100 }, PROFILES.standard],
        ['three planes, no cross-fade', { fadeMs: 0 }, PROFILES.standard],
        ['three planes, 48x27 grid', { gridW: 48, gridH: 27 }, PROFILES.standard],
        ['three planes, 24x14 grid', { gridW: 24, gridH: 14 }, PROFILES.standard],
        ['three planes, 16 slots', { symbols: 16 }, PROFILES.standard],
        ['three planes, 4 slots', { symbols: 4 }, PROFILES.standard],
      ];
      for (const [label, m, amp] of variants) {
        for (const codec of [{ codec: 'vp8' as CodecName, kbps: 600, denoise: true }, { codec: 'h264' as CodecName, kbps: 600 }, { codec: 'vp9' as CodecName, kbps: 300, denoise: true }]) {
          for (const clip of HD_CLIPS) add({ clip, ...cond, codec, modem: { ...DEFAULT_MODEM, ...m }, ...amp, note: label });
        }
      }
      break;
    }
    default:
      throw new Error(`unknown suite ${name}`);
  }
  return rows;
}

const [name, shardArg, shardsArg] = process.argv.slice(2);
if (!name) {
  console.error('usage: node codec-sim/run-channel.ts <suite> [shard] [shards]');
  process.exit(1);
}
const shard = Number(shardArg ?? 0);
const shards = Number(shardsArg ?? 1);
const file = join(RESULTS, `channel-${name}.jsonl`);
const keyOf = (r: Row) => JSON.stringify(r);
const done = new Set<string>();
if (existsSync(file)) {
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (line.trim()) done.add(JSON.parse(line).key);
  }
}
const rows = suite(name);
let ran = 0;
rows.forEach((row, index) => {
  if (index % shards !== shard) return;
  const key = keyOf(row);
  if (done.has(key)) return;
  try {
    const result = runChannel(row);
    const { perPeriod, config, ...rest } = result;
    appendFileSync(file, JSON.stringify({ key, row, ...rest, periods: perPeriod.map((p) => ({ p: p.period, ok: p.ok, e: p.bitErrors })) }) + '\n');
    console.log(`[${index + 1}/${rows.length}] ${row.note ?? ''} | ${summarize(result)}`);
  } catch (err) {
    console.error(`[${index + 1}/${rows.length}] FAILED ${key}: ${(err as Error).message.split('\n')[0]}`);
  }
  ran++;
});
console.log(`suite ${name} shard ${shard}/${shards}: ${ran} runs`);
