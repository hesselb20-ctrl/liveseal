// Builds every table in docs/EVALUATION.md from the result files, so the
// document cannot drift from what was measured. Each table sits between
// `<!-- table:NAME -->` and `<!-- /table -->` markers and is replaced in place.
//
// Usage: node codec-sim/make-tables.ts

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { RESULTS, ROOT } from './video.ts';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

function rows(name: string): Json[] {
  const file = join(RESULTS, name);
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

function md(header: string[], body: (string | number)[][]): string {
  return [`| ${header.join(' | ')} |`, `|${header.map(() => '---').join('|')}|`, ...body.map((r) => `| ${r.join(' | ')} |`)].join('\n');
}

const pct = (a: number, b: number) => (b ? `${((100 * a) / b).toFixed(1)}%` : 'n/a');
const frac = (a: number, b: number) => `${a} of ${b} (${pct(a, b)})`;
const codecLabel = (c: Json) => ({ vp8: c.denoise ? 'VP8, denoiser on' : 'VP8, denoiser off', vp9: 'VP9, denoiser on', h264: 'H.264 baseline', av1: 'AV1' } as Record<string, string>)[c.codec] ?? c.codec;
const profileLabel = (note: string) => (note.startsWith('strong') ? 'default (2 / 3 / 3)' : 'light (1.5 / 2 / 2)');
const HD = ['johnny', 'kristen_sara', 'vidyo1', 'vidyo4'];
const sum = (list: Json[], f: (r: Json) => number) => list.reduce((n, r) => n + f(r), 0);

const tables: Record<string, string> = {};

// ---- headline
{
  const long = rows('channel-long.jsonl');
  const body: (string | number)[][] = [];
  for (const profile of ['strong', 'standard']) {
    const set = long.filter((r) => r.row.note === profile);
    if (!set.length) continue;
    const first = set.map((r) => r.firstRecoveryMs).filter((v: number) => v >= 0);
    body.push([
      profileLabel(profile), set.length, sum(set, (r) => r.periodsSent),
      frac(sum(set, (r) => r.periodsRecovered), sum(set, (r) => r.periodsSent)),
      sum(set, (r) => r.periodsWrong),
      first.length ? `${(Math.min(...first) / 1000).toFixed(1)} to ${(Math.max(...first) / 1000).toFixed(1)} s` : 'never',
      (sum(set, (r) => r.sealPsnr) / set.length).toFixed(1) + ' dB',
    ]);
  }
  tables.headline = md(['Seal amplitude (Y / Cb / Cr)', 'Runs', 'Periods', 'Statements recovered', 'Wrong decodes', 'First statement after stream start', 'Luma PSNR of the seal'], body);
  const per: (string | number)[][] = [];
  for (const clip of HD) {
    for (const profile of ['strong', 'standard']) {
      const set = long.filter((r) => r.row.note === profile && r.row.clip === clip);
      if (set.length) per.push([clip, profileLabel(profile), frac(sum(set, (r) => r.periodsRecovered), sum(set, (r) => r.periodsSent))]);
    }
  }
  tables['headline-clips'] = md(['Clip', 'Seal', 'Statements recovered'], per);
}

// ---- codec x bitrate matrix
function matrix(set: Json[], rates: number[]): string {
  const codecs = [...new Set(set.map((r) => codecLabel(r.row.codec)))];
  const body = codecs.map((label) => [label, ...rates.map((k) => {
    const cell = set.filter((r) => codecLabel(r.row.codec) === label && r.row.codec.kbps === k);
    return cell.length ? `${sum(cell, (r) => r.periodsRecovered)}/${sum(cell, (r) => r.periodsSent)} (${pct(sum(cell, (r) => r.periodsRecovered), sum(cell, (r) => r.periodsSent))})` : '';
  })]);
  return md(['Codec', ...rates.map((k) => (k >= 1000 ? `${k / 1000} Mbps` : `${k} kbps`))], body);
}
{
  const m = rows('channel-matrix.jsonl');
  for (const profile of ['strong', 'standard']) {
    const tag = profile === 'strong' ? 'default' : 'light';
    tables[`matrix-360-${tag}`] = matrix(m.filter((r) => r.row.note === profile && r.row.width === 640), [300, 600, 1000, 2000]);
    tables[`matrix-cif-${tag}`] = matrix(m.filter((r) => r.row.note === profile && r.row.width === 352 && r.row.clip !== 'foreman'), [300, 600]);
    tables[`matrix-handheld-${tag}`] = matrix(m.filter((r) => r.row.note === profile && r.row.clip === 'foreman'), [300, 600]);
  }
  const hd = rows('channel-hd.jsonl');
  for (const profile of ['strong', 'standard']) {
    const tag = profile === 'strong' ? 'default' : 'light';
    tables[`matrix-720-${tag}`] = matrix(hd.filter((r) => r.row.note === profile && r.row.width === 1280), [600, 1000, 2000]);
    tables[`matrix-1080-${tag}`] = matrix(hd.filter((r) => String(r.row.note).startsWith(profile) && r.row.width === 1920), [2000]);
  }
  const all = [...m, ...hd, ...rows('channel-long.jsonl'), ...rows('channel-impair.jsonl'), ...rows('channel-impair2.jsonl'), ...rows('channel-design.jsonl')];
  tables['wrong-total'] = md(['Sealed runs', 'Periods sent', 'Periods recovered', 'Periods decoded to something else'],
    [[all.length, sum(all, (r) => r.periodsSent), sum(all, (r) => r.periodsRecovered), sum(all, (r) => r.periodsWrong)]]);
}

// ---- unsealed video
{
  const n = rows('channel-null.jsonl');
  const worst = Math.max(-1, ...n.map((r) => r.maxAbsentScore));
  tables.null = md(['Unsealed runs', 'Seconds of video', 'Periods reported as sealed', 'Highest pilot score seen', 'Detection threshold'],
    [[n.length, sum(n, (r) => r.row.seconds), sum(n, (r) => r.periodsDetected), worst.toFixed(2), '0.30']]);
}

// ---- impairments
for (const [file, tag] of [['channel-impair.jsonl', 'light'], ['channel-impair2.jsonl', 'default']] as const) {
  const set = rows(file);
  const notes = [...new Set(set.map((r) => r.row.note as string))];
  tables[`impair-${tag}`] = md(['Condition (VP8, 600 kbps, 640x360, denoiser on)', 'Statements recovered', 'Wrong decodes'],
    notes.map((note) => {
      const cell = set.filter((r) => r.row.note === note);
      return [note, frac(sum(cell, (r) => r.periodsRecovered), sum(cell, (r) => r.periodsSent)), sum(cell, (r) => r.periodsWrong)];
    }));
}

// ---- design alternatives
{
  const set = rows('channel-design.jsonl');
  const notes = [...new Set(set.map((r) => r.row.note as string))];
  const conds = [['VP8 600 kbps, denoiser on', (r: Json) => r.row.codec.codec === 'vp8'], ['H.264 600 kbps', (r: Json) => r.row.codec.codec === 'h264'], ['VP9 300 kbps', (r: Json) => r.row.codec.codec === 'vp9']] as const;
  tables.design = md(['Variant', ...conds.map((c) => c[0])], notes.map((note) => [note, ...conds.map(([, f]) => {
    const cell = set.filter((r) => r.row.note === note && f(r));
    return frac(sum(cell, (r) => r.periodsRecovered), sum(cell, (r) => r.periodsSent));
  })]));
}

// ---- digest
{
  const file = join(RESULTS, 'digest-eval.json');
  if (existsSync(file)) {
    const d = JSON.parse(readFileSync(file, 'utf8')) as Json;
    const usable = (r: Json) => ['swap', 'other'].every((c) => r.falseMatch[c] === 0 && r.red[c] === 1);
    const ranked = (d.rows as Json[]).filter((r) => !r.key.startsWith('thumb')).sort((a, b) => Number(usable(b)) - Number(usable(a)) || a.subtleFalseMatch - b.subtleFalseMatch || a.bytes - b.bytes);
    const name = (key: string) => {
      const [kind, rest] = key.split('-');
      const [bits, snaps] = rest.replace('w', '').split('x');
      return `${kind}, ${bits} bits x ${snaps} snapshots${key.endsWith('w') ? ', weighted' : ''}`;
    };
    const f3 = (v: number) => v.toFixed(3);
    const p1 = (v: number) => `${(100 * v).toFixed(1)}%`;
    tables['digest-summary'] = md(['Runs', 'Genuine periods', 'Attack periods', 'Candidates compared'], [[d.runs, d.genuinePeriods, d.attackPeriods, ranked.length]]);
    const pickKinds = ['gradient', 'dct', 'block', 'projection'];
    const best = pickKinds.flatMap((k) => ranked.filter((r) => r.key.startsWith(k)).slice(0, 2));
    const extra = ranked.filter((r) => ['gradient-48x4', 'dct-48x4', 'gradient-64x8w'].includes(r.key));
    const shown = [...new Map([...best, ...extra].map((r) => [r.key, r])).values()].sort((a, b) => Number(usable(b)) - Number(usable(a)) || a.subtleFalseMatch - b.subtleFalseMatch);
    tables['digest-candidates'] = md(
      ['Candidate', 'Bytes', 'Genuine distance (median / 99th / max)', 'Replaced face: smallest distance', 'Separation', 'Meets the hard requirement', 'Subtle edits that still match'],
      shown.map((r) => [name(r.key) + (r.key === 'gradient-48x4w' ? ' **(chosen)**' : ''), r.bytes, `${f3(r.genuine.p50)} / ${f3(r.genuine.p99)} / ${f3(r.genuine.max)}`,
        f3(r.attacks.swap.min), r.separation.toFixed(2) + 'x', usable(r) ? 'yes' : 'no', p1(r.subtleFalseMatch)]));
    const chosen = (d.rows as Json[]).find((r) => r.key === 'gradient-48x4w');
    if (chosen) {
      tables['digest-conditions'] = md(['Codec condition', 'Genuine distance, 95th percentile', 'Largest'], Object.entries(chosen.perCondition as Record<string, Json>).map(([c, v]) => [c, f3(v.p95), f3(v.max)]));
      const order = ['other', 'swap', 'warp:0.12', 'warp:0.06', 'warp:0.03', 'shift:60', 'shift:15', 'still', 'mouth:20', 'mouth:8'];
      const text: Record<string, string> = {
        other: 'A different person and scene', swap: 'Another face pasted in, colour-matched', 'warp:0.12': 'Same face, geometry bent by 12%',
        'warp:0.06': 'Same face, geometry bent by 6%', 'warp:0.03': 'Same face, geometry bent by 3%', 'shift:60': 'Same video, 2 s late',
        'shift:15': 'Same video, 0.5 s late', still: 'Same video, frozen each period', 'mouth:20': 'Mouth region from 0.7 s later', 'mouth:8': 'Mouth region from 0.3 s later',
      };
      tables['digest-attacks'] = md(['Attack on the picture', 'Periods', 'Distance (smallest / 5th percentile / median)', 'AUC against genuine'],
        order.filter((c) => chosen.attacks[c]).map((c) => [text[c], chosen.attacks[c].n, `${f3(chosen.attacks[c].min)} / ${f3(chosen.attacks[c].p05)} / ${f3(chosen.attacks[c].p50)}`, chosen.attacks[c].auc.toFixed(4)]));
    }
    const thumb = (d.rows as Json[]).find((r) => r.key === 'thumb-32x2w');
    if (thumb) tables['digest-frame'] = md(['Whole-frame hash (32 bits x 2 snapshots)', 'Value'], [['Largest genuine distance', f3(thumb.genuine.max)], ['Smallest distance for a different scene', f3(thumb.attacks.other.min)]]);
  }
}

// ---- attack suite
{
  const a = rows('attacks.jsonl');
  if (a.length) {
    const groups = [...new Map(a.map((r) => [`${r.threat}|${r.label}`, r])).values()];
    const line = (threat: string, label: string) => {
      const set = a.filter((r) => r.threat === threat && r.label === label);
      const periods = sum(set, (r) => r.periods);
      const runsRed = set.filter((r) => r.red > 0).length;
      const runsGreen = set.filter((r) => r.green > 0).length;
      return [threat, label, set.length, periods, sum(set, (r) => r.green), sum(set, (r) => r.amber), sum(set, (r) => r.red), `${runsRed} / ${runsGreen}`];
    };
    const head = ['Threat', 'What the attacker does', 'Runs', 'Periods', 'Green periods', 'Amber', 'Red', 'Runs with red / with green'];
    tables['attacks-must'] = md(head, groups.filter((g) => g.group === 'must').map((g) => line(g.threat, g.label)));
    tables['attacks-limit'] = md(head, groups.filter((g) => g.group === 'limit').map((g) => line(g.threat, g.label)));
    tables['attacks-process'] = md(head, groups.filter((g) => g.group === 'process' || g.group === 'genuine').map((g) => line(g.threat, g.label)));
    const must = a.filter((r) => r.group === 'must');
    const t3 = must.filter((r) => r.threat === 'T3');
    tables['attacks-total'] = md(['Measure', 'Result'], [
      ['Attack periods in the "must never be green" group', sum(must, (r) => r.periods)],
      ['Green periods among them', sum(must, (r) => r.green)],
      ['Relay (T3) runs', t3.length],
      ['Relay runs that ended amber or red (no green at any point)', frac(t3.filter((r) => r.green === 0).length, t3.length)],
      ['Relay runs that reached red', frac(t3.filter((r) => r.red > 0).length, t3.length)],
      ['T7 periods shown as a strong warning', frac(sum(must.filter((r) => r.threat === 'T7'), (r) => r.strong), sum(must.filter((r) => r.threat === 'T7'), (r) => r.periods))],
    ]);
    const gen = a.filter((r) => r.group === 'genuine');
    const byCodec = [...new Set(gen.map((r) => r.codec))];
    tables['attacks-genuine'] = md(['Codec', 'Runs', 'Periods', 'Green', 'Amber', 'Red', 'Green share after the first green'], byCodec.map((c) => {
      const set = gen.filter((r) => r.codec === c);
      let after = 0;
      let greenAfter = 0;
      for (const r of set) {
        const i = (r.levels as string).indexOf('g');
        if (i < 0) continue;
        after += r.levels.length - i;
        greenAfter += [...(r.levels as string).slice(i)].filter((x) => x === 'g').length;
      }
      return [c, set.length, sum(set, (r) => r.periods), sum(set, (r) => r.green), sum(set, (r) => r.amber), sum(set, (r) => r.red), pct(greenAfter, after)];
    }));
  }
}

// ---- browser loop-back (results copied from the lab page into docs/browser-loopback.json)
{
  const file = join(ROOT, 'docs', 'browser-loopback.json');
  if (existsSync(file)) {
    const b = JSON.parse(readFileSync(file, 'utf8')) as Json;
    const runs = (b.runs as Json[]) ?? [];
    tables['browser-genuine'] = md(['Codec', 'Target', 'Measured', 'Encoded size', 'Path', 'Periods', 'Time to green', 'Green after first green', 'Seal found (Y / Cb / Cr)'],
      runs.filter((r) => r.attack === 'none').map((r) => [String(r.codec).replace('video/', ''), `${r.targetKbps} kbps`, `${r.measuredKbps} kbps`, r.size, r.path ?? '', r.periods,
        r.timeToGreenMs >= 0 ? `${(r.timeToGreenMs / 1000).toFixed(1)} s` : 'never', `${Math.round(100 * r.greenAfterFirst)}%`, (r.meanAmplitude as number[]).join(' / ')]));
    tables['browser-attacks'] = md(['Attack in the lab', 'Codec', 'Badge per period (a amber, g green, r red)', 'Green periods after the attack began'],
      runs.filter((r) => r.attack !== 'none').map((r) => [r.attackLabel ?? r.attack, String(r.codec).replace('video/', ''), '`' + r.levels + '`', r.greenAfterAttack ?? 'n/a']));
    if (b.cost) tables['browser-cost'] = md(['Measure', 'Value'], (b.cost as [string, string][]).map((c) => c));
  }
}

const doc = join(ROOT, 'docs', 'EVALUATION.md');
let text = readFileSync(doc, 'utf8');
let filled = 0;
const missing: string[] = [];
text = text.replace(/<!-- table:([a-z0-9-]+) -->[\s\S]*?<!-- \/table -->/g, (_all, name: string) => {
  if (!tables[name]) { missing.push(name); return `<!-- table:${name} -->\n_not measured_\n<!-- /table -->`; }
  filled++;
  return `<!-- table:${name} -->\n${tables[name]}\n<!-- /table -->`;
});
writeFileSync(doc, text);
console.log(`filled ${filled} tables` + (missing.length ? `; no data for: ${missing.join(', ')}` : ''));
const unused = Object.keys(tables).filter((n) => !text.includes(`<!-- table:${n} -->`));
if (unused.length) console.log(`tables without a marker in the document: ${unused.join(', ')}`);
