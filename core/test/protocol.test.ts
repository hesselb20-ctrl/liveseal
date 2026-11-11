import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fromHex, toBase64Url, toHex } from '../src/bytes.ts';
import {
  createSigner, fingerprintOf, generateSoftwareSecret, keyIdOf, overrideNativeSupport, safetyNumber, softwareSigner,
  supportsNativeEd25519, verifySignature, type Signer,
} from '../src/crypto.ts';
import {
  NO_SESSION, PERIOD_MS, PROTOCOL_VERSION, maxWireLength, parseStatement, periodOf, signStatement, signedBytes,
  verifyStatement, type Statement,
} from '../src/statement.ts';
import {
  KeyDirectory, createRevocation, encodePairing, normalizeOrgLocator, parseOrgFile, parsePairing, parseRevocation,
  signSubKey,
} from '../src/directory.ts';
import { BadgeMachine, DEFAULT_POLICY, SealChecker, type ContentComparison, type PeriodOutcome } from '../src/verify.ts';

const MATCH: ContentComparison = { verdict: 'match', score: 0 };
const NOW = 1_800_000_000_000; // fixed verifier clock for the tests, Unix ms

async function newSigner(): Promise<Signer> {
  return (await createSigner()).signer;
}

async function statementFor(signer: Signer, over: Partial<Statement> = {}): Promise<Statement> {
  return {
    version: PROTOCOL_VERSION,
    session: NO_SESSION,
    keyId: await keyIdOf(signer.publicKey),
    period: periodOf(NOW) - 1,
    faceBox: Uint8Array.of(96, 40, 64, 80),
    digest: new Uint8Array(32).fill(7),
    challenge: new Uint8Array(0),
    ...over,
  };
}

test('ed25519: native and software keys sign and verify each other', async () => {
  const msg = new TextEncoder().encode('hello');
  const native = await supportsNativeEd25519();
  const a = await newSigner();
  assert.equal(a.software, !native);
  const sig = await a.sign(msg);
  assert.equal(sig.length, 64);
  assert.ok(await verifySignature(a.publicKey, sig, msg));
  assert.ok(!(await verifySignature(a.publicKey, sig, new TextEncoder().encode('hellp'))));

  const soft = await softwareSigner(generateSoftwareSecret());
  assert.equal(soft.software, true);
  const sig2 = await soft.sign(msg);
  assert.ok(await verifySignature(soft.publicKey, sig2, msg));
  assert.ok(!(await verifySignature(a.publicKey, sig2, msg)));

  // RFC 8032 test vector 1 through the software path
  const rfc = await softwareSigner(fromHex('9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60'));
  assert.equal(toHex(rfc.publicKey), 'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a');
  assert.equal(
    toHex(await rfc.sign(new Uint8Array(0))),
    'e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b',
  );

  // the verifier also works when WebCrypto has no Ed25519
  overrideNativeSupport(false);
  try {
    assert.ok(await verifySignature(a.publicKey, sig, msg));
    assert.ok(!(await verifySignature(a.publicKey, sig2, msg)));
    assert.equal((await newSigner()).software, true);
  } finally {
    overrideNativeSupport(null);
  }
});

test('key id, fingerprint and safety number', async () => {
  const a = await newSigner();
  const b = await newSigner();
  assert.equal((await keyIdOf(a.publicKey)).length, 4);
  assert.match(await fingerprintOf(a.publicKey), /^([0-9a-f]{4} ){7}[0-9a-f]{4}$/);
  const ab = await safetyNumber(a.publicKey, b.publicKey);
  assert.equal(ab, await safetyNumber(b.publicKey, a.publicKey));
  assert.match(ab, /^(\d{5} ){5}\d{5}$/);
  const c = await newSigner();
  assert.notEqual(ab, await safetyNumber(a.publicKey, c.publicKey));
});

test('statement: sign, parse, verify, and reject every altered byte', async () => {
  const signer = await newSigner();
  const s = await statementFor(signer, { session: Uint8Array.of(1, 2, 3), challenge: Uint8Array.of(9, 8, 7) });
  const wire = await signStatement(s, signer);
  assert.ok(wire.length <= maxWireLength(s.digest.length));
  const parsed = parseStatement(wire);
  assert.ok(parsed);
  assert.deepEqual(parsed.statement, s);
  assert.ok(await verifyStatement(parsed, signer.publicKey));
  assert.ok(!(await verifyStatement(parsed, (await newSigner()).publicKey)));

  for (let i = 0; i < wire.length; i++) {
    const bad = wire.slice();
    bad[i] ^= 0x01;
    const p = parseStatement(bad);
    if (p) assert.ok(!(await verifyStatement(p, signer.publicKey)), `flipped byte ${i} still verifies`);
  }
  assert.equal(parseStatement(new Uint8Array(0)), null);
  assert.equal(parseStatement(wire.subarray(0, wire.length - 1)), null);
  assert.equal(parseStatement(Uint8Array.of(0x80)), null);
});

