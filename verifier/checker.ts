// Recording checker: plays a file through the normal verifier and writes a
// report with one row per seal period.

import type { PeriodReport } from '../core/src/session.ts';
import { PERIOD_MS } from '../core/src/statement.ts';
import { DEFAULT_POLICY, isRed, type VerifierPolicy } from '../core/src/verify.ts';
import { BADGE_CSS, createBadge } from '../shared/badge.ts';
import { mountContacts } from '../shared/contacts-ui.ts';
import { VerifyPipeline } from '../shared/pipelines.ts';
import { loadDirectory, loadIdentity, saveDirectory } from '../shared/store.ts';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
document.head.append(Object.assign(document.createElement('style'), { textContent: BADGE_CSS }));

// A recording is always "old", so the freshness rule is switched off here and the
// time inside each seal is reported instead. Every other check stays as it is.
const RECORDING_POLICY: VerifierPolicy = { ...DEFAULT_POLICY, passiveMaxSkewSeconds: Number.MAX_SAFE_INTEGER, challengeMaxSkewSeconds: Number.MAX_SAFE_INTEGER };

interface Row {
  atSeconds: number;
  result: string;
  level: string;
  signedBy: string;
  sealTime: string;
  distance: number | null;
}

const video = $<HTMLVideoElement>('video');
const badge = createBadge();
$('badge-slot').append(badge.element);
const directory = await loadDirectory();
const identity = await loadIdentity();
let rows: Row[] = [];
let pipeline: VerifyPipeline | null = null;
let fileName = '';

function addRow(r: PeriodReport): void {
  const o = r.outcome;
  const period = 'statement' in o ? o.statement.period : 'period' in o ? o.period : null;
  const row: Row = {
    atSeconds: +video.currentTime.toFixed(1),
    result: o.code === 'valid' ? (o.checked ? 'valid' : 'valid signature, picture not compared (start of file)') : o.code,
    level: o.code === 'valid' ? 'ok' : isRed(o.code) ? 'bad' : 'warn',
    signedBy: 'key' in o ? o.key.name + (o.key.label ? ` (${o.key.label})` : '') : '',
    sealTime: period === null ? '' : new Date((period + 1) * PERIOD_MS).toISOString().replace('T', ' ').slice(0, 19),
    distance: 'score' in o ? +o.score.toFixed(3) : null,
  };
  rows.push(row);
  const body = $('rows');
  if (body.querySelector('td[colspan]')) body.replaceChildren();
  const tr = document.createElement('tr');
  const cell = (text: string) => Object.assign(document.createElement('td'), { textContent: text });
  const result = document.createElement('td');
  result.append(Object.assign(document.createElement('span'), { className: `pill ${row.level}`, textContent: row.result }));
  tr.append(cell(`${row.atSeconds.toFixed(1)} s`), result, cell(row.signedBy || '–'), cell(row.sealTime || '–'), cell(row.distance === null ? '–' : row.distance.toFixed(3)));
  body.append(tr);
  badge.update(r.badge);
}

function summarise(): void {
  const total = rows.length;
  const valid = rows.filter((r) => r.level === 'ok').length;
  const bad = rows.filter((r) => r.level === 'bad');
  const signers = [...new Set(rows.filter((r) => r.level === 'ok').map((r) => r.signedBy))];
  const lines: string[] = [];
  if (total === 0) lines.push('The recording was too short to contain a complete seal period.');
  else if (valid === 0 && bad.length === 0) lines.push(`No verifiable seal was found in ${total} periods. That does not show the recording is fake, only that it cannot be verified.`);
  else {
    lines.push(`${valid} of ${total} periods carry a valid seal${signers.length ? ` from ${signers.join(' and ')}` : ''}.`);
    if (bad.length) lines.push(`${bad.length} period${bad.length === 1 ? '' : 's'} failed a check (${[...new Set(bad.map((b) => b.result))].join(', ')}): the first at ${bad[0].atSeconds.toFixed(1)} s.`);
    const other = total - valid - bad.length;
    if (other) lines.push(`${other} period${other === 1 ? '' : 's'} could not be confirmed (no readable seal, or a picture too far from the signed one to be sure).`);
  }
  $('summary').replaceChildren(...lines.map((t) => Object.assign(document.createElement('p'), { textContent: t })));
  $<HTMLButtonElement>('download').disabled = total === 0;
}

async function check(file: File): Promise<void> {
  pipeline?.stop();
  rows = [];
  fileName = file.name;
  $('rows').replaceChildren();
  $('summary').replaceChildren(Object.assign(document.createElement('p'), { textContent: `Checking ${file.name}…` }));
  $('stage').classList.remove('hidden');
  $('progress').classList.remove('hidden');
  video.src = URL.createObjectURL(file);
  video.playbackRate = 1;
  pipeline = new VerifyPipeline({ video, directory, onReport: addRow, policy: RECORDING_POLICY });
  pipeline.start();
  try {
    await video.play();
  } catch {
    $('summary').replaceChildren(Object.assign(document.createElement('p'), { textContent: 'This browser cannot play that file.' }));
  }
}

video.addEventListener('timeupdate', () => {
  if (video.duration) $<HTMLProgressElement>('progress').value = video.currentTime / video.duration;
});
video.addEventListener('ended', () => {
  // give the last period a moment to finish
  setTimeout(() => {
    pipeline?.stop();
    summarise();
    $('progress').classList.add('hidden');
  }, 400);
});

$<HTMLInputElement>('file').addEventListener('change', (e) => {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (file) void check(file);
});
const drop = $('drop');
drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
drop.addEventListener('dragleave', () => drop.classList.remove('over'));
drop.addEventListener('drop', (e) => {
  e.preventDefault();
  drop.classList.remove('over');
  const file = e.dataTransfer?.files?.[0];
  if (file) void check(file);
});
$('download').addEventListener('click', () => {
  const report = { file: fileName, checkedAt: new Date().toISOString(), note: 'Times are those written into each seal by the signing device.', periods: rows };
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }));
  a.download = `liveseal-report-${fileName.replace(/\.[^.]+$/, '')}.json`;
  a.click();
});

// development aid: check a file served by the dev server (?file=/data/test/sealed.webm)
const preset = new URLSearchParams(location.search).get('file');
if (preset) {
  void fetch(preset).then((r) => r.blob()).then((b) => check(new File([b], preset.split('/').pop() ?? 'recording')));
}

mountContacts($('contacts'), { identity, directory, onChange: () => saveDirectory(directory) });
