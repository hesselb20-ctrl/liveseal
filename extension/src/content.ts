// Content script (isolated world). Two jobs:
//
//  1. Sender. When the page asks for the camera (through the shim in
//     inject.ts) this script opens the camera itself, seals the picture and
//     offers the sealed picture back. Frames, digests and statements stay in
//     this world; the page's own scripts cannot reach them.
//
//  2. Verifier. Every sizeable <video> that shows a media stream is checked,
//     and a badge is placed on its tile.

import { equalBytes, fromBase64Url, toBase64Url } from '../../core/src/bytes.ts';
import { keyIdOf, randomBytes, type Signer } from '../../core/src/crypto.ts';
import { KeyDirectory } from '../../core/src/directory.ts';
import { SEAL_AMPLITUDE, SEAL_AMPLITUDE_LIGHT, type PeriodReport, type SenderSession } from '../../core/src/session.ts';
import type { Badge, BadgeContext } from '../../core/src/verify.ts';
import { challengeToWords } from '../../core/src/words.ts';
import { BADGE_CSS, createBadge, type BadgeView } from '../../shared/badge.ts';
import { TrackSealer, supportsInsertableStreams } from '../../shared/insertable.ts';
import { SealPipeline, VerifyPipeline } from '../../shared/pipelines.ts';
import { WorkerVerifier, type Verifier } from '../../shared/worker-pipeline.ts';
import {
  EV_APPLY, EV_REQUEST, EV_RESPONSE, EV_STOP, type CameraRequest, type CameraResponse, type Request, type StateReply,
} from './messages.ts';

function send<T>(req: Request): Promise<T> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(req, (r: { ok: boolean; value?: T; error?: string } | undefined) => {
      if (r?.ok) resolve(r.value as T);
      else reject(new Error(r?.error ?? chrome.runtime.lastError?.message ?? 'no reply'));
    });
  });
}

const directory = new KeyDirectory();
let state: StateReply | null = null;
let myKeyId: Uint8Array | null = null;

async function loadState(): Promise<void> {
  state = await send<StateReply>({ type: 'state' });
  directory.assign(await KeyDirectory.fromJSON(state.directory));
  myKeyId = state.identity ? await keyIdOf(fromBase64Url(state.identity.publicKey)) : null;
  for (const tile of tiles.values()) tile.updateDirectory();
}
const loaded = loadState().catch(() => undefined);
chrome.storage.onChanged.addListener(() => void loadState().catch(() => undefined));

// ------------------------------------------------------------------ sender

interface Camera {
  session: SenderSession;
  stream: MediaStream;
  stop(): void;
  setEnabled(on: boolean): void;
}
const cameras = new Map<string, Camera>();

/** Signs through the background page, where the private key lives. */
function remoteSigner(publicKey: Uint8Array): Signer {
  return {
    publicKey,
    software: false,
    async sign(message) {
      const r = await send<{ signature: string }>({ type: 'sign', data: toBase64Url(message) });
      return fromBase64Url(r.signature);
    },
  };
}

function hide(el: HTMLElement): void {
  el.dataset.liveseal = '1';
  el.setAttribute('aria-hidden', 'true');
  // kept in the page as a two-pixel element: browsers stop delivering frames for elements that are not painted
  Object.assign(el.style, { position: 'fixed', left: '0', bottom: '0', width: '2px', height: '2px', opacity: '0.01', pointerEvents: 'none', zIndex: '-1' });
}