test('statement: the signature covers every field', async () => {
  const signer = await newSigner();
  const base = await statementFor(signer);
  const variants: Partial<Statement>[] = [
    { session: Uint8Array.of(0, 0, 1) }, { keyId: Uint8Array.of(1, 2, 3, 4) }, { period: base.period + 1 },
    { faceBox: Uint8Array.of(1, 1, 1, 1) }, { digest: new Uint8Array(32).fill(8) }, { challenge: Uint8Array.of(1, 1, 1) },
    { version: 2 },
  ];
  const seen = new Set([toHex(signedBytes(base))]);
  for (const v of variants) {
    const h = toHex(signedBytes({ ...base, ...v }));
    assert.ok(!seen.has(h));
    seen.add(h);
  }
});

test('pairing and revocation codes', async () => {
  const signer = await newSigner();
  const code = encodePairing('Mum', signer.publicKey);
  assert.deepEqual(parsePairing(code), { name: 'Mum', publicKey: signer.publicKey });
  assert.equal(parsePairing('liveseal:pair:AAAA'), null);
  assert.equal(parsePairing('hello'), null);

  const rev = await createRevocation(signer);
  assert.deepEqual((await parseRevocation(rev))?.publicKey, signer.publicKey);
  // a revocation must be signed by the key it revokes
  const other = await newSigner();
  const forged = (await createRevocation(other)).replace(/.{10}$/, 'AAAAAAAAAA');
  assert.equal(await parseRevocation(forged), null);
});

test('directory: pinning, key change, revocation, history, persistence', async () => {
  const dir = new KeyDirectory();
  const mum = await newSigner();
  const impostor = await newSigner();
  assert.equal(await dir.addContact('Mum', mum.publicKey, 100), 'added');
  assert.equal(await dir.addContact('Mum', mum.publicKey, 101), 'unchanged');
  assert.equal(await dir.addContact('Mum', impostor.publicKey, 102), 'key-changed');
  assert.equal(dir.findByName('Mum').length, 1);
  assert.equal(dir.find(await keyIdOf(mum.publicKey)).length, 1);
  assert.equal(dir.find(await keyIdOf(impostor.publicKey)).length, 0);

  assert.equal(dir.usuallySeals('Mum'), false);
  dir.recordCall('Mum', true);
  dir.recordCall('Mum', true);
  assert.equal(dir.usuallySeals('Mum'), true);
  dir.recordCall('Mum', false);
  dir.recordCall('Mum', false);
  assert.equal(dir.usuallySeals('Mum'), false);

  const restored = await KeyDirectory.fromJSON(JSON.parse(JSON.stringify(dir.toJSON())));
  assert.deepEqual(restored.toJSON(), dir.toJSON());

  assert.deepEqual(await dir.importRevocation(await createRevocation(mum), 200), ['Mum']);
  assert.equal(dir.findByName('Mum')[0].revokedAt, 200);
  await assert.rejects(dir.addContact('Mum again', mum.publicKey, 201));
  // after revocation the user can pair a new key under the same name
  const mum2 = await newSigner();
  assert.equal(await dir.addContact('Mum', mum2.publicKey, 300), 'added');
});

