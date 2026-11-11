// Pairing, contacts, organisations and revocation: one panel shared by the
// camera page, the verifier pages and the extension popup.

import jsQR from 'jsqr';
import qrcode from 'qrcode-generator';
import { fingerprintOf, safetyNumber } from '../core/src/crypto.ts';
import { KeyDirectory, createRevocation, encodePairing, parsePairing, parseRevocation } from '../core/src/directory.ts';
import type { Identity } from './store.ts';
import { fetchOrganisation } from './store.ts';

export function qrSvg(text: string): string {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  return qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}, ...children: (Node | string)[]): HTMLElementTagNameMap[K] {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

/** Scans a QR code with the camera. Resolves with its text, or null if cancelled. */
export function scanQr(container: HTMLElement): Promise<string | null> {
  return new Promise((resolve) => {
    const video = el('video', { muted: true, playsInline: true });
    video.style.cssText = 'width:100%;border-radius:12px;background:#000';
    const cancel = el('button', { textContent: 'Cancel' });
    const box = el('div', { className: 'stack' }, video, cancel);
    container.append(box);
    let stream: MediaStream | null = null;
    let timer = 0;
    const finish = (value: string | null) => {
      clearInterval(timer);
      stream?.getTracks().forEach((t) => t.stop());
      box.remove();
      resolve(value);
    };
    cancel.addEventListener('click', () => finish(null));
    navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false }).then(async (s) => {
      stream = s;
      video.srcObject = s;
      await video.play();
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D;
      timer = window.setInterval(() => {
        if (!video.videoWidth) return;
        canvas.width = 480;
        canvas.height = Math.round((480 * video.videoHeight) / video.videoWidth);
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const hit = jsQR(img.data, img.width, img.height);
        if (hit?.data) finish(hit.data);
      }, 200);
    }).catch(() => finish(null));
  });
}

export interface ContactsPanelOptions {
  /** The user's own identity; when present the panel shows the pairing code and recovery tools. */
  identity?: Identity | null;
  directory: KeyDirectory;
  /** Called after any change so the host can save the directory. */
  onChange: () => void | Promise<void>;
  /** Called when the user revokes their own key. */
  onRevokeSelf?: () => void | Promise<void>;
  /** Fetches an organisation key file; the extension routes this through its background page. */
  fetchOrg?: (directory: KeyDirectory, input: string) => Promise<{ locator: { locator: string; pathScoped: boolean }; name: string; keys: number; problems: string[] }>;
}

