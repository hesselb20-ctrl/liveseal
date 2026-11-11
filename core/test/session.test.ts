// End-to-end tests of the sender and receiver sessions on synthetic video
// (no codec). Each threat from docs/THREAT_MODEL.md has a test here; the
// codec-level versions are in codec-sim/run-attacks.ts.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSigner } from '../src/crypto.ts';
import { KeyDirectory, createRevocation } from '../src/directory.ts';
import { challengeToWords, wordsToChallenge } from '../src/words.ts';
import { SyntheticScene, codes, levels, runCall } from './support.ts';

async function mumAndDirectory() {
  const mum = (await createSigner()).signer;
  const directory = new KeyDirectory();
  await directory.addContact('Mum', mum.publicKey, 1);
  return { mum, directory };
}

test('genuine call: green within three decoded periods and it stays green', async () => {
  const { mum, directory } = await mumAndDirectory();
  const reports = await runCall({ signer: mum, directory, seconds: 16, scene: new SyntheticScene(1) });
  const lv = levels(reports);
  assert.ok(reports.length >= 6, `only ${reports.length} periods`);
  const firstGreen = lv.indexOf('green');
  assert.ok(firstGreen >= 1 && firstGreen <= 2, `first green at period ${firstGreen}: ${codes(reports).join(',')}`);
  assert.ok(lv.slice(firstGreen).every((l) => l === 'green'), codes(reports).join(','));
  assert.ok(!lv.includes('red'));
  const green = reports[firstGreen].badge;
  assert.equal(green.title, 'Verified: Mum');
  // the sender starts with no history, so its first period carries pilots only
  assert.ok(['starting', 'valid'].includes(reports[0].outcome.code));
});

test('T1 no seal: amber, never green', async () => {
  const { mum, directory } = await mumAndDirectory();
  const reports = await runCall({ signer: mum, directory, seconds: 12, scene: new SyntheticScene(1), mode: 'unsealed' });
  assert.ok(reports.length >= 3);
  assert.ok(codes(reports).every((c) => c === 'no-seal'), codes(reports).join(','));
  assert.ok(levels(reports).every((l) => l === 'amber'));
});

test('T2 replay: a recorded sealed call played later is red', async () => {
  const { mum, directory } = await mumAndDirectory();
  const reports = await runCall({ signer: mum, directory, seconds: 12, scene: new SyntheticScene(1), receiverDelayMs: 3_600_000 });
  const signed = reports.filter((r) => r.outcome.code !== 'starting');
  assert.ok(signed.length >= 3);
  assert.ok(signed.every((r) => r.outcome.code === 'stale'), codes(reports).join(','));
  assert.ok(!levels(reports).includes('green'));
  assert.equal(signed[signed.length - 1].badge.level, 'red');
});

test('T3 relay: a live genuine seal on another face is red, never green', async () => {
  const { mum, directory } = await mumAndDirectory();
  const reports = await runCall({
    signer: mum, directory, seconds: 16, scene: new SyntheticScene(1), mode: 'relay', attackerScene: new SyntheticScene(2),
  });
  const lv = levels(reports);
  assert.ok(!lv.includes('green'), codes(reports).join(','));
  const judged = reports.filter((r) => r.outcome.code === 'content-mismatch');
  assert.ok(judged.length >= 3, `only ${judged.length} mismatches: ${codes(reports).join(',')}`);
  assert.equal(lv[lv.length - 1], 'red');
  assert.match(reports[reports.length - 1].badge.detail, /not the picture Mum sealed/);
});

test('T3 relay with the challenge relayed too: still red', async () => {
  const { mum, directory } = await mumAndDirectory();
  const challenge = Uint8Array.of(12, 200, 7);
  const reports = await runCall({
    signer: mum, directory, seconds: 14, scene: new SyntheticScene(1), mode: 'relay', attackerScene: new SyntheticScene(3),
    each: (k, sender, receiver) => {
      if (k === 0) {
        receiver.checker.setChallenge(challenge);
        sender.answerChallenge(challenge); // the genuine person was tricked into typing the victim's words
      }
    },
  });
  assert.ok(!levels(reports).includes('green'));
  assert.ok(codes(reports).includes('content-mismatch'));
  assert.equal(levels(reports).at(-1), 'red');
});

test('T5 attacker seals with an unpinned key: amber, and the badge names no one', async () => {
  const { directory } = await mumAndDirectory();
  const attacker = (await createSigner()).signer;
  const reports = await runCall({ signer: attacker, directory, seconds: 12, scene: new SyntheticScene(2) });
  const signed = reports.filter((r) => r.outcome.code !== 'starting');
  assert.ok(signed.length >= 3);
  assert.ok(signed.every((r) => r.outcome.code === 'unknown-key'));
  assert.ok(reports.every((r) => r.badge.level === 'amber' && r.badge.identity === undefined));
});