test('organisation file: roots, signed sub-keys, revocations and bad entries', async () => {
  const root = await newSigner();
  const agent = await newSigner();
  const rogue = await newSigner();
  const old = await newSigner();
  const from = 1_700_000_000;
  const to = 1_900_000_000;
  const file = {
    liveseal: 1,
    name: 'Demo Bank',
    keys: [{ publicKey: toBase64Url(root.publicKey), label: 'Customer calls', validFrom: '2026-01-01T00:00:00Z', validTo: '2028-01-01T00:00:00Z' }],
    subKeys: [
      {
        publicKey: toBase64Url(agent.publicKey), label: 'Agent 042', issuer: toBase64Url(root.publicKey),
        validFrom: new Date(from * 1000).toISOString(), validTo: new Date(to * 1000).toISOString(),
        signature: toBase64Url(await signSubKey(root, agent.publicKey, 'Agent 042', from, to)),
      },
      {
        publicKey: toBase64Url(rogue.publicKey), label: 'Rogue', issuer: toBase64Url(root.publicKey),
        validFrom: new Date(from * 1000).toISOString(), validTo: new Date(to * 1000).toISOString(),
        signature: toBase64Url(await signSubKey(rogue, rogue.publicKey, 'Rogue', from, to)),
      },
    ],
    revoked: [{ publicKey: toBase64Url(old.publicKey), revokedAt: '2026-06-01T00:00:00Z' }],
  };
  const parsed = await parseOrgFile(file);
  assert.ok(parsed);
  assert.equal(parsed.keys.length, 2);
  assert.equal(parsed.problems.length, 1);
  assert.match(parsed.problems[0], /Rogue/);

  const dir = new KeyDirectory();
  await dir.setOrganisation('demo-bank.example', parsed, 1_800_000_000);
  assert.equal(dir.find(await keyIdOf(agent.publicKey))[0].label, 'Agent 042');
  assert.equal(dir.find(await keyIdOf(rogue.publicKey)).length, 0);
  assert.ok(dir.find(await keyIdOf(old.publicKey))[0].revokedAt !== undefined);
  assert.equal(dir.usuallySeals('demo-bank.example'), true);
  assert.equal(dir.organisationAge('demo-bank.example', 1_800_000_100), 100);

  assert.equal(await parseOrgFile({ liveseal: 2, name: 'x', keys: [] }), null);
  assert.equal(await parseOrgFile('nope'), null);
});

test('organisation locator: https only, path-scoped locators are flagged', () => {
  assert.deepEqual(normalizeOrgLocator('ExampleBank.com'), {
    locator: 'examplebank.com', url: 'https://examplebank.com/.well-known/liveseal.json', pathScoped: false,
  });
  assert.deepEqual(normalizeOrgLocator('https://someone.github.io/liveseal/demo-bank/'), {
    locator: 'someone.github.io/liveseal/demo-bank',
    url: 'https://someone.github.io/liveseal/demo-bank/.well-known/liveseal.json',
    pathScoped: true,
  });
  assert.equal(normalizeOrgLocator('https://a.example/x/.well-known/liveseal.json')?.locator, 'a.example/x');
  assert.equal(normalizeOrgLocator('http://examplebank.com'), null);
  assert.equal(normalizeOrgLocator('https://user:pw@examplebank.com'), null);
  assert.equal(normalizeOrgLocator('intranet'), null);
  assert.equal(normalizeOrgLocator('http://localhost:5173/demo-bank')?.url, 'http://localhost:5173/demo-bank/.well-known/liveseal.json');
});

async function setup() {
  const dir = new KeyDirectory();
  const mum = await newSigner();
  await dir.addContact('Mum', mum.publicKey, 1);
  const checker = new SealChecker(dir);
  const check = async (wire: Uint8Array | null, opts: { pilots?: boolean; now?: number; cmp?: ContentComparison } = {}) =>
    checker.check({ pilots: opts.pilots ?? true, wire, nowMs: opts.now ?? NOW, compare: () => opts.cmp ?? MATCH });
  return { dir, mum, checker, check };
}

