// Demo bank page: shows the organisation flow end to end. The page fetches
// the bank's published key file exactly as a verifier would, then plays a
// sealed call from the bank's agent through a loop-back call.

import { fromBase64Url } from '../core/src/bytes.ts';
import { createSigner, fingerprintOf, type Signer } from '../core/src/crypto.ts';
import { KeyDirectory } from '../core/src/directory.ts';
import { BADGE_CSS, createBadge } from '../shared/badge.ts';
import { drawnSource, fileSource, type VideoSource } from '../shared/demo-source.ts';
import { LoopbackCall, availableCodecs } from '../shared/loopback.ts';
import { SealPipeline, VerifyPipeline } from '../shared/pipelines.ts';
import { fetchOrganisation } from '../shared/store.ts';
import { demoSigner } from './keys.ts';

type Who = 'agent' | 'stolen' | 'fake' | 'none';

const EXPLAIN: Record<Who, string> = {
  agent: 'The agent\'s key is listed in the bank\'s key file and signed by the bank. Your screen names the bank\'s web address, not whatever the caller typed as a name.',
  stolen: 'This key was the bank\'s, but the bank listed it as revoked after a laptop was stolen. The seal is technically valid and still gets a warning.',
  fake: 'Anyone can make a key and call themselves "Demo Bank". The key is not in the bank\'s file, so the call is not verified, and because you added the bank you are told that the bank normally seals.',
  none: 'A deepfake caller has no key at all. Because you added the bank, a missing seal is flagged instead of quietly ignored.',
};

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
document.head.append(Object.assign(document.createElement('style'), { textContent: BADGE_CSS }));
const badge = createBadge();
$('badge-slot').append(badge.element);

const base = new URL('.', location.href).href.replace(/\/$/, '');
const directory = new KeyDirectory();
let locator = '';
let source: VideoSource | null = null;
let seal: SealPipeline | null = null;
let verify: VerifyPipeline | null = null;
const call = new LoopbackCall();

async function showKeys(): Promise<void> {
  $<HTMLAnchorElement>('key-link').textContent = `${base.replace(/^https?:\/\//, '')}/.well-known/liveseal.json`;
  try {
    const file = await (await fetch('./.well-known/liveseal.json', { cache: 'no-store' })).json();
    const rows: HTMLTableRowElement[] = [];
    const add = async (key: string, use: string, status: string, cls: string) => {
      const tr = document.createElement('tr');
      const pill = Object.assign(document.createElement('span'), { className: `pill ${cls}`, textContent: status });
      const st = document.createElement('td');
      st.append(pill);
      tr.append(
        Object.assign(document.createElement('td'), { className: 'mono', textContent: (await fingerprintOf(fromBase64Url(key))).slice(0, 19) + '…' }),
        Object.assign(document.createElement('td'), { textContent: use }),
        st,
      );
      rows.push(tr);
    };
    for (const k of file.keys) await add(k.publicKey, k.label ?? 'Main key', 'active', 'ok');
    for (const k of file.subKeys ?? []) await add(k.publicKey, `${k.label} (signed by the main key)`, 'active', 'ok');
    for (const k of file.revoked ?? []) await add(k.publicKey, k.reason ?? 'Revoked', 'revoked', 'bad');
    $('keys').replaceChildren(...rows);
  } catch {
    $('keys').replaceChildren(Object.assign(document.createElement('tr'), { innerHTML: '<td colspan="3">The key file could not be loaded.</td>' }));
  }
}

async function signerFor(who: Who): Promise<Signer | null> {
  if (who === 'agent') return demoSigner('agent');
  if (who === 'stolen') return demoSigner('stolen');
  if (who === 'fake') return (await createSigner()).signer;
  return null;
}

async function startCall(who: Who): Promise<void> {
  seal?.stop();
  verify?.stop();
  call.stop();
  source?.stop();
  const dev = new URLSearchParams(location.search).get('source');
  source = dev ? await fileSource(dev) : await drawnSource(who === 'agent' ? 0 : 1);
  const signer = (await signerFor(who)) ?? (await createSigner()).signer;
  seal = new SealPipeline({ signer, source: source.video, output: $<HTMLCanvasElement>('sent') });
  seal.enabled = who !== 'none';
  seal.start();
  await new Promise<void>((resolve) => {
    const wait = () => ((seal as SealPipeline).frames > 2 ? resolve() : setTimeout(wait, 30));
    wait();
  });
  const track = $<HTMLCanvasElement>('sent').captureStream(30).getVideoTracks()[0];
  const codec = availableCodecs()[0];
  const remote = await call.start(track, codec, 600);
  const received = $<HTMLVideoElement>('received');
  received.srcObject = remote;
  await received.play();
  verify = new VerifyPipeline({ video: received, directory, onReport: (r) => badge.update(r.badge) });
  // the caller claims to be the bank; that claim is only used to make warnings louder
  if (locator) verify.session.setContext({ expectedName: locator, expectedUsuallySeals: directory.usuallySeals(locator) });
  badge.update(verify.session.badge);
  verify.start();
  $('explain').textContent = EXPLAIN[who] + (locator ? '' : ' (You have not added the bank yet, so nothing can be verified.)');
  for (const b of document.querySelectorAll<HTMLButtonElement>('#callers button')) b.setAttribute('aria-pressed', String(b.dataset.who === who));
}

$('add').addEventListener('click', async () => {
  try {
    const res = await fetchOrganisation(directory, base);
    locator = res.locator.locator;
    $('added').textContent = `Added ${locator} with ${res.keys} keys.` + (res.locator.pathScoped ? ' (A real bank serves the file from the root of its own address.)' : '');
    if (verify) verify.session.setContext({ expectedName: locator, expectedUsuallySeals: true });
  } catch (err) {
    $('added').textContent = (err as Error).message;
  }
});
for (const b of document.querySelectorAll<HTMLButtonElement>('#callers button')) {
  b.addEventListener('click', () => void startCall(b.dataset.who as Who));
}
void showKeys();

// unattended run for the evaluation: ?auto=agent|stolen|fake|none
declare global {
  interface Window { liveseal?: Record<string, unknown> }
}
const auto = new URLSearchParams(location.search).get('auto') as Who | null;
if (auto) {
  window.liveseal = { done: false };
  $('add').click();
  setTimeout(async () => {
    const levels: string[] = [];
    const titles = new Set<string>();
    await startCall(auto);
    const timer = setInterval(() => {
      const b = (verify as VerifyPipeline).session.badge;
      levels.push(b.level[0]);
      titles.add(`${b.title} | ${b.detail}`);
    }, 2000);
    setTimeout(() => {
      clearInterval(timer);
      window.liveseal = { done: true, who: auto, locator, levels: levels.join(''), titles: [...titles] };
    }, Number(new URLSearchParams(location.search).get('seconds') ?? 24) * 1000);
  }, 1500);
}