test('T5 attacker pinned under their own name: green shows the attacker, not the claimed person', async () => {
  const { directory } = await mumAndDirectory();
  const attacker = (await createSigner()).signer;
  await directory.addContact('Unknown caller 4471', attacker.publicKey, 2);
  const reports = await runCall({ signer: attacker, directory, seconds: 12, scene: new SyntheticScene(2) });
  const green = reports.find((r) => r.badge.level === 'green');
  assert.ok(green);
  assert.equal(green.badge.identity?.name, 'Unknown caller 4471');
  assert.ok(!reports.some((r) => /Mum/.test(r.badge.title)));
});

test('T6 revoked key: red from the moment the revocation is imported', async () => {
  const { mum, directory } = await mumAndDirectory();
  const revocation = await createRevocation(mum);
  let imported = false;
  const reports = await runCall({
    signer: mum, directory, seconds: 18, scene: new SyntheticScene(1),
    each: (k) => {
      if (k === 300 && !imported) {
        imported = true;
        void directory.importRevocation(revocation, 1_800_000_010);
      }
    },
  });
  const lv = levels(reports);
  assert.ok(lv.includes('green'), 'call was verified before the revocation');
  const after = reports.filter((r) => r.outcome.code === 'revoked-key');
  assert.ok(after.length >= 2, codes(reports).join(','));
  assert.equal(lv.at(-1), 'red');
  const firstRevoked = reports.findIndex((r) => r.outcome.code === 'revoked-key');
  assert.ok(!lv.slice(firstRevoked).includes('green'));
});

test('T7 downgrade: an unsealed call from a contact who usually seals raises the strong warning', async () => {
  const { mum, directory } = await mumAndDirectory();
  directory.recordCall('Mum', true);
  directory.recordCall('Mum', true);
  directory.recordCall('Mum', true);
  const reports = await runCall({
    signer: mum, directory, seconds: 10, scene: new SyntheticScene(1), mode: 'unsealed',
    each: (k, _s, receiver) => {
      if (k === 0) receiver.setContext({ expectedName: 'Mum', expectedUsuallySeals: directory.usuallySeals('Mum') });
    },
  });
  assert.ok(reports.length >= 2);
  for (const r of reports) {
    assert.equal(r.badge.level, 'amber');
    assert.equal(r.badge.strong, true);
    assert.match(r.badge.detail, /Mum usually verifies\. This call does not\./);
  }
});

test('challenge: amber until the caller answers, green after, red for a wrong answer', async () => {
  const { mum, directory } = await mumAndDirectory();
  const challenge = wordsToChallenge('tiger maple window') as Uint8Array;
  assert.equal(challengeToWords(challenge), 'tiger maple window');
  const reports = await runCall({
    signer: mum, directory, seconds: 22, scene: new SyntheticScene(1),
    each: (k, sender, receiver) => {
      if (k === 0) receiver.checker.setChallenge(challenge);
      if (k === 240) sender.answerChallenge(challenge); // the caller types the words after 8 seconds
    },
  });
  const c = codes(reports);
  const firstAnswered = c.indexOf('valid');
  assert.ok(c.slice(0, firstAnswered).every((x) => x === 'awaiting-challenge' || x === 'starting'), c.join(','));
  assert.ok(c.includes('awaiting-challenge'));
  assert.ok(firstAnswered > 2);
  assert.equal(levels(reports).at(-1), 'green');
  assert.ok(!levels(reports).includes('red'));

  const wrong = await runCall({
    signer: mum, directory, seconds: 10, scene: new SyntheticScene(1),
    each: (k, sender, receiver) => {
      if (k === 0) {
        receiver.checker.setChallenge(challenge);
        sender.answerChallenge(Uint8Array.of(1, 2, 3));
      }
    },
  });
  assert.ok(codes(wrong).includes('wrong-session'));
  assert.ok(!levels(wrong).includes('green'));
  assert.equal(levels(wrong).at(-1), 'red');
});

test('mutual challenge: a challenge carried in a verified seal is reported to the application', async () => {
  const { mum, directory } = await mumAndDirectory();
  const challenge = Uint8Array.of(9, 9, 9);
  const reports = await runCall({
    signer: mum, directory, seconds: 12, scene: new SyntheticScene(1),
    each: (k, sender) => { if (k === 0) sender.issueChallenge(challenge); },
  });
  const withChallenge = reports.filter((r) => r.peerChallenge);
  assert.ok(withChallenge.length >= 2);
  assert.deepEqual(withChallenge[0].peerChallenge, challenge);
});