/** Renders the panel into `root` and keeps it up to date. */
export function mountContacts(root: HTMLElement, opts: ContactsPanelOptions): { refresh: () => void } {
  const { directory } = opts;
  const status = el('p', { className: 'muted' });
  status.setAttribute('aria-live', 'polite');
  const say = (text: string) => { status.textContent = text; };
  const now = () => Math.floor(Date.now() / 1000);
  const list = el('div', { className: 'stack' });
  const scanSlot = el('div');

  async function addFromCode(text: string): Promise<void> {
    const pairing = parsePairing(text);
    if (pairing) {
      const their = pairing.publicKey;
      const number = opts.identity ? await safetyNumber(opts.identity.signer.publicKey, their) : await fingerprintOf(their);
      const what = opts.identity ? 'safety number' : 'key fingerprint';
      const ok = confirm(`Pair with "${pairing.name}"?\n\nThe ${what} is:\n\n${number}\n\nRead it out to each other, in person or over a channel you already trust. Only continue if both sides see the same ${what}.`);
      if (!ok) return;
      const result = await directory.addContact(pairing.name, their, now());
      if (result === 'key-changed') {
        const replace = confirm(`You already have a different key for "${pairing.name}".\n\nA changed key can mean a new device, or someone pretending to be them. Replace the key only if you have confirmed it with them directly.`);
        if (!replace) { say(`Kept the existing key for ${pairing.name}.`); return; }
        await directory.replaceContactKey(pairing.name, their, now());
      }
      await opts.onChange();
      say(result === 'unchanged' ? `${pairing.name} was already paired.` : `Paired with ${pairing.name}.`);
      render();
      return;
    }
    if (await parseRevocation(text)) {
      const names = await directory.importRevocation(text, now());
      await opts.onChange();
      say(names && names.length ? `Revoked the key of ${names.join(', ')}. Calls sealed with it will now show a warning.` : 'That revocation is valid but matches none of your contacts.');
      render();
      return;
    }
    say('That is not a LiveSeal pairing or revocation code.');
  }

  async function addOrg(input: string): Promise<void> {
    try {
      const res = await (opts.fetchOrg ?? fetchOrganisation)(directory, input);
      await opts.onChange();
      say(`Added ${res.locator.locator} ("${res.name}", ${res.keys} key${res.keys === 1 ? '' : 's'}).`
        + (res.locator.pathScoped ? ' Note: this key file is not at the root of the site, so it only proves control of that folder.' : '')
        + (res.problems.length ? ` Ignored: ${res.problems.join('; ')}.` : ''));
      render();
    } catch (err) {
      say((err as Error).message);
    }
  }

  function render(): void {
    list.replaceChildren();
    const names = new Map<string, { kind: string; revoked: boolean; labels: string[] }>();
    for (const k of directory.list()) {
      const entry = names.get(k.kind + ':' + k.name) ?? { kind: k.kind, revoked: true, labels: [] };
      if (k.revokedAt === undefined) entry.revoked = false;
      if (k.label) entry.labels.push(k.label);
      names.set(k.kind + ':' + k.name, entry);
    }
    if (names.size === 0) list.append(el('p', { className: 'muted', textContent: 'No one paired yet.' }));
    for (const [key, info] of names) {
      const name = key.slice(key.indexOf(':') + 1);
      const h = directory.historyOf(name);
      const line = el('div', { className: 'row' },
        el('div', { className: 'grow' },
          el('strong', { textContent: name }),
          el('div', { className: 'muted', textContent: info.kind === 'organisation'
            ? `Organisation${info.labels.length ? ': ' + info.labels.join(', ') : ''}`
            : `Contact, ${h.sealed} sealed call${h.sealed === 1 ? '' : 's'} seen` })),
        el('span', { className: 'pill ' + (info.revoked ? 'bad' : 'ok'), textContent: info.revoked ? 'revoked' : 'pinned' }),
      );
      const remove = el('button', { textContent: 'Remove' });
      remove.setAttribute('aria-label', `Remove ${name}`);
      remove.addEventListener('click', async () => {
        if (!confirm(`Remove ${name}? Their calls will show as not verified.`)) return;
        directory.removeName(name, info.kind as 'contact' | 'organisation');
        await opts.onChange();
        render();
      });
      line.append(remove);
      list.append(line);
    }
  }

  root.replaceChildren();
  if (opts.identity) {
    const id = opts.identity;
    const code = encodePairing(id.name, id.signer.publicKey);
    const qr = el('div', { className: 'qr' });
    qr.innerHTML = qrSvg(code);
    qr.setAttribute('role', 'img');
    qr.setAttribute('aria-label', 'Your pairing code as a QR code');
    const fp = el('p', { className: 'mono muted' });
    void fingerprintOf(id.signer.publicKey).then((f) => { fp.textContent = `Key fingerprint: ${f}`; });
    const copy = el('button', { textContent: 'Copy my pairing code' });
    copy.addEventListener('click', async () => {
      await navigator.clipboard.writeText(code);
      say('Pairing code copied. Send it to your contact, then compare the safety number together.');
    });
    root.append(el('div', { className: 'row' }, qr, el('div', { className: 'stack grow' },
      el('h3', { textContent: `Your code, ${id.name}` }),
      el('p', { className: 'muted', textContent: 'Let the other person scan this, or send them the code. It contains only your name and public key.' }),
      copy, fp)));
    if (id.signer.software) {
      root.append(el('p', { className: 'note', textContent: 'This browser cannot keep signing keys locked away, so your key is stored where page scripts can read it. Use a current version of Chrome, Edge, Firefox or Safari for a protected key.' }));
    }
  }

  const input = el('textarea', { placeholder: 'Paste a pairing code or a revocation code' });
  input.setAttribute('aria-label', 'Pairing or revocation code');
  const add = el('button', { className: 'primary', textContent: 'Add' });
  add.addEventListener('click', async () => { await addFromCode(input.value); input.value = ''; });
  const scan = el('button', { textContent: 'Scan a QR code' });
  scan.addEventListener('click', async () => {
    const text = await scanQr(scanSlot);
    if (text) await addFromCode(text);
  });
  const org = el('input', { type: 'text', placeholder: 'examplebank.com' });
  org.setAttribute('aria-label', 'Organisation web address');
  const orgAdd = el('button', { textContent: 'Add organisation' });
  orgAdd.addEventListener('click', async () => { if (org.value.trim()) await addOrg(org.value); });
  root.append(
    el('h3', { textContent: 'People and organisations you can verify' }),
    list,
    el('div', { className: 'stack' }, input, el('div', { className: 'row' }, add, scan), scanSlot),
    el('div', { className: 'row' }, el('div', { className: 'grow' }, org), orgAdd),
    status,
  );

  if (opts.identity && opts.onRevokeSelf) {
    const id = opts.identity;
    const sheet = el('button', { textContent: 'Print my recovery sheet' });
    sheet.addEventListener('click', async () => {
      const revocation = await createRevocation(id.signer);
      const w = window.open('', '_blank');
      if (!w) { say('Allow pop-ups to print the recovery sheet.'); return; }
      w.document.write(`<!doctype html><title>LiveSeal recovery sheet</title><body style="font:16px system-ui;max-width:640px;margin:40px auto;line-height:1.5">
        <h1>LiveSeal recovery sheet</h1><p><b>${id.name.replace(/[<>&]/g, '')}</b>, created ${new Date(id.createdAt * 1000).toDateString()}</p>
        <p>If the device that holds this LiveSeal key is lost or stolen, send the code below to your contacts. When they add it, calls sealed with the lost key show a warning. Keep this sheet somewhere safe: anyone who has it can revoke your key, and nothing else.</p>
        <div style="width:260px">${qrSvg(revocation)}</div><p style="word-break:break-all;font:12px monospace">${revocation}</p></body>`);
      w.document.close();
      w.print();
    });
    const revoke = el('button', { className: 'danger', textContent: 'My key is compromised: revoke it' });
    revoke.addEventListener('click', async () => {
      if (!confirm('Revoke your key?\n\nYou will get a code to send to your contacts. This device will then create a new key, and you will need to pair with everyone again. This cannot be undone.')) return;
      const revocation = await createRevocation(id.signer);
      await navigator.clipboard.writeText(revocation).catch(() => undefined);
      input.value = revocation;
      say('Revocation code created and copied. Send it to every contact. Your old key is no longer used on this device.');
      await opts.onRevokeSelf?.();
    });
    root.append(el('h3', { textContent: 'If your device is lost' }), el('div', { className: 'row' }, sheet, revoke));
  }
  render();
  return { refresh: render };
}
