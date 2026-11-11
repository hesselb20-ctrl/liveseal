// "Verify a screen": checks the seal in whatever this device can see, either
// through its camera (phone mode) or through a captured window.

import { randomBytes } from '../core/src/crypto.ts';
import type { PeriodReport } from '../core/src/session.ts';
import { challengeToWords } from '../core/src/words.ts';
import { BADGE_CSS, createBadge } from '../shared/badge.ts';
import { mountContacts } from '../shared/contacts-ui.ts';
import { FULL_FRAME, VerifyPipeline, type Quad } from '../shared/pipelines.ts';
import { loadDirectory, loadIdentity, refreshOrganisations, saveDirectory } from '../shared/store.ts';

const $ = <T extends Element>(id: string) => document.getElementById(id) as unknown as T;
document.head.append(Object.assign(document.createElement('style'), { textContent: BADGE_CSS }));

const view = $<HTMLVideoElement>('view');
const quadSvg = $<SVGSVGElement>('quad');
const polygon = quadSvg.querySelector('polygon') as SVGPolygonElement;
const handles = [...quadSvg.querySelectorAll('circle')] as SVGCircleElement[];
const badge = createBadge();
$<HTMLElement>('badge-slot').append(badge.element);

let quad: Quad = FULL_FRAME.map((p) => [...p]) as Quad;
let pipeline: VerifyPipeline | null = null;
let stream: MediaStream | null = null;
let sawGreen: string | null = null;
const directory = await loadDirectory();
const identity = await loadIdentity();
void refreshOrganisations(directory).then(() => saveDirectory(directory));

function drawQuad(): void {
  polygon.setAttribute('points', quad.map(([x, y]) => `${x * 100},${y * 100}`).join(' '));
  handles.forEach((h, i) => {
    h.setAttribute('cx', String(quad[i][0] * 100));
    h.setAttribute('cy', String(quad[i][1] * 100));
    h.setAttribute('aria-valuetext', `${Math.round(quad[i][0] * 100)}% across, ${Math.round(quad[i][1] * 100)}% down`);
  });
}

handles.forEach((handle, i) => {
  const move = (x: number, y: number) => {
    quad[i] = [Math.max(0, Math.min(1, x)), Math.max(0, Math.min(1, y))];
    drawQuad();
  };
  handle.addEventListener('pointerdown', (e) => {
    handle.setPointerCapture(e.pointerId);
    const drag = (ev: PointerEvent) => {
      const r = quadSvg.getBoundingClientRect();
      move((ev.clientX - r.left) / r.width, (ev.clientY - r.top) / r.height);
    };
    handle.addEventListener('pointermove', drag);
    handle.addEventListener('pointerup', () => handle.removeEventListener('pointermove', drag), { once: true });
  });
  handle.addEventListener('keydown', (e) => {
    const step = e.shiftKey ? 0.02 : 0.005;
    const d: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    const delta = d[e.key];
    if (!delta) return;
    e.preventDefault();
    move(quad[i][0] + delta[0], quad[i][1] + delta[1]);
  });
});

function fillExpected(): void {
  const select = $<HTMLSelectElement>('expected');
  const current = select.value;
  select.replaceChildren(new Option('I am not sure', ''));
  for (const name of new Set(directory.list().filter((k) => k.revokedAt === undefined).map((k) => k.name))) select.add(new Option(name, name));
  select.value = current;
}

function applyExpected(): void {
  const name = $<HTMLSelectElement>('expected').value;
  pipeline?.session.setContext(name ? { expectedName: name, expectedUsuallySeals: directory.usuallySeals(name) } : {});
}

function onReport(r: PeriodReport): void {
  badge.update(r.badge);
  if (r.badge.level === 'green' && r.badge.identity) sawGreen = r.badge.identity.name;
  const log = $<HTMLElement>('log');
  if (log.querySelector('td[colspan]')) log.replaceChildren();
  const row = document.createElement('tr');
  const seal = r.amplitude.length ? r.amplitude.map((a) => a.toFixed(1)).join(' / ') : 'none';
  for (const text of [new Date().toLocaleTimeString(), r.badge.title, seal]) row.append(Object.assign(document.createElement('td'), { textContent: text }));
  log.prepend(row);
  while (log.children.length > 10) log.lastElementChild?.remove();
}

async function begin(kind: 'camera' | 'screen'): Promise<void> {
  await end();
  try {
    stream = kind === 'camera'
      ? await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } }, audio: false })
      : await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 30 } }, audio: false });
  } catch {
    $<HTMLElement>('hint').textContent = kind === 'camera' ? 'The camera could not be opened.' : 'No window was chosen.';
    return;
  }
  view.srcObject = stream;
  await view.play();
  quadSvg.classList.remove('hidden');
  if (kind === 'camera') quad = [[0.12, 0.12], [0.88, 0.12], [0.88, 0.88], [0.12, 0.88]];
  else quad = FULL_FRAME.map((p) => [...p]) as Quad;
  drawQuad();
  sawGreen = null;
  pipeline = new VerifyPipeline({ video: view, directory, onReport, region: () => quad });
  applyExpected();
  pipeline.start();
  $<HTMLButtonElement>('stop').disabled = false;
  $<HTMLElement>('hint').textContent = kind === 'camera'
    ? 'Drag the four corners onto the corners of the caller\'s picture. Keep this device still; a stand helps.'
    : 'Drag the corners so the box covers only the caller\'s picture, not the whole window.';
  stream.getVideoTracks()[0].addEventListener('ended', () => void end());
}

async function end(): Promise<void> {
  if (!pipeline) return;
  pipeline.stop();
  pipeline = null;
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  view.srcObject = null;
  $<HTMLButtonElement>('stop').disabled = true;
  // remember whether this person's call was sealed, for the "usually verifies" warning
  const expected = $<HTMLSelectElement>('expected').value;
  if (sawGreen) directory.recordCall(sawGreen, true);
  else if (expected) directory.recordCall(expected, false);
  await saveDirectory(directory);
}

$<HTMLElement>('use-camera').addEventListener('click', () => void begin('camera'));
$<HTMLElement>('use-screen').addEventListener('click', () => void begin('screen'));
$<HTMLElement>('stop').addEventListener('click', () => void end());
$<HTMLElement>('whole').addEventListener('click', () => { quad = FULL_FRAME.map((p) => [...p]) as Quad; drawQuad(); });
$<HTMLElement>('expected').addEventListener('change', applyExpected);
$<HTMLElement>('verify').addEventListener('click', () => {
  if (!pipeline) { $<HTMLElement>('words-help').textContent = 'Start checking a picture first.'; return; }
  let challenge = randomBytes(3);
  while (challenge.every((b) => b === 0)) challenge = randomBytes(3);
  pipeline.session.checker.setChallenge(challenge);
  $<HTMLElement>('words').textContent = challengeToWords(challenge);
  $<HTMLElement>('words-help').textContent = 'Read these three words to the caller and ask them to type the words into LiveSeal. The badge turns green only for seals made after they did.';
});
$<HTMLElement>('clear-code').addEventListener('click', () => {
  pipeline?.session.checker.setChallenge(null);
  $<HTMLElement>('words').textContent = '';
  $<HTMLElement>('words-help').textContent = '';
});

mountContacts($<HTMLElement>('contacts'), {
  identity,
  directory,
  onChange: async () => { await saveDirectory(directory); fillExpected(); },
});
fillExpected();
drawQuad();
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  void navigator.serviceWorker.register(new URL('../sw.js', location.href)).catch(() => undefined);
}
