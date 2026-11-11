// Makes a sealed recording for testing the recording checker: a test clip,
// sealed by a real sender session with a real key, encoded as a WebM file.
// Optionally the second half is tampered with (another face under the seal).
//
// Usage: node codec-sim/make-recording.ts [clip] [tamper]
// Output: data/test/sealed-<clip>.webm (or tampered-<clip>.webm) and, on stdout, the pairing code of the key.

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { utf8 } from '../core/src/bytes.ts';
import { sha256, softwareSigner } from '../core/src/crypto.ts';
import { encodePairing } from '../core/src/directory.ts';
import { makeReducer } from '../core/src/modem.ts';
import { SenderSession } from '../core/src/session.ts';
import { AttackSource, FACES, FACE_CLIPS, clipSize } from './attacks.ts';
import { FrameSealer } from './channel.ts';
import { DATA, RawWriter, ffmpeg, remove, tmpPath } from './video.ts';

const clip = process.argv[2] ?? 'johnny';
const tamper = process.argv[3] === 'tamper';
const SECONDS = 24;
const FPS = 30;
const { width, height } = clipSize(clip);
const signer = await softwareSigner(await sha256(utf8('LiveSeal recording test key (public on purpose)')));
const sender = new SenderSession({ signer });
sender.setFace(...FACES[clip]);
const genuine = new AttackSource(clip, { kind: 'none' });
const donor = FACE_CLIPS.find((c) => c !== clip) as string;
const swapped = tamper ? new AttackSource(clip, { kind: 'swap', donor }) : null;
const reduce = makeReducer(width, height);
const sealer = new FrameSealer(sender.layout, width, height);
const field = new Float32Array(sender.layout.cells);
const frame = new Uint8Array(width * height * 3 / 2);
const out = new Uint8Array(frame.length);
const raw = tmpPath('yuv');
const writer = new RawWriter(raw);
const epoch = Date.now();
for (let k = 0; k < SECONDS * FPS; k++) {
  const now = epoch + (k * 1000) / FPS;
  genuine.frame(k, frame);
  sender.pushFrame(now, reduce(frame, width));
  await sender.whenIdle();
  sender.field(now, field);
  // in a tampered recording the second half shows another face under the genuine seal
  if (swapped && k >= (SECONDS * FPS) / 2) swapped.frame(k, out);
  else out.set(frame);
  sealer.applyField(out, field, k);
  writer.write(out);
}
writer.close();
genuine.close();
swapped?.close();
mkdirSync(join(DATA, 'test'), { recursive: true });
const file = join(DATA, 'test', `${tamper ? 'tampered' : 'sealed'}-${clip}.webm`);
ffmpeg(['-f', 'rawvideo', '-pix_fmt', 'yuv420p', '-s', `${width}x${height}`, '-r', String(FPS), '-i', raw,
  '-c:v', 'libvpx', '-b:v', '1M', '-deadline', 'good', '-cpu-used', '4', '-g', '60', '-an', file]);
remove(raw);
console.log(file);
console.log(encodePairing('Recorded caller', signer.publicKey));
