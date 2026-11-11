// Generates the small static files that are checked in under public/:
//   public/demo-bank/.well-known/liveseal.json   the demo organisation's key file
//   public/icon-*.png, extension/icons/*.png     app icons
// Run with: node scripts/make-static.ts

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import { toBase64Url } from '../core/src/bytes.ts';
import { signSubKey } from '../core/src/directory.ts';
import { crc32 } from '../core/src/bytes.ts';
import { DEMO_VALID_FROM, DEMO_VALID_TO, demoSigner } from '../demo-bank/keys.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const write = (path: string, data: string | Uint8Array) => {
  const full = join(root, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, data);
  console.log('wrote', path);
};

// ---- demo organisation key file
const bank = await demoSigner('root');
const agent = await demoSigner('agent');
const stolen = await demoSigner('stolen');
const from = Math.floor(Date.parse(DEMO_VALID_FROM) / 1000);
const to = Math.floor(Date.parse(DEMO_VALID_TO) / 1000);
write('public/demo-bank/.well-known/liveseal.json', JSON.stringify({
  liveseal: 1,
  name: 'Demo Bank (not a real bank)',
  keys: [
    { publicKey: toBase64Url(bank.publicKey), label: 'Customer calls', validFrom: DEMO_VALID_FROM, validTo: DEMO_VALID_TO },
  ],
  subKeys: [
    {
      publicKey: toBase64Url(agent.publicKey),
      label: 'Agent 042',
      issuer: toBase64Url(bank.publicKey),
      validFrom: DEMO_VALID_FROM,
      validTo: DEMO_VALID_TO,
      signature: toBase64Url(await signSubKey(bank, agent.publicKey, 'Agent 042', from, to)),
    },
  ],
  revoked: [
    { publicKey: toBase64Url(stolen.publicKey), revokedAt: '2026-06-01T00:00:00Z', reason: 'Laptop reported stolen (demo)' },
  ],
}, null, 2) + '\n');

// ---- icons: a ring with a check mark on a dark rounded square, drawn pixel by pixel
function png(size: number): Uint8Array {
  const px = new Uint8Array(size * size * 4);
  const c = size / 2;
  const smooth = (edge: number, v: number) => Math.max(0, Math.min(1, (edge - v) * size + 0.5));
  const segment = (x: number, y: number, x1: number, y1: number, x2: number, y2: number) => {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const t = Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / (dx * dx + dy * dy)));
    return Math.hypot(x - (x1 + t * dx), y - (y1 + t * dy));
  };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5 - c) / size;
      const v = (y + 0.5 - c) / size;
      // rounded square (superellipse)
      const body = smooth(0.47, Math.pow(Math.pow(Math.abs(u), 5) + Math.pow(Math.abs(v), 5), 1 / 5));
      const r = Math.hypot(u, v);
      const ring = smooth(0.335, r) * (1 - smooth(0.265, r));
      const check = Math.min(segment(u, v, -0.14, 0.01, -0.035, 0.115), segment(u, v, -0.035, 0.115, 0.16, -0.105));
      const mark = smooth(0.04, check);
      const ink = Math.max(ring, mark);
      const i = (y * size + x) * 4;
      px[i] = Math.round(16 + ink * (0 - 16));
      px[i + 1] = Math.round(18 + ink * (192 - 18));
      px[i + 2] = Math.round(22 + ink * (139 - 22));
      px[i + 3] = Math.round(255 * body);
    }
  }
  const raw = new Uint8Array(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) raw.set(px.subarray(y * size * 4, (y + 1) * size * 4), y * (size * 4 + 1) + 1);
  const chunk = (type: string, data: Uint8Array) => {
    const out = new Uint8Array(12 + data.length);
    const view = new DataView(out.buffer);
    view.setUint32(0, data.length);
    out.set([...type].map((ch) => ch.charCodeAt(0)), 4);
    out.set(data, 8);
    view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
    return out;
  };
  const ihdr = new Uint8Array(13);
  const hv = new DataView(ihdr.buffer);
  hv.setUint32(0, size);
  hv.setUint32(4, size);
  ihdr.set([8, 6, 0, 0, 0], 8);
  const parts = [Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', new Uint8Array(0))];
  const total = parts.reduce((n, p) => n + p.length, 0);
  const file = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { file.set(p, o); o += p.length; }
  return file;
}

for (const size of [192, 512]) write(`public/icon-${size}.png`, png(size));
for (const size of [16, 32, 48, 128]) write(`extension/icons/icon-${size}.png`, png(size));
