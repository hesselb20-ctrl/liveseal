// The lab: a sealed loop-back call with attack buttons. It is both the public
// demo and the tool that produced the "browser loop-back" numbers in
// docs/EVALUATION.md (open it with ?auto=1&codec=VP8&kbps=600&seconds=60).

import { createSigner, randomBytes, type Signer } from '../core/src/crypto.ts';
import { KeyDirectory } from '../core/src/directory.ts';
import { SEAL_AMPLITUDE, SEAL_AMPLITUDE_LIGHT, SenderSession, type PeriodReport } from '../core/src/session.ts';
import { challengeToWords, wordsToChallenge } from '../core/src/words.ts';
import { BADGE_CSS, createBadge } from '../shared/badge.ts';
import { cameraSource, drawnSource, fileSource, type VideoSource } from '../shared/demo-source.ts';
import { GlSealer } from '../shared/gl-sealer.ts';
import { LoopbackCall, availableCodecs, type CodecChoice } from '../shared/loopback.ts';
import { TrackSealer, supportsInsertableStreams } from '../shared/insertable.ts';
import { SealPipeline, VerifyPipeline } from '../shared/pipelines.ts';
import { WorkerVerifier } from '../shared/worker-pipeline.ts';

type Attack = 'none' | 'strip' | 'swap' | 'other' | 'replay' | 'impostor' | 'revoked';

const NOTES: Record<Attack, string> = {
  none: '',
  strip: 'The attacker sends a fake picture and cannot produce a seal. Expected: amber, "not verified".',
  swap: 'The attacker pastes another face over the caller and re-applies the copied seal. Expected: red, the picture does not match what was sealed.',
  other: 'The attacker shows a different person entirely under the copied seal. Expected: red.',
  replay: 'The attacker plays back a sealed recording five minutes later. Expected: red, the seal is from another time.',
  impostor: 'The attacker seals with a key of their own that you never verified. Expected: amber, sealed by an unknown key.',
  revoked: 'The caller reported their device stolen and revoked the key. Expected: red.',
};

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const params = new URLSearchParams(location.search);
const style = document.createElement('style');
style.textContent = BADGE_CSS;
document.head.append(style);

const sentCanvas = $<HTMLCanvasElement>('sent');
const received = $<HTMLVideoElement>('received');
const badge = createBadge();
$('badge-slot').append(badge.element);
const codecSelect = $<HTMLSelectElement>('codec');
for (const c of availableCodecs()) codecSelect.add(new Option(c === 'H264' ? 'H.264' : c, c));
if (params.get('codec')) codecSelect.value = params.get('codec') as string;
if (params.get('kbps')) $<HTMLSelectElement>('kbps').value = params.get('kbps') as string;
if (params.get('strength')) $<HTMLSelectElement>('strength').value = params.get('strength') as string;

interface Running {
  source: VideoSource;
  other: VideoSource;
  seal: SealPipeline;
  impostor: SenderSession;
  attackCanvas: HTMLCanvasElement;
  attackSealer: GlSealer;
  compose: HTMLCanvasElement;
  call: LoopbackCall;
  verify: VerifyPipeline;
  directory: KeyDirectory;
  caller: Signer;
  genuineTrack: MediaStreamTrack;
  attackTrack: MediaStreamTrack;
  statsTimer: number;
}

let running: Running | null = null;
let attack: Attack = 'none';
let clockOffset = 0;
let resetAt = 0;
let firstGreenMs = -1;
const reports: PeriodReport[] = [];
const rates: number[] = [];
let lastStats = { width: 0, height: 0, encoder: '', codec: '' };
let pathNote = '';

function resetStats(): void {
  reports.length = 0;
  rates.length = 0;
  firstGreenMs = -1;
  resetAt = performance.now();
  $('log').replaceChildren();
  $('s-green').textContent = '–';
  $('s-share').textContent = '–';
}

function describeOutcome(r: PeriodReport): string {
  const o = r.outcome;
  if (o.code === 'valid') return o.checked ? `valid, picture matches (distance ${o.score.toFixed(2)})` : 'valid signature, picture predates the receiver';
  if (o.code === 'content-mismatch' || o.code === 'content-uncertain') return `${o.code} (distance ${o.score.toFixed(2)})`;
  return o.code;
}

