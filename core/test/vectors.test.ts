// Interoperability vectors from docs/PROTOCOL.md, section 12. If one of these
// changes, the protocol has changed and existing seals no longer verify.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toHex } from '../src/bytes.ts';
import { keyIdOf, sha256, softwareSigner } from '../src/crypto.ts';
import { DIGEST, compareDigest, computeDigest, digestLength } from '../src/digest.ts';
import { FACE_SIZE, SNAPSHOTS, THUMB_H, THUMB_W, makeFaceBox, type PeriodFeatures } from '../src/features.ts';
import { makeLdpc } from '../src/ldpc.ts';
import { makeLayout } from '../src/modem.ts';
import { PROTOCOL_VERSION, maxWireLength, parseStatement, signStatement, verifyStatement, type Statement } from '../src/statement.ts';

async function checksum(view: ArrayBufferView): Promise<string> {
  return toHex((await sha256(new Uint8Array(view.buffer, view.byteOffset, view.byteLength))).slice(0, 8));
}

test('public tables match the published checksums', async () => {
  const layout = makeLayout();
  assert.equal(layout.pilotCells.length, 216);
  assert.equal(layout.dataCells.length, 1512);
  assert.equal(layout.fec.codedBits, 6048);
  assert.equal(await checksum(layout.pilotCells), 'b47df07fe405e751');
  assert.equal(await checksum(layout.pilotSeq), '5fdd631c6d03115e');
  assert.equal(await checksum(layout.dataCells), 'f3045ab9c23baa18');
  assert.equal(await checksum(layout.scramble), '8d2808179d83f886');
  assert.equal(await checksum(makeLdpc(6048, 1152, 0x1d9c, 4).infoChecks), '82413590e29a32e8');
  assert.equal(await checksum(layout.fec.encode(new Uint8Array(0))), 'cdbd1f8158b6858d');
});

test('statement test vector', async () => {
  const signer = await softwareSigner(new Uint8Array(32).fill(7));
  assert.equal(toHex(signer.publicKey), 'ea4a6c63e29c520abef5507b132ec5f9954776aebebe7b92421eea691446d22c');
  const statement: Statement = {
    version: PROTOCOL_VERSION,
    session: Uint8Array.of(1, 2, 3),
    keyId: await keyIdOf(signer.publicKey),
    period: 900000000,
    faceBox: Uint8Array.of(77, 31, 102, 154),
    digest: new Uint8Array(32).map((_, i) => (i * 7) & 255),
    challenge: new Uint8Array(0),
  };
  assert.equal(toHex(statement.keyId), 'c1c3dc95');
  const wire = await signStatement(statement, signer);
  assert.equal(wire.length, 122);
  assert.ok(wire.length <= maxWireLength(32));
  assert.equal(toHex(wire),
    '88014301020344c1c3dc951a35a4e900444d1f669a582000070e151c232a31383f464d54'
    + '5b626970777e858c939aa1a8afb6bdc4cbd2d9405840c52780e78c3eb75a3019e8629bc0'
    + '7bf116342dbcc0db85ac0e2f375b238b09df8857eeced354694cc51f55d04a20972f94b6'
    + '434d358bb9daf1e37e660a3e4200');
  const parsed = parseStatement(wire);
  assert.ok(parsed && (await verifyStatement(parsed, signer.publicKey)));
  const layout = makeLayout();
  assert.ok(wire.length + 3 <= layout.fec.capacity, 'a statement with a challenge must fit in a frame');
  assert.equal(await checksum(layout.fec.encode(wire)), '04521ef9a97071c9');
});

function syntheticFeatures(seed: number, noise = 0): PeriodFeatures {
  // a smooth "face" pattern per snapshot, plus optional noise
  let state = seed >>> 0 || 1;
  const rand = () => ((state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 4294967296);
  const faces = new Float32Array(SNAPSHOTS * FACE_SIZE * FACE_SIZE);
  const thumbs = new Float32Array(SNAPSHOTS * THUMB_W * THUMB_H);
  const a = 3 + rand() * 4;
  const b = 2 + rand() * 5;
  const c = rand() * 6;
  for (let s = 0; s < SNAPSHOTS; s++) {
    for (let y = 0; y < FACE_SIZE; y++) {
      for (let x = 0; x < FACE_SIZE; x++) {
        faces[s * FACE_SIZE * FACE_SIZE + y * FACE_SIZE + x] = 120 + 40 * Math.sin(x / a + c + s * 0.1) * Math.cos(y / b) + 25 * Math.sin((x + y) / (a + b));
      }
    }
    for (let y = 0; y < THUMB_H; y++) {
      for (let x = 0; x < THUMB_W; x++) thumbs[s * THUMB_W * THUMB_H + y * THUMB_W + x] = 100 + 50 * Math.sin(x / (a * 2) + c) + 30 * Math.cos(y / b + c);
    }
  }
  if (noise > 0) {
    let n = 12345;
    const jitter = () => (((n = (Math.imul(n, 1664525) + 1013904223) >>> 0) / 4294967296) - 0.5) * 2 * noise;
    for (let i = 0; i < faces.length; i++) faces[i] += jitter();
    for (let i = 0; i < thumbs.length; i++) thumbs[i] += jitter();
  }
  return { faces, thumbs, valid: new Array<boolean>(SNAPSHOTS).fill(true) };
}

test('digest: same picture matches, another picture mismatches, missing frames are never a match', () => {
  const box = makeFaceBox(0.3, 0.1, 0.4, 0.6);
  const genuine = syntheticFeatures(1);
  const digest = computeDigest(genuine, box);
  assert.equal(digest.length, digestLength());
  assert.equal(digest.length, 32);
  assert.equal(DIGEST.kind, 'gradient');
  assert.equal(compareDigest(digest, genuine, box).verdict, 'match');
  assert.equal(compareDigest(digest, syntheticFeatures(1, 3), box).verdict, 'match'); // mild noise, as from a codec
  const other = compareDigest(digest, syntheticFeatures(2), box);
  assert.equal(other.verdict, 'mismatch');
  assert.ok(other.score > DIGEST.faceMismatch);
  assert.equal(compareDigest(digest, null, box).verdict, 'unobserved');
  const few = syntheticFeatures(1);
  few.valid = [false, true, false, false, false, false, true, false]; // only one face snapshot left
  assert.equal(compareDigest(digest, few, box).verdict, 'uncertain');
  assert.equal(compareDigest(digest.slice(1), genuine, box).verdict, 'uncertain'); // wrong length
  // a flat picture (covered lens) has nothing to compare: neither a match nor a mismatch
  const flat: PeriodFeatures = { faces: new Float32Array(genuine.faces.length).fill(128), thumbs: genuine.thumbs, valid: genuine.valid };
  assert.equal(compareDigest(computeDigest(flat, box), flat, box).verdict, 'uncertain');
  const noisy: PeriodFeatures = { faces: flat.faces.map((v, i) => v + ((i * 7919) % 5) - 2), thumbs: genuine.thumbs, valid: genuine.valid };
  assert.equal(compareDigest(computeDigest(flat, box), noisy, box).verdict, 'uncertain');
  // but a real face shown where the sender's lens was covered is a mismatch
  assert.equal(compareDigest(computeDigest(flat, box), genuine, box).verdict, 'mismatch');
});
