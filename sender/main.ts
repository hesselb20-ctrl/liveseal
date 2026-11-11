// LiveSeal Camera: seals the webcam and shows the sealed picture, ready to be
// picked up by a virtual camera. No network requests are made by this page
// apart from loading its own files.

import { SEAL_AMPLITUDE, SEAL_AMPLITUDE_LIGHT } from '../core/src/session.ts';
import { challengeToWords, suggestWord, wordsToChallenge } from '../core/src/words.ts';
import { mountContacts } from '../shared/contacts-ui.ts';
import { cameraSource, fileSource, type VideoSource } from '../shared/demo-source.ts';
import { loadFaceDetector } from '../shared/face.ts';
import { SealPipeline } from '../shared/pipelines.ts';
import { createIdentity, deleteIdentity, loadDirectory, loadIdentity, saveDirectory, type Identity } from '../shared/store.ts';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const params = new URLSearchParams(location.search);

let identity: Identity | null = null;
let source: VideoSource | null = null;
let pipeline: SealPipeline | null = null;

function amplitude(): ArrayLike<number> {
  return $<HTMLSelectElement>('strength').value === 'light' ? SEAL_AMPLITUDE_LIGHT : SEAL_AMPLITUDE;
}

async function showApp(): Promise<void> {
  identity = await loadIdentity();
  $('welcome').classList.toggle('hidden', !!identity);
  $('app').classList.toggle('hidden', !identity);
  if (!identity) return;
  const directory = await loadDirectory();
  mountContacts($('contacts'), {
    identity,
    directory,
    onChange: () => saveDirectory(directory),
    onRevokeSelf: async () => {
      stopCamera();
      await deleteIdentity();
      await showApp();
    },
  });
}

function stopCamera(): void {
  pipeline?.stop();
  pipeline = null;
  source?.stop();
  source = null;
  $('state').textContent = 'Camera off';
  $('camera').textContent = 'Turn camera on';
}

async function startCamera(): Promise<void> {
  if (!identity) return;
  if (pipeline) { stopCamera(); return; }
  try {
    const url = params.get('source'); // development aid: use a video file in place of the camera
    source = url ? await fileSource(url) : await cameraSource();
  } catch {
    $('status').textContent = 'The camera could not be opened. Check that this page is allowed to use it.';
    return;
  }
  const detector = await loadFaceDetector(new URL('../vendor/mediapipe', location.href).href.replace(/\/$/, ''));
  pipeline = new SealPipeline({
    signer: identity.signer,
    source: source.video,
    output: $<HTMLCanvasElement>('out'),
    amplitude: amplitude(),
    detectFace: detector ?? undefined,
  });
  pipeline.enabled = $<HTMLSelectElement>('strength').value !== 'off';
  pipeline.start();
  $('camera').textContent = 'Turn camera off';
  $('state').textContent = pipeline.enabled ? `Sealing as ${identity.name}` : 'Seal off';
  $('status').textContent = detector
    ? 'Sealing is on. Your face position is tracked on this device to tie the seal to your picture.'
    : 'Sealing is on. Face tracking is not available here, so the seal is tied to the middle of the picture.';
  try {
    await (navigator as Navigator & { wakeLock?: { request(type: 'screen'): Promise<unknown> } }).wakeLock?.request('screen');
  } catch {
    // not essential
  }
}

$('create').addEventListener('click', async () => {
  const name = $<HTMLInputElement>('name').value.trim();
  if (!name) { $<HTMLInputElement>('name').focus(); return; }
  await createIdentity(name);
  await showApp();
});
$('camera').addEventListener('click', () => void startCamera());
$('clean').addEventListener('click', () => void $('stage').requestFullscreen?.());
$('strength').addEventListener('change', () => {
  if (!pipeline || !identity) return;
  const off = $<HTMLSelectElement>('strength').value === 'off';
  pipeline.enabled = !off;
  pipeline.session.setAmplitude(amplitude());
  $('state').textContent = off ? 'Seal off' : `Sealing as ${identity.name}`;
});
$('answer').addEventListener('click', () => {
  const text = $<HTMLInputElement>('words').value;
  const challenge = wordsToChallenge(text);
  if (!challenge) {
    const hints = text.toLowerCase().split(/[^a-z]+/).filter(Boolean).map((w) => suggestWord(w) ?? '?');
    $('answering').textContent = hints.length === 3 && !hints.includes('?')
      ? `Did you mean: ${hints.join(' ')}?`
      : 'Type exactly three words. Ask the other person to read them again.';
    return;
  }
  pipeline?.session.answerChallenge(challenge);
  $('answering').textContent = pipeline
    ? `Answering "${challengeToWords(challenge)}". Their screen should turn green within a few seconds.`
    : 'Turn the camera on first.';
});
$('clear').addEventListener('click', () => {
  pipeline?.session.answerChallenge(null);
  $<HTMLInputElement>('words').value = '';
  $('answering').textContent = '';
});

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  void navigator.serviceWorker.register(new URL('../sw.js', location.href)).catch(() => undefined);
}
void showApp().then(() => { if (params.get('autostart') === '1') void startCamera(); });