function onReport(r: PeriodReport): void {
  reports.push(r);
  badge.update(r.badge);
  if (r.badge.level === 'green' && firstGreenMs < 0) firstGreenMs = performance.now() - resetAt;
  const row = document.createElement('tr');
  const cells = [
    String(reports.length),
    describeOutcome(r),
    r.badge.level,
    r.amplitude.map((a) => a.toFixed(2)).join(', ') || '–',
    r.outcome.code === 'no-seal' || r.outcome.code === 'unreadable' ? '–' : String(r.bitErrors),
  ];
  for (const c of cells) row.append(Object.assign(document.createElement('td'), { textContent: c }));
  const log = $('log');
  log.prepend(row);
  while (log.children.length > 12) log.lastElementChild?.remove();
  $('s-green').textContent = firstGreenMs >= 0 ? `${(firstGreenMs / 1000).toFixed(1)} s` : '–';
  const firstGreenIndex = reports.findIndex((x) => x.badge.level === 'green');
  if (firstGreenIndex >= 0) {
    const after = reports.slice(firstGreenIndex);
    $('s-share').textContent = `${Math.round((100 * after.filter((x) => x.badge.level === 'green').length) / after.length)}%`;
  }
  // a verified peer asked us to verify: answer in the next statements
  if (running && $<HTMLInputElement>('auto-answer').checked && running.verify.session.checker.getChallenge()) {
    running.seal.session.answerChallenge(running.verify.session.checker.getChallenge());
  }
}

/** The attacker's picture for the current attack, drawn with the seal lifted from the genuine stream. */
function drawAttack(r: Running, field: Float32Array, frame: number): void {
  const v = r.source.video;
  const w = v.videoWidth;
  const h = v.videoHeight;
  if (attack === 'strip') {
    r.attackSealer.draw(r.other.video, w, h, field, frame, false);
  } else if (attack === 'other') {
    r.attackSealer.draw(r.other.video, w, h, field, frame, true);
  } else if (attack === 'swap') {
    const c = r.compose;
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    const ctx = c.getContext('2d') as CanvasRenderingContext2D;
    ctx.drawImage(v, 0, 0, w, h);
    // paste the other person's face over the caller's face region
    const fx = 0.3, fy = 0.1, fw = 0.4, fh = 0.62;
    ctx.save();
    ctx.beginPath();
    ctx.ellipse((fx + fw / 2) * w, (fy + fh / 2) * h, (fw / 2) * w * 0.8, (fh / 2) * h * 0.95, 0, 0, Math.PI * 2);
    ctx.clip();
    const o = r.other.video;
    ctx.drawImage(o, fx * o.videoWidth, fy * o.videoHeight, fw * o.videoWidth, fh * o.videoHeight, fx * w, fy * h, fw * w, fh * h);
    ctx.restore();
    r.attackSealer.draw(c, w, h, field, frame, true);
  } else if (attack === 'impostor') {
    r.attackSealer.draw(v, w, h, r.impostor.field(performance.timeOrigin + performance.now()), frame, true);
  }
}