window.addEventListener(EV_REQUEST, (e) => {
  let req: CameraRequest;
  try {
    req = JSON.parse((e as CustomEvent<string>).detail) as CameraRequest;
  } catch {
    return;
  }
  const reply = (r: CameraResponse) => window.dispatchEvent(new CustomEvent(EV_RESPONSE, { detail: JSON.stringify(r) }));
  void (async () => {
    await loaded;
    if (!state?.identity || !state.settings.seal) { reply({ id: req.id, ok: false }); return; }
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: req.video, audio: false });
    } catch {
      reply({ id: req.id, ok: false }); // the page's own request will surface the permission error
      return;
    }
    const track = stream.getVideoTracks()[0];
    const signer = remoteSigner(fromBase64Url(state.identity.publicKey));
    const amplitude = state.settings.strength === 'light' ? SEAL_AMPLITUDE_LIGHT : SEAL_AMPLITUDE;
    const base: CameraResponse = { id: req.id, ok: true, element: req.id, label: track.label, settings: track.getSettings() };
    try {
      if (supportsInsertableStreams()) {
        const sealer = new TrackSealer(track, signer, amplitude);
        const carrier = document.createElement('video');
        carrier.id = req.id;
        carrier.muted = true;
        carrier.srcObject = new MediaStream([sealer.track]);
        hide(carrier);
        document.documentElement.append(carrier);
        void carrier.play().catch(() => undefined);
        cameras.set(req.id, {
          session: sealer.session, stream,
          stop: () => { sealer.stop(); stream.getTracks().forEach((t) => t.stop()); carrier.remove(); },
          setEnabled: (on) => { sealer.enabled = on; },
        });
        reply({ ...base, stream: true });
      } else {
        const source = document.createElement('video');
        source.muted = true;
        source.playsInline = true;
        source.srcObject = stream;
        hide(source);
        const canvas = document.createElement('canvas');
        canvas.id = req.id;
        hide(canvas);
        document.documentElement.append(source, canvas);
        await source.play();
        const pipeline = new SealPipeline({ signer, source, output: canvas, amplitude });
        pipeline.start();
        await new Promise<void>((resolve) => {
          const wait = () => (pipeline.frames > 1 ? resolve() : setTimeout(wait, 30));
          wait();
        });
        cameras.set(req.id, {
          session: pipeline.session, stream,
          stop: () => { pipeline.stop(); stream.getTracks().forEach((t) => t.stop()); source.remove(); canvas.remove(); },
          setEnabled: (on) => { pipeline.enabled = on; },
        });
        reply({ ...base, stream: false });
      }
    } catch {
      stream.getTracks().forEach((t) => t.stop());
      reply({ id: req.id, ok: false });
    }
  })();
});

window.addEventListener(EV_STOP, (e) => {
  try {
    const { id } = JSON.parse((e as CustomEvent<string>).detail) as { id: string };
    cameras.get(id)?.stop();
    cameras.delete(id);
  } catch {
    // ignore
  }
});

window.addEventListener(EV_APPLY, (e) => {
  try {
    const { id, constraints } = JSON.parse((e as CustomEvent<string>).detail) as { id: string; constraints: MediaTrackConstraints };
    void cameras.get(id)?.stream.getVideoTracks()[0]?.applyConstraints(constraints).catch(() => undefined);
  } catch {
    // ignore
  }
});

// ---------------------------------------------------------------- verifier

const host = document.createElement('div');
host.dataset.liveseal = '1';
Object.assign(host.style, { position: 'fixed', inset: '0', pointerEvents: 'none', zIndex: '2147483647' });
const shadow = host.attachShadow({ mode: 'closed' });
shadow.append(Object.assign(document.createElement('style'), {
  textContent: BADGE_CSS + `
.tile{position:absolute;left:0;top:0;pointer-events:auto;display:flex;flex-direction:column;gap:6px;align-items:flex-start}
.ls-badge{cursor:pointer}
.menu{background:rgba(22,24,28,.96);color:#fff;border-radius:14px;padding:10px;font:14px/1.35 system-ui,sans-serif;display:flex;flex-direction:column;gap:8px;max-width:300px}
.menu button,.menu select{font:inherit;color:#fff;background:#33363d;border:1px solid #555;border-radius:999px;padding:7px 12px;cursor:pointer}
.menu .words{font-weight:650;font-size:18px}
.menu[hidden]{display:none}
.own{font:600 12px/1 system-ui,sans-serif;color:#fff;background:rgba(0,0,0,.55);padding:6px 9px;border-radius:999px}`,
}));

