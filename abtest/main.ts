// Blind A/B test for visibility: the same picture twice, one sealed, in a
// random order. The viewer says which one is sealed.

import { createSigner } from '../core/src/crypto.ts';
import { makeLayout } from '../core/src/modem.ts';
import { SEAL_AMPLITUDE, SEAL_AMPLITUDE_LIGHT } from '../core/src/session.ts';
import { cameraSource, drawnSource, type VideoSource } from '../shared/demo-source.ts';
import { GlSealer } from '../shared/gl-sealer.ts';
import { LoopbackCall, availableCodecs } from '../shared/loopback.ts';
import { SealPipeline } from '../shared/pipelines.ts';

const ROUNDS = 20;
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

interface Answer {
  round: number;
  sealedWas: 'A' | 'B';
  picked: 'A' | 'B';
  correct: boolean;
  seconds: number;
}

let source: VideoSource | null = null;
let seal: SealPipeline | null = null;
const calls = [new LoopbackCall(), new LoopbackCall()];
let answers: Answer[] = [];
let sealedSide: 'A' | 'B' = 'A';
let shownAt = 0;
let sealedStream: MediaStream | null = null;
let plainStream: MediaStream | null = null;

async function begin(): Promise<void> {
  seal?.stop();
  source?.stop();
  calls.forEach((c) => c.stop());
  answers = [];
  $('result').classList.add('hidden');
  try {
    source = $<HTMLSelectElement>('source').value === 'camera' ? await cameraSource() : await drawnSource(0);
  } catch {
    $('progress').textContent = 'The camera could not be opened. Try the drawn stand-in.';
    return;
  }
  const signer = (await createSigner()).signer;
  const sealedCanvas = document.createElement('canvas');
  const plainCanvas = document.createElement('canvas');
  const amplitude = $<HTMLSelectElement>('strength').value === 'light' ? SEAL_AMPLITUDE_LIGHT : SEAL_AMPLITUDE;
  seal = new SealPipeline({ signer, source: source.video, output: sealedCanvas, amplitude });
  // the unsealed copy goes through the very same shader with the seal switched off
  const plain = new GlSealer(makeLayout(), plainCanvas);
  seal.tap = (_now, _luma, field, frame) => {
    const v = (source as VideoSource).video;
    plain.draw(v, v.videoWidth, v.videoHeight, field, frame, false);
  };
  seal.start();
  await new Promise<void>((resolve) => {
    const wait = () => ((seal as SealPipeline).frames > 2 ? resolve() : setTimeout(wait, 30));
    wait();
  });
  sealedStream = sealedCanvas.captureStream(30);
  plainStream = plainCanvas.captureStream(30);
  if ($<HTMLSelectElement>('path').value === 'call') {
    const codec = availableCodecs()[0];
    sealedStream = await calls[0].start(sealedStream.getVideoTracks()[0], codec, 600);
    plainStream = await calls[1].start(plainStream.getVideoTracks()[0], codec, 600);
  }
  await nextRound();
}

async function nextRound(): Promise<void> {
  if (answers.length >= ROUNDS) { finish(); return; }
  sealedSide = crypto.getRandomValues(new Uint8Array(1))[0] & 1 ? 'A' : 'B';
  $<HTMLVideoElement>('a').srcObject = sealedSide === 'A' ? sealedStream : plainStream;
  $<HTMLVideoElement>('b').srcObject = sealedSide === 'B' ? sealedStream : plainStream;
  await Promise.all([$<HTMLVideoElement>('a').play(), $<HTMLVideoElement>('b').play()]);
  shownAt = performance.now();
  $<HTMLButtonElement>('pick-a').disabled = false;
  $<HTMLButtonElement>('pick-b').disabled = false;
  $('progress').textContent = `Round ${answers.length + 1} of ${ROUNDS}. Take as long as you like.`;
}

function pick(side: 'A' | 'B'): void {
  answers.push({ round: answers.length + 1, sealedWas: sealedSide, picked: side, correct: side === sealedSide, seconds: +((performance.now() - shownAt) / 1000).toFixed(1) });
  $<HTMLButtonElement>('pick-a').disabled = true;
  $<HTMLButtonElement>('pick-b').disabled = true;
  void nextRound();
}

/** Probability of at least `k` correct out of `n` by guessing. */
function chance(n: number, k: number): number {
  let p = 0;
  let c = 1;
  for (let i = 0; i <= n; i++) {
    if (i >= k) p += c / 2 ** n;
    c = (c * (n - i)) / (i + 1);
  }
  return p;
}

function finish(): void {
  const right = answers.filter((a) => a.correct).length;
  const share = Math.round((100 * right) / answers.length);
  $('score').textContent = `${right} of ${answers.length} right (${share}%)`;
  const p = chance(answers.length, right);
  $('meaning').textContent = p < 0.05
    ? `Guessing alone gets this many right only ${(p * 100).toFixed(1)}% of the time, so you can probably see the seal under these conditions.`
    : `Guessing alone gets at least this many right ${(p * 100).toFixed(0)}% of the time, so this does not show that you can see the seal.`;
  $('result').classList.remove('hidden');
  $('progress').textContent = 'Finished.';
}

$('start').addEventListener('click', () => void begin());
$('again').addEventListener('click', () => void begin());
$('pick-a').addEventListener('click', () => pick('A'));
$('pick-b').addEventListener('click', () => pick('B'));
$('download').addEventListener('click', () => {
  const data = {
    test: 'liveseal-ab-1',
    when: new Date().toISOString(),
    picture: $<HTMLSelectElement>('source').value,
    shown: $<HTMLSelectElement>('path').value,
    seal: $<HTMLSelectElement>('strength').value,
    screen: `${screen.width}x${screen.height}@${devicePixelRatio}`,
    answers,
  };
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  a.download = 'liveseal-ab-result.json';
  a.click();
});