async function start(): Promise<void> {
  stop();
  $<HTMLButtonElement>('start').disabled = true;
  try {
    const choice = $<HTMLSelectElement>('source').value;
    const url = params.get('source');
    const source = url ? await fileSource(url) : choice === 'camera' ? await cameraSource() : await drawnSource(0);
    const other = params.get('other') ? await fileSource(params.get('other') as string) : await drawnSource(1);
    const caller = (await createSigner()).signer;
    const impostorKey = (await createSigner()).signer;
    const directory = new KeyDirectory();
    await directory.addContact('Demo caller', caller.publicKey, Math.floor(Date.now() / 1000));
    const amplitude = $<HTMLSelectElement>('strength').value === 'light' ? SEAL_AMPLITUDE_LIGHT : SEAL_AMPLITUDE;
    const impostor = new SenderSession({ signer: impostorKey, amplitude });
    const attackCanvas = document.createElement('canvas');
    const attackSealer = new GlSealer(impostor.layout, attackCanvas);
    const seal = new SealPipeline({ signer: caller, source: source.video, output: sentCanvas, amplitude });
    const r: Partial<Running> = { source, other, seal, impostor, attackCanvas, attackSealer, compose: document.createElement('canvas'), directory, caller };
    seal.tap = (now, luma, field, frame) => {
      impostor.pushFrame(now, luma);
      if (attack !== 'none' && attack !== 'replay' && attack !== 'revoked') drawAttack(r as Running, field, frame);
    };
    seal.start();
    // wait for the first sealed frame before capturing
    await new Promise<void>((resolve) => {
      const wait = () => (seal.frames > 2 ? resolve() : setTimeout(wait, 30));
      wait();
    });
    attackSealer.draw(source.video, source.video.videoWidth, source.video.videoHeight, new Float32Array(impostor.layout.cells), 0, false);
    r.genuineTrack = sentCanvas.captureStream(30).getVideoTracks()[0];
    // ?insertable=1 sends the picture through the Insertable Streams sealer instead (the path the extension prefers)
    if (params.get('insertable') === '1' && supportsInsertableStreams()) {
      const v = source.video as HTMLVideoElement & { captureStream?: () => MediaStream };
      const raw = (v.srcObject instanceof MediaStream ? v.srcObject : v.captureStream?.())?.getVideoTracks()[0];
      if (raw) {
        const sealer = new TrackSealer(raw, caller, amplitude);
        r.genuineTrack = sealer.track;
        pathNote = 'insertable streams';
      }
    }
    r.attackTrack = attackCanvas.captureStream(30).getVideoTracks()[0];
    const call = new LoopbackCall();
    r.call = call;
    const remote = await call.start(r.genuineTrack, codecSelect.value as CodecChoice, Number($<HTMLSelectElement>('kbps').value));
    received.srcObject = remote;
    await received.play();
    const verify = new VerifyPipeline({ video: received, directory, onReport, clock: () => Date.now() + clockOffset });
    r.verify = verify;
    // ?worker=1 verifies in a worker with an OffscreenCanvas (the path the extension prefers)
    if (params.get('worker') === '1') {
      const worker = new Worker(new URL('../shared/verify-worker.ts', import.meta.url), { type: 'module' });
      const wv = new WorkerVerifier(worker, received, directory.toJSON(), onReport);
      wv.start();
      pathNote += (pathNote ? ' + ' : '') + 'worker verifier';
    } else {
      verify.start();
    }
    r.statsTimer = window.setInterval(async () => {
      const s = await call.stats();
      if (!s) return;
      if (s.kbps > 0) rates.push(s.kbps);
      lastStats = { width: s.width, height: s.height, encoder: s.encoder, codec: s.codec };
      $('s-rate').textContent = s.kbps ? `${s.kbps} kbps` : '–';
      $('s-size').textContent = s.width ? `${s.width}×${s.height}` : '–';
      $('cost').textContent = `Sealing costs ${seal.costMs.toFixed(2)} ms per frame and verifying ${verify.costMs.toFixed(2)} ms per frame on this device. `
        + `Encoder: ${s.encoder || 'unknown'} (${s.codec.replace('video/', '')}), ${s.fps} fps${s.qp ? `, quantiser ${s.qp}` : ''}${s.limitation && s.limitation !== 'none' ? `, limited by ${s.limitation}` : ''}.`;
    }, 1000);
    running = r as Running;
    resetStats();
    setAttack('none');
  } catch (err) {
    $('attack-note').textContent = `Could not start: ${(err as Error).message}`;
  } finally {
    $<HTMLButtonElement>('start').disabled = false;
    $<HTMLButtonElement>('start').textContent = running ? 'Restart the call' : 'Start the call';
  }
}

function stop(): void {
  if (!running) return;
  clearInterval(running.statsTimer);
  running.seal.stop();
  running.verify.stop();
  running.call.stop();
  running.source.stop();
  running.other.stop();
  running = null;
}

function setAttack(next: Attack): void {
  attack = next;
  for (const b of document.querySelectorAll<HTMLButtonElement>('#attacks button')) b.setAttribute('aria-pressed', String(b.dataset.attack === next));
  $('attack-note').textContent = NOTES[next];
  if (!running) return;
  clockOffset = next === 'replay' ? 300_000 : 0;
  const useAttackCanvas = next === 'strip' || next === 'swap' || next === 'other' || next === 'impostor';
  void running.call.replaceTrack(useAttackCanvas ? running.attackTrack : running.genuineTrack);
  if (next === 'revoked') void running.directory.revoke(running.caller.publicKey, Math.floor(Date.now() / 1000));
}