/** Looks for a contact's name in the labels around a tile. Only used to make warnings louder. */
function guessName(video: HTMLVideoElement): string | null {
  const names = [...new Set(directory.list().filter((k) => k.revokedAt === undefined).map((k) => k.name))];
  if (names.length === 0) return null;
  let node: Element | null = video;
  for (let depth = 0; node && depth < 5; depth++, node = node.parentElement) {
    const texts: string[] = [node.getAttribute('aria-label') ?? '', node.getAttribute('data-participant-name') ?? ''];
    if (depth > 0 && (node.textContent?.length ?? 0) < 200) texts.push(node.textContent ?? '');
    const hay = texts.join(' ').toLowerCase();
    for (const name of names) {
      if (new RegExp(`(^|[^a-z0-9])${name.toLowerCase().replace(/[^a-z0-9 ]/g, '.')}([^a-z0-9]|$)`).test(hay)) return name;
    }
  }
  return null;
}

class InThreadVerifier implements Verifier {
  private readonly pipeline: VerifyPipeline;
  constructor(video: HTMLVideoElement, onReport: (r: PeriodReport) => void) {
    this.pipeline = new VerifyPipeline({ video, directory, onReport });
  }
  get badge(): Badge | null { return this.pipeline.session.badge; }
  start(): void { this.pipeline.start(); }
  stop(): void { this.pipeline.stop(); }
  setChallenge(c: Uint8Array | null): void { this.pipeline.session.checker.setChallenge(c); }
  getChallenge(): Uint8Array | null { return this.pipeline.session.checker.getChallenge(); }
  setContext(c: BadgeContext): void { this.pipeline.session.setContext(c); }
}

let workerUrl: string | null | undefined;

class Tile {
  private verifier: Verifier | null = null;
  private removed = false;
  private readonly view: BadgeView = createBadge(true);
  private readonly box = document.createElement('div');
  private readonly menu = document.createElement('div');
  private readonly own = document.createElement('span');
  private sawGreen: string | null = null;
  private expected: string | null = null;
  private reports = 0;
  readonly video: HTMLVideoElement;