test('checker: every failure maps to the right outcome', async () => {
  const { dir, mum, checker, check } = await setup();
  assert.equal((await check(null, { pilots: false })).code, 'no-seal');
  assert.equal((await check(null, { pilots: true })).code, 'unreadable');
  assert.equal((await check(Uint8Array.of(1, 2, 3))).code, 'malformed');

  const good = await signStatement(await statementFor(mum), mum);
  assert.equal((await check(good)).code, 'valid');
  // the same statement again is a replay
  assert.equal((await check(good)).code, 'replayed');

  const next = (extra: Partial<Statement> = {}, d = 1) => statementFor(mum, { period: periodOf(NOW) - 1 + d, ...extra });
  assert.equal((await check(await signStatement(await next({ version: 9 }), mum))).code, 'unsupported-version');

  const stranger = await newSigner();
  assert.equal((await check(await signStatement(await statementFor(stranger), stranger))).code, 'unknown-key');

  // T5 variant: a stranger's signature under Mum's key id
  const forged = await signStatement(await next(), stranger);
  assert.equal((await check(forged)).code, 'bad-signature');

  // T2: an old recording
  const old = await signStatement(await next({}, -Math.ceil(600_000 / PERIOD_MS)), mum);
  assert.equal((await check(old)).code, 'stale');
  const future = await signStatement(await next({}, Math.ceil(600_000 / PERIOD_MS)), mum);
  assert.equal((await check(future)).code, 'stale');

  // T3: valid seal, wrong pictures
  // a single mismatch is amber; the second in a row is red; a match in between resets the count
  const m1 = await check(await signStatement(await next({}, 2), mum), { cmp: { verdict: 'mismatch', score: 0.9 } });
  assert.equal(m1.code, 'content-uncertain');
  const m2 = await check(await signStatement(await next({}, 3), mum), { cmp: { verdict: 'mismatch', score: 0.9 } });
  assert.equal(m2.code, 'content-mismatch');
  assert.equal((await check(await signStatement(await next({}, 3), mum), { cmp: { verdict: 'mismatch', score: 0.9 } })).code, 'content-mismatch');
  const u = await check(await signStatement(await next({}, 3), mum), { cmp: { verdict: 'uncertain', score: 0.5 } });
  assert.equal(u.code, 'content-uncertain');

  // challenge handling
  checker.setChallenge(Uint8Array.of(5, 6, 7));
  assert.equal((await check(await signStatement(await next({}, 4), mum))).code, 'awaiting-challenge');
  assert.equal((await check(await signStatement(await next({ session: Uint8Array.of(1, 1, 1) }, 5), mum))).code, 'wrong-session');
  assert.equal((await check(await signStatement(await next({ session: Uint8Array.of(5, 6, 7) }, 6), mum))).code, 'valid');
  assert.throws(() => checker.setChallenge(new Uint8Array(3)));
  checker.setChallenge(null);

  // T6: revocation
  await dir.importRevocation(await createRevocation(mum), 5);
  assert.equal((await check(await signStatement(await next({}, 7), mum))).code, 'revoked-key');
});

test('checker: organisation key outside its validity dates is rejected', async () => {
  const dir = new KeyDirectory();
  const root = await newSigner();
  const parsed = await parseOrgFile({
    liveseal: 1, name: 'Bank',
    keys: [{ publicKey: toBase64Url(root.publicKey), validFrom: '2020-01-01T00:00:00Z', validTo: '2021-01-01T00:00:00Z' }],
  });
  assert.ok(parsed);
  await dir.setOrganisation('bank.example', parsed, 1);
  const checker = new SealChecker(dir);
  const wire = await signStatement(await statementFor(root), root);
  const out = await checker.check({ pilots: true, wire, nowMs: NOW, compare: () => MATCH });
  assert.equal(out.code, 'expired-key');
});

test('badge: green needs N valid periods in a row and drops at once', async () => {
  const { mum, dir } = await setup();
  const key = dir.findByName('Mum')[0];
  const valid: PeriodOutcome = { code: 'valid', key, score: 0, statement: await statementFor(mum), checked: true };
  const m = new BadgeMachine();
  assert.equal(m.badge.level, 'amber');
  assert.equal(m.push({ code: 'no-seal' }).level, 'amber');
  let b = m.push(valid);
  assert.equal(b.level, 'amber');
  assert.equal(b.code, 'checking');
  b = m.push(valid);
  assert.equal(b.level, 'green');
  assert.equal(b.title, 'Verified: Mum');
  assert.equal(b.identity?.name, 'Mum');
  // one missed period: green is gone immediately and the loss is flagged
  b = m.push({ code: 'unreadable' });
  assert.equal(b.level, 'amber');
  assert.equal(b.code, 'seal-lost');
  assert.equal(b.strong, true);
  assert.equal(m.push(valid).level, 'amber');
  assert.equal(m.push(valid).level, 'green');
});

