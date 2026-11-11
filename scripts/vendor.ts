// Copies the MediaPipe WASM runtime out of node_modules and fetches the small
// face-detection model, so the site serves both itself and makes no
// third-party request at run time. Output: public/vendor/mediapipe/ (git-ignored).
// Run with: node scripts/vendor.ts

import { cpSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dest = join(root, 'public', 'vendor', 'mediapipe');
mkdirSync(dest, { recursive: true });
cpSync(join(root, 'node_modules', '@mediapipe', 'tasks-vision', 'wasm'), join(dest, 'wasm'), { recursive: true });
console.log('copied MediaPipe WASM runtime');

const model = join(dest, 'blaze_face_short_range.tflite');
const MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite';
if (existsSync(model)) {
  console.log('face model already present');
} else {
  try {
    const res = await fetch(MODEL_URL);
    if (!res.ok) throw new Error(`status ${res.status}`);
    writeFileSync(model, new Uint8Array(await res.arrayBuffer()));
    console.log('fetched face model');
  } catch (err) {
    // Not fatal: without the model the sender ties the seal to the middle of the picture.
    console.warn(`could not fetch the face model (${(err as Error).message}); sealing will use a fixed central box`);
  }
}
