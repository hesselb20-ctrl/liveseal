import { test } from 'node:test';
import assert from 'node:assert/strict';
import { concatBytes, crc32, equalBytes, fromBase64Url, fromHex, prng, toBase64Url, toHex, utf8 } from '../src/bytes.ts';
import { decodeCbor, encodeCbor } from '../src/cbor.ts';
import { rsDecode, rsEncode } from '../src/rs.ts';
import { buildCodeword, decodeCodeword, frameCapacity } from '../src/frame.ts';
import { WORDS, challengeToWords, suggestWord, wordsToChallenge } from '../src/words.ts';

test('bytes: hex, base64url and crc32 round-trip', () => {
  const b = Uint8Array.of(0, 1, 2, 250, 251, 252, 253, 254, 255);
  assert.equal(toHex(b), '000102fafbfcfdfeff');
  assert.deepEqual(fromHex(toHex(b)), b);
  for (let n = 0; n < 40; n++) {
    const x = Uint8Array.from({ length: n }, (_, i) => (i * 37 + n) & 0xff);
    assert.deepEqual(fromBase64Url(toBase64Url(x)), x);
  }
  assert.equal(crc32(utf8('123456789')), 0xcbf43926);
  assert.ok(equalBytes(concatBytes(b, b).subarray(9), b));
  assert.throws(() => fromHex('abc'));
  assert.throws(() => fromBase64Url('a+b'));
});

test('cbor: known encodings (RFC 8949 appendix A)', () => {
  const cases: [unknown, string][] = [
    [0, '00'], [23, '17'], [24, '1818'], [100, '1864'], [1000, '1903e8'], [1000000, '1a000f4240'],
    [1000000000000, '1b000000e8d4a51000'], [-1, '20'], [-100, '3863'], [-1000, '3903e7'],
    [false, 'f4'], [true, 'f5'], [null, 'f6'],
    [new Uint8Array(0), '40'], [Uint8Array.of(1, 2, 3, 4), '4401020304'],
    ['', '60'], ['a', '6161'], ['IETF', '6449455446'], ['ü', '62c3bc'],
    [[], '80'], [[1, 2, 3], '83010203'], [[1, [2, 3], [4, 5]], '8301820203820405'],
  ];
  for (const [value, hex] of cases) {
    assert.equal(toHex(encodeCbor(value as never)), hex);
    assert.deepEqual(decodeCbor(fromHex(hex)), value);
  }
  const map = new Map<number | string, never>([[1, 2 as never], [3, 4 as never]]);
  assert.equal(toHex(encodeCbor(map)), 'a201020304');
});

test('cbor: map keys are sorted and decoding is strict', () => {
  const m = new Map<number | string, number>([['b', 1], [10, 2], ['a', 3], [2, 4]]);
  const enc = encodeCbor(m);
  assert.equal(toHex(enc), 'a402040a02616103616201');
  assert.deepEqual([...(decodeCbor(enc) as Map<number | string, number>).keys()], [2, 10, 'a', 'b']);
  const bad = [
    '1817', // non-minimal integer
    '190017', // non-minimal integer
    '5f4101ff', // indefinite length
    'f97e00', // float
    'c074323031332d30332d32315432303a30343a30305a', // tag
    'a2020101', // unsorted map keys ... (2 then 1)
    'a201010102', // duplicate keys
    '0001', // trailing bytes
    '44010203', // truncated
    '9f', // indefinite array
  ];
  for (const hex of bad) assert.throws(() => decodeCbor(fromHex(hex)), `should reject ${hex}`);
});