test('badge: red is immediate, sticky, and cleared only by re-earning green', async () => {
  const { mum, dir } = await setup();
  const key = dir.findByName('Mum')[0];
  const valid: PeriodOutcome = { code: 'valid', key, score: 0, statement: await statementFor(mum), checked: true };
  const m = new BadgeMachine();
  m.push(valid);
  m.push(valid);
  let b = m.push({ code: 'content-mismatch', key, score: 0.9, period: 1 });
  assert.equal(b.level, 'red');
  assert.match(b.detail, /not the picture Mum sealed/);
  // the attacker stops sending a seal: still red
  assert.equal(m.push({ code: 'no-seal' }).level, 'red');
  // one valid period is not enough
  assert.equal(m.push(valid).level, 'red');
  assert.equal(m.push(valid).level, 'green');
  // red hold expires after the configured number of quiet periods
  m.push({ code: 'stale', key, skewSeconds: 999, period: 1 });
  for (let i = 0; i < DEFAULT_POLICY.redHoldPeriods; i++) assert.equal(m.push({ code: 'no-seal' }).level, 'red');
  assert.equal(m.push({ code: 'no-seal' }).level, 'amber');
});

test('badge: a run of valid periods from two different keys never adds up to green', async () => {
  const dir = new KeyDirectory();
  const a = await newSigner();
  const b = await newSigner();
  await dir.addContact('A', a.publicKey, 1);
  await dir.addContact('B', b.publicKey, 1);
  const va: PeriodOutcome = { code: 'valid', key: dir.findByName('A')[0], score: 0, statement: await statementFor(a), checked: true };
  const vb: PeriodOutcome = { code: 'valid', key: dir.findByName('B')[0], score: 0, statement: await statementFor(b), checked: true };
  const m = new BadgeMachine();
  for (let i = 0; i < 6; i++) assert.notEqual(m.push(i % 2 ? va : vb).level, 'green');
});

test('badge: T7 strong warning when a contact who usually seals does not', () => {
  const m = new BadgeMachine();
  const plain = m.push({ code: 'no-seal' }, { expectedName: 'Mum', expectedUsuallySeals: false });
  assert.equal(plain.strong, false);
  const strong = m.push({ code: 'no-seal' }, { expectedName: 'Mum', expectedUsuallySeals: true });
  assert.equal(strong.level, 'amber');
  assert.equal(strong.strong, true);
  assert.match(strong.detail, /Mum usually verifies\. This call does not\./);
});

test('badge: exhaustive walk over outcome sequences never yields an unearned green', async () => {
  const { mum, dir } = await setup();
  const key = dir.findByName('Mum')[0];
  const stmt = await statementFor(mum);
  const outcomes: PeriodOutcome[] = [
    { code: 'valid', key, score: 0, statement: stmt, checked: true },
    { code: 'no-seal' }, { code: 'unreadable' }, { code: 'unknown-key', keyId: key.keyId },
    { code: 'content-uncertain', key, score: 0.5, period: 1 }, { code: 'content-mismatch', key, score: 1, period: 1 },
    { code: 'bad-signature', key }, { code: 'awaiting-challenge', key, period: 1 },
  ];
  const depth = 6;
  let sequences = 0;
  const walk = (prefix: number[]) => {
    if (prefix.length === depth) {
      sequences++;
      const m = new BadgeMachine();
      prefix.forEach((idx, i) => {
        const b = m.push(outcomes[idx]);
        const earned = i >= 1 && prefix[i] === 0 && prefix[i - 1] === 0;
        assert.equal(b.level === 'green', earned, `sequence ${prefix.join(',')} at ${i}`);
        if (b.level === 'green') assert.ok(b.identity);
      });
      return;
    }
    for (let i = 0; i < outcomes.length; i++) walk([...prefix, i]);
  };
  walk([]);
  assert.equal(sequences, outcomes.length ** depth);
});

test('badge: a statement whose pictures predate the verifier counts towards the run but cannot turn it green', async () => {
  const { mum, dir, check } = await setup();
  const key = dir.findByName('Mum')[0];
  const stmt = await statementFor(mum);
  const unchecked: PeriodOutcome = { code: 'valid', key, score: 0, statement: stmt, checked: false };
  const checked: PeriodOutcome = { code: 'valid', key, score: 0, statement: stmt, checked: true };
  const m = new BadgeMachine();
  assert.equal(m.push(unchecked).level, 'amber');
  assert.equal(m.push(unchecked).level, 'amber');
  assert.equal(m.push(checked).level, 'green');
  const m2 = new BadgeMachine();
  assert.equal(m2.push(unchecked).level, 'amber');
  assert.equal(m2.push(checked).level, 'green');
  // the checker reports 'unobserved' comparisons as valid-but-unchecked
  const out = await check(await signStatement(stmt, mum), { cmp: { verdict: 'unobserved', score: 0 } });
  assert.equal(out.code, 'valid');
  assert.equal(out.code === 'valid' && out.checked, false);
});