$('start').addEventListener('click', () => void start());
for (const b of document.querySelectorAll<HTMLButtonElement>('#attacks button')) {
  b.addEventListener('click', () => setAttack(b.dataset.attack as Attack));
}
$('verify').addEventListener('click', () => {
  if (!running) return;
  let challenge = randomBytes(3);
  while (challenge.every((x) => x === 0)) challenge = randomBytes(3);
  running.verify.session.checker.setChallenge(challenge);
  $('words').textContent = challengeToWords(challenge);
  $('answer-row').classList.toggle('hidden', $<HTMLInputElement>('auto-answer').checked);
  if ($<HTMLInputElement>('auto-answer').checked) running.seal.session.answerChallenge(challenge);
});
$('auto-answer').addEventListener('change', () => {
  $('answer-row').classList.toggle('hidden', $<HTMLInputElement>('auto-answer').checked || !$('words').textContent);
});
$('answer-go').addEventListener('click', () => {
  const c = wordsToChallenge($<HTMLInputElement>('answer').value);
  if (c && running) running.seal.session.answerChallenge(c);
  else $('attack-note').textContent = 'Those are not three words from the list.';
});

// ---- unattended measurement run, for docs/EVALUATION.md
declare global {
  interface Window { liveseal?: Record<string, unknown> }
}

async function autoRun(): Promise<void> {
  const seconds = Number(params.get('seconds') ?? 60);
  window.liveseal = { done: false };
  await start();
  if (!running) { window.liveseal = { done: true, error: $('attack-note').textContent }; return; }
  let attackStart = -1;
  if (params.get('attack')) {
    // let the genuine call reach green first, then attack
    await new Promise((resolve) => setTimeout(resolve, Number(params.get('attackAfter') ?? 12) * 1000));
    attackStart = reports.length;
    setAttack(params.get('attack') as Attack);
  }
  await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
  const firstGreen = reports.findIndex((x) => x.badge.level === 'green');
  const after = firstGreen >= 0 ? reports.slice(firstGreen) : [];
  const count = (level: string, list = reports) => list.filter((x) => x.badge.level === level).length;
  window.liveseal = {
    done: true,
    codec: lastStats.codec,
    encoder: lastStats.encoder,
    targetKbps: Number($<HTMLSelectElement>('kbps').value),
    measuredKbps: rates.length ? Math.round(rates.slice(3).reduce((a, b) => a + b, 0) / Math.max(1, rates.length - 3)) : 0,
    size: `${lastStats.width}x${lastStats.height}`,
    strength: $<HTMLSelectElement>('strength').value,
    path: pathNote || 'canvas sealer + in-thread verifier',
    attack,
    // The report that arrives right after the switch still describes pictures sent before it.
    levelsBeforeAttack: attackStart >= 0 ? reports.slice(0, attackStart + 1).map((x) => x.badge.level[0]).join('') : undefined,
    greenAfterAttack: attackStart >= 0 ? reports.slice(attackStart + 1).filter((x) => x.badge.level === 'green').length : undefined,
    periods: reports.length,
    codes: reports.map((x) => x.outcome.code + (x.outcome.code === 'valid' && !x.outcome.checked ? '*' : '')),
    levels: reports.map((x) => x.badge.level[0]).join(''),
    timeToGreenMs: Math.round(firstGreenMs),
    greenAfterFirst: after.length ? count('green', after) / after.length : 0,
    green: count('green'),
    amber: count('amber'),
    red: count('red'),
    sealCostMs: +(running?.seal.costMs ?? 0).toFixed(3),
    verifyCostMs: +(running?.verify.costMs ?? 0).toFixed(3),
    meanAmplitude: [0, 1, 2].map((i) => +(reports.filter((x) => x.amplitude.length).reduce((a, x) => a + x.amplitude[i], 0) / Math.max(1, reports.filter((x) => x.amplitude.length).length)).toFixed(2)),
  };
}

if (params.get('auto') === '1') void autoRun();