  constructor(video: HTMLVideoElement) {
    this.video = video;
    this.box.className = 'tile';
    this.menu.className = 'menu';
    this.menu.hidden = true;
    this.own.className = 'own';
    this.own.hidden = true;
    this.box.append(this.menu, this.view.element, this.own);
    shadow.append(this.box);
    this.view.update({ level: 'amber', code: 'idle', title: 'Checking', detail: 'Looking for a seal.', strong: false });
    this.view.element.addEventListener('click', () => this.toggleMenu());
    this.view.element.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this.toggleMenu(); } });
    void this.begin();
  }

  /** Verification runs in a worker when the page allows one, otherwise on the page's own thread. */
  private async begin(): Promise<void> {
    let verifier: Verifier | null = null;
    try {
      if (workerUrl === undefined) {
        const text = await (await fetch(chrome.runtime.getURL('verify-worker.js'))).text();
        workerUrl = URL.createObjectURL(new Blob([text], { type: 'text/javascript' }));
      }
      if (workerUrl) {
        const candidate = new WorkerVerifier(new Worker(workerUrl), this.video, directory.toJSON(), (r) => this.onReport(r));
        if (await candidate.whenReady(2500)) verifier = candidate;
        else { candidate.stop(); workerUrl = null; } // a strict page policy blocks the worker; do not try again here
      }
    } catch {
      workerUrl = null;
    }
    if (this.removed) { verifier?.stop(); return; }
    this.verifier = verifier ?? new InThreadVerifier(this.video, (r) => this.onReport(r));
    this.applyExpected(guessName(this.video));
    this.verifier.start();
  }

  updateDirectory(): void {
    if (this.verifier instanceof WorkerVerifier) this.verifier.updateDirectory(directory.toJSON());
    if (!this.expected) this.applyExpected(guessName(this.video));
  }

  private applyExpected(name: string | null): void {
    this.expected = name;
    this.verifier?.setContext(name ? { expectedName: name, expectedUsuallySeals: directory.usuallySeals(name) } : {});
  }

  private onReport(r: PeriodReport): void {
    this.reports++;
    // our own sealed preview: say so quietly instead of warning about an unknown key
    if (r.outcome.code === 'unknown-key' && myKeyId && equalBytes(r.outcome.keyId, myKeyId)) {
      this.view.element.hidden = true;
      this.own.hidden = false;
      this.own.textContent = `Your picture is sealed as ${state?.identity?.name ?? 'you'}`;
      return;
    }
    this.own.hidden = true;
    this.view.element.hidden = false;
    this.view.update(r.badge);
    if (r.badge.level === 'green' && r.badge.identity) this.sawGreen = r.badge.identity.name;
    // a verified caller asked us to verify too: answer in our own seal
    if (r.peerChallenge) for (const cam of cameras.values()) cam.session.answerChallenge(r.peerChallenge);
  }

  private toggleMenu(): void {
    this.menu.hidden = !this.menu.hidden;
    if (this.menu.hidden) return;
    this.menu.replaceChildren();
    const verify = Object.assign(document.createElement('button'), { textContent: 'Verify with a code' });
    const words = Object.assign(document.createElement('div'), { className: 'words' });
    const current = this.verifier?.getChallenge() ?? null;
    if (current) words.textContent = challengeToWords(current);
    const help = document.createElement('div');
    verify.addEventListener('click', () => {
      let challenge = randomBytes(3);
      while (challenge.every((b) => b === 0)) challenge = randomBytes(3);
      this.verifier?.setChallenge(challenge);
      // if the caller also runs LiveSeal, their side reads this from our seal and answers by itself
      for (const cam of cameras.values()) cam.session.issueChallenge(challenge);
      words.textContent = challengeToWords(challenge);
      help.textContent = 'Ask the caller to type these words into LiveSeal. If they use the extension and your camera is on, it happens by itself.';
    });
    const who = document.createElement('select');
    who.setAttribute('aria-label', 'Who should this be?');
    who.add(new Option('Who should this be? Not sure', ''));
    for (const name of new Set(directory.list().filter((k) => k.revokedAt === undefined).map((k) => k.name))) who.add(new Option(name, name));
    who.value = this.expected ?? '';
    who.addEventListener('change', () => this.applyExpected(who.value || null));
    const close = Object.assign(document.createElement('button'), { textContent: 'Close' });
    close.addEventListener('click', () => { this.menu.hidden = true; });
    this.menu.append(verify, words, help, who, close);
  }

  place(): void {
    const r = this.video.getBoundingClientRect();
    const visible = r.width >= 150 && r.height >= 90 && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth;
    this.box.style.display = visible ? 'flex' : 'none';
    if (!visible) return;
    const h = this.box.offsetHeight;
    this.box.style.transform = `translate(${Math.max(4, r.left + 8)}px, ${Math.max(4, Math.min(innerHeight - h - 4, r.bottom - h - 8))}px)`;
    this.box.style.maxWidth = `${Math.max(140, r.width - 16)}px`;
  }

  remove(): void {
    this.removed = true;
    this.verifier?.stop();
    this.box.remove();
    // remember whether this person's call was sealed, for the "usually verifies" warning
    if (this.sawGreen) void send({ type: 'record-call', name: this.sawGreen, sealed: true }).catch(() => undefined);
    else if (this.expected && this.reports >= 5) void send({ type: 'record-call', name: this.expected, sealed: false }).catch(() => undefined);
  }
}

const tiles = new Map<HTMLVideoElement, Tile>();

function scan(): void {
  if (!state?.settings.verify) {
    for (const t of tiles.values()) t.remove();
    tiles.clear();
    return;
  }
  for (const [video, tile] of tiles) {
    if (!video.isConnected || !(video.srcObject instanceof MediaStream)) {
      tile.remove();
      tiles.delete(video);
    }
  }
  const candidates = [...document.querySelectorAll('video')].filter((v) =>
    !tiles.has(v) && !v.dataset.liveseal && v.srcObject instanceof MediaStream && v.readyState >= 2 && v.videoWidth >= 160);
  // the largest tiles first, at most four at a time
  candidates.sort((a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight);
  for (const v of candidates) {
    if (tiles.size >= 4) break;
    tiles.set(v, new Tile(v));
  }
  if (tiles.size > 0 && !host.isConnected) document.documentElement.append(host);
}

void loaded.then(() => {
  setInterval(scan, 1500);
  setInterval(() => { for (const t of tiles.values()) t.place(); }, 300);
  addEventListener('pagehide', () => { for (const t of tiles.values()) t.remove(); for (const c of cameras.values()) c.stop(); });
});