test('reed-solomon: corrects errors, erasures and mixtures up to the bound', () => {
  const rand = prng(12345);
  for (const [k, nsym] of [[124, 128], [40, 16], [200, 55], [10, 2]] as const) {
    for (let trial = 0; trial < 30; trial++) {
      const msg = Uint8Array.from({ length: k }, () => rand() & 0xff);
      const cw = rsEncode(msg, nsym);
      assert.equal(cw.length, k + nsym);
      assert.deepEqual(rsDecode(cw, nsym)?.message, msg);

      // choose a random mixture with 2*errors + erasures <= nsym
      const erasures = rand() % (nsym + 1);
      const errors = rand() % (Math.floor((nsym - erasures) / 2) + 1);
      const positions = Array.from({ length: cw.length }, (_, i) => i);
      for (let i = positions.length - 1; i > 0; i--) {
        const j = rand() % (i + 1);
        [positions[i], positions[j]] = [positions[j], positions[i]];
      }
      const damaged = cw.slice();
      const erasePos = positions.slice(0, erasures);
      for (const p of erasePos) damaged[p] = rand() & 0xff;
      for (const p of positions.slice(erasures, erasures + errors)) damaged[p] ^= 1 + (rand() % 255);
      const res = rsDecode(damaged, nsym, erasePos);
      assert.ok(res, `k=${k} nsym=${nsym} errors=${errors} erasures=${erasures}`);
      assert.deepEqual(res.message, msg);
    }
  }
});

test('reed-solomon: reports failure beyond the bound instead of inventing data', () => {
  const rand = prng(777);
  const nsym = 32;
  let failures = 0;
  const trials = 300;
  for (let trial = 0; trial < trials; trial++) {
    const msg = Uint8Array.from({ length: 100 }, () => rand() & 0xff);
    const damaged = rsEncode(msg, nsym);
    for (let i = 0; i < 40; i++) damaged[(i * 3 + trial) % damaged.length] ^= 1 + (rand() % 255);
    const res = rsDecode(damaged, nsym);
    if (!res) failures++;
    else assert.notDeepEqual(res.message, msg); // a wrong correction is possible but must be rare
  }
  assert.ok(failures >= trials - 2, `only ${failures} of ${trials} overloaded codewords were rejected`);
});

test('frame: round-trip, reliability-guided erasures and CRC protection', () => {
  const p = { n: 252, parity: 128 };
  const rand = prng(99);
  const wire = Uint8Array.from({ length: frameCapacity(p) }, () => rand() & 0xff);
  const cw = buildCodeword(wire, p);
  assert.equal(cw.length, 252);
  assert.deepEqual(decodeCodeword(cw, null, p)?.wire, wire);

  // 100 damaged bytes: too many for errors-only (64), fine once the weak bytes are flagged.
  const damaged = cw.slice();
  const reliability = new Float32Array(p.n).fill(1);
  for (let i = 0; i < 100; i++) {
    const pos = (i * 5) % p.n;
    damaged[pos] ^= 0x5a;
    reliability[pos] = 0.1;
  }
  assert.equal(decodeCodeword(damaged, null, p), null);
  const res = decodeCodeword(damaged, reliability, p);
  assert.deepEqual(res?.wire, wire);

  // Pure noise must never decode.
  for (let t = 0; t < 200; t++) {
    const noise = Uint8Array.from({ length: p.n }, () => rand() & 0xff);
    const rel = Float32Array.from({ length: p.n }, () => rand() / 0xffffffff);
    assert.equal(decodeCodeword(noise, rel, p), null);
  }

  assert.throws(() => buildCodeword(new Uint8Array(frameCapacity(p) + 1), p));
  const short = buildCodeword(Uint8Array.of(1, 2, 3), p);
  assert.deepEqual(decodeCodeword(short, null, p)?.wire, Uint8Array.of(1, 2, 3));
});

test('words: 256 unique words and a lossless round-trip', () => {
  assert.equal(WORDS.length, 256);
  assert.equal(new Set(WORDS).size, 256);
  for (const w of WORDS) assert.match(w, /^[a-z]{4,9}$/);
  for (let i = 0; i < 256; i++) {
    const c = Uint8Array.of(i, (i * 7 + 3) & 0xff, 255 - i);
    assert.deepEqual(wordsToChallenge(challengeToWords(c)), c);
  }
  assert.deepEqual(wordsToChallenge('  Apple,  ARROW - autumn '), Uint8Array.of(0, 1, 2));
  assert.equal(wordsToChallenge('apple arrow'), null);
  assert.equal(wordsToChallenge('apple arrow notaword'), null);
  assert.equal(suggestWord('aple'), 'apple');
  assert.equal(suggestWord('zzzzzzzz'), null);
});
