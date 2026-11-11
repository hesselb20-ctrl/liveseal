// Per-period checks and the badge state machine.
//
// SealChecker turns "what the demodulator produced this period" into one
// PeriodOutcome. BadgeMachine turns the stream of outcomes into the badge the
// user sees. The rule that shapes both: nothing uncertain may ever be green.

import { equalBytes, toHex } from './bytes.ts';
import type { KeyDirectory, PinnedKey } from './directory.ts';
import { NO_SESSION, PERIOD_MS, PROTOCOL_VERSION, parseStatement, verifyStatement, type Statement } from './statement.ts';

/**
 * 'unobserved' means the signed window lies before the verifier started
 * watching, so there is nothing to compare. It can only happen for the first
 * statement of a stream.
 */
export type ContentVerdict = 'match' | 'uncertain' | 'mismatch' | 'unobserved';

export interface ContentComparison {
  verdict: ContentVerdict;
  /** Distance or score from the digest comparison, for display and logging. */
  score: number;
}

export type PeriodOutcome =
  | { code: 'no-seal' }
  | { code: 'unreadable' }
  | { code: 'malformed' }
  | { code: 'unsupported-version'; version: number }
  | { code: 'unknown-key'; keyId: Uint8Array }
  | { code: 'awaiting-challenge'; key: PinnedKey }
  | { code: 'content-uncertain'; key: PinnedKey; score: number }
  | { code: 'bad-signature'; key: PinnedKey }
  | { code: 'revoked-key'; key: PinnedKey }
  | { code: 'expired-key'; key: PinnedKey }
  | { code: 'wrong-session'; key: PinnedKey }
  | { code: 'stale'; key: PinnedKey; skewSeconds: number }
  | { code: 'replayed'; key: PinnedKey }
  | { code: 'content-mismatch'; key: PinnedKey; score: number }
  | { code: 'valid'; key: PinnedKey; score: number; statement: Statement; /** false when the content could not be compared ('unobserved') */ checked: boolean };

export type OutcomeCode = PeriodOutcome['code'];

const RED_CODES: ReadonlySet<OutcomeCode> = new Set([
  'bad-signature', 'revoked-key', 'expired-key', 'wrong-session', 'stale', 'replayed', 'content-mismatch',
]);

export function isRed(code: OutcomeCode): boolean {
  return RED_CODES.has(code);
}

export interface VerifierPolicy {
  /** Fully valid periods in a row before the badge turns green. */
  consecutiveForGreen: number;
  /** Allowed clock difference without a challenge, in seconds. */
  passiveMaxSkewSeconds: number;
  /** Allowed clock difference when the seal answers our challenge, in seconds. */
  challengeMaxSkewSeconds: number;
  /** After a red period, the badge stays red for at least this many periods unless green is re-earned. */
  redHoldPeriods: number;
}

export const DEFAULT_POLICY: VerifierPolicy = {
  consecutiveForGreen: 2,
  passiveMaxSkewSeconds: 30,
  challengeMaxSkewSeconds: 120,
  redHoldPeriods: 5,
};

export interface PeriodInput {
  /** Whether the pilot pattern was detected in this period. */
  pilots: boolean;
  /** Statement bytes that passed error correction and the CRC, or null. */
  wire: Uint8Array | null;
  /** Verifier clock, Unix milliseconds, at the moment the period finished arriving. */
  nowMs: number;
  /** Compares the signed digest with the frames that were actually received. */
  compare: (statement: Statement) => ContentComparison | Promise<ContentComparison>;
}

export class SealChecker {
  private challenge: Uint8Array | null = null;
  private lastPeriod = new Map<string, number>();
  private readonly directory: KeyDirectory;
  private readonly policy: VerifierPolicy;

  constructor(directory: KeyDirectory, policy: VerifierPolicy = DEFAULT_POLICY) {
    this.directory = directory;
    this.policy = policy;
  }

  /** Sets or clears the challenge this verifier expects seals to answer. */
  setChallenge(challenge: Uint8Array | null): void {
    if (challenge && equalBytes(challenge, NO_SESSION)) throw new Error('challenge must not be all zero');
    this.challenge = challenge ? challenge.slice() : null;
  }

  getChallenge(): Uint8Array | null {
    return this.challenge;
  }

  async check(input: PeriodInput): Promise<PeriodOutcome> {
    if (!input.wire) return { code: input.pilots ? 'unreadable' : 'no-seal' };
    const signed = parseStatement(input.wire);
    if (!signed) return { code: 'malformed' };
    const s = signed.statement;
    if (s.version !== PROTOCOL_VERSION) return { code: 'unsupported-version', version: s.version };

    const candidates = this.directory.find(s.keyId);
    if (candidates.length === 0) return { code: 'unknown-key', keyId: s.keyId };
    let key: PinnedKey | null = null;
    for (const c of candidates) {
      if (await verifyStatement(signed, c.publicKey)) { key = c; break; }
    }
    // The statement names a key we pinned but is not signed by it.
    if (!key) return { code: 'bad-signature', key: candidates[0] };

    const nowUnix = input.nowMs / 1000;
    if (key.revokedAt !== undefined) return { code: 'revoked-key', key };
    if ((key.notBefore !== undefined && nowUnix < key.notBefore) || (key.notAfter !== undefined && nowUnix > key.notAfter)) {
      return { code: 'expired-key', key };
    }

    const hasSession = !equalBytes(s.session, NO_SESSION);
    if (this.challenge) {
      if (!hasSession) return { code: 'awaiting-challenge', key };
      if (!equalBytes(s.session, this.challenge)) return { code: 'wrong-session', key };
    }

    // The statement finished transmitting at the end of its period.
    const sentAt = ((s.period + 1) * PERIOD_MS) / 1000;
    const skew = nowUnix - sentAt;
    const maxSkew = this.challenge ? this.policy.challengeMaxSkewSeconds : this.policy.passiveMaxSkewSeconds;
    if (Math.abs(skew) > maxSkew) return { code: 'stale', key, skewSeconds: skew };

    const id = toHex(key.publicKey);
    const last = this.lastPeriod.get(id);
    if (last !== undefined && s.period <= last) return { code: 'replayed', key };

    const cmp = await input.compare(s);
    if (cmp.verdict === 'mismatch') return { code: 'content-mismatch', key, score: cmp.score };
    // Only a statement that passed every cryptographic check advances the replay counter.
    this.lastPeriod.set(id, s.period);
    if (cmp.verdict === 'uncertain') return { code: 'content-uncertain', key, score: cmp.score };
    return { code: 'valid', key, score: cmp.score, statement: s, checked: cmp.verdict === 'match' };
  }
}

// ------------------------------------------------------------------ badge

export type BadgeLevel = 'green' | 'amber' | 'red';

export interface Badge {
  level: BadgeLevel;
  /** Machine-readable reason: an outcome code, or 'checking', 'seal-lost', 'idle'. */
  code: string;
  /** Short label that is always shown as text next to the colour. */
  title: string;
  /** One plain sentence that explains the state. */
  detail: string;
  /** Verified identity. Present only on green and on 'checking'. */
  identity?: { name: string; kind: 'contact' | 'organisation'; label?: string };
  /** True when the state deserves an interruption, not just a colour. */
  strong: boolean;
}

export interface BadgeContext {
  /**
   * Who the user believes is on screen (chosen by the user, or matched from
   * the tile's display name). Used only to strengthen warnings, never to
   * grant trust.
   */
  expectedName?: string;
  /** Whether that identity normally seals its calls (KeyDirectory.usuallySeals). */
  expectedUsuallySeals?: boolean;
}

function describe(key: PinnedKey): string {
  return key.kind === 'organisation' && key.label ? `${key.name} (${key.label})` : key.name;
}

function redText(o: PeriodOutcome): { title: string; detail: string } {
  switch (o.code) {
    case 'bad-signature':
      return {
        title: 'Warning: invalid seal',
        detail: `This seal claims to come from ${describe(o.key)} but its signature is wrong. That is a sign of tampering.`,
      };
    case 'revoked-key':
      return {
        title: 'Warning: revoked key',
        detail: `This seal was made with a key that ${describe(o.key)} has revoked. It may have been stolen.`,
      };
    case 'expired-key':
      return {
        title: 'Warning: key not valid now',
        detail: `This seal was made with a key from ${describe(o.key)} that is outside its validity dates.`,
      };
    case 'wrong-session':
      return {
        title: 'Warning: seal from another call',
        detail: 'This seal was made for a different call. It may be relayed or recorded.',
      };
    case 'stale':
      return {
        title: 'Warning: seal from another time',
        detail: 'This seal was not made just now. It may be a recording.',
      };
    case 'replayed':
      return {
        title: 'Warning: repeated seal',
        detail: 'This seal repeats an earlier one. It may be a recording.',
      };
    case 'content-mismatch':
      return {
        title: 'Warning: picture does not match',
        detail: `The picture on screen is not the picture ${describe(o.key)} sealed. The video may have been altered.`,
      };
    default:
      return { title: 'Warning', detail: 'The seal failed a check.' };
  }
}

function amberText(o: PeriodOutcome): { title: string; detail: string } {
  switch (o.code) {
    case 'no-seal':
      return { title: 'Not verified', detail: 'No seal was found in this video.' };
    case 'unreadable':
      return {
        title: 'Not verified',
        detail: 'A seal is present but cannot be read. The video may be too compressed.',
      };
    case 'malformed':
    case 'unsupported-version':
      return {
        title: 'Not verified',
        detail: 'A seal is present but this version of LiveSeal cannot understand it.',
      };
    case 'unknown-key':
      return {
        title: 'Not verified',
        detail: 'This video is sealed by a key you have not verified. Do not rely on the name on screen.',
      };
    case 'awaiting-challenge':
      return {
        title: 'Waiting for the code',
        detail: `${describe(o.key)} is sealing this call but has not confirmed your three words yet.`,
      };
    case 'content-uncertain':
      return {
        title: 'Not verified',
        detail: 'The seal is valid but the picture is too degraded to confirm that it matches.',
      };
    default:
      return { title: 'Not verified', detail: 'This call is not verified.' };
  }
}

export class BadgeMachine {
  private run = 0;
  private runKey = '';
  private everGreen = false;
  private redHold = 0;
  private lastRed: PeriodOutcome | null = null;
  private readonly policy: VerifierPolicy;
  private current: Badge = {
    level: 'amber', code: 'idle', title: 'Not verified', detail: 'Looking for a seal.', strong: false,
  };

  constructor(policy: VerifierPolicy = DEFAULT_POLICY) {
    this.policy = policy;
  }

  get badge(): Badge {
    return this.current;
  }

  /** True once any period of this call was green. */
  get wasVerified(): boolean {
    return this.everGreen;
  }

  /** Feeds the outcome of one seal period and returns the badge to show. */
  push(outcome: PeriodOutcome, context: BadgeContext = {}): Badge {
    if (outcome.code === 'valid') {
      const id = toHex(outcome.key.publicKey);
      this.run = this.runKey === id ? this.run + 1 : 1;
      this.runKey = id;
      const identity = { name: outcome.key.name, kind: outcome.key.kind, label: outcome.key.label };
      // Green needs the full run of validly signed statements, and the newest one must
      // also have had its pictures compared. Only the very first statement of a stream
      // can be unchecked (its pictures predate the verifier), so in steady state every
      // statement behind a green badge has been compared.
      if (this.run >= this.policy.consecutiveForGreen && outcome.checked) {
        this.everGreen = true;
        this.redHold = 0;
        this.lastRed = null;
        const how = outcome.key.kind === 'organisation'
          ? `Sealed by a key published by ${outcome.key.name}.`
          : `Sealed by the key you pinned for ${outcome.key.name}.`;
        return this.set({
          level: 'green', code: 'valid', title: `Verified: ${describe(outcome.key)}`, detail: how, identity, strong: false,
        });
      }
      if (this.redHold > 0 && this.lastRed) {
        this.redHold--;
        return this.set({ level: 'red', code: this.lastRed.code, ...redText(this.lastRed), strong: true });
      }
      return this.set({
        level: 'amber',
        code: 'checking',
        title: 'Checking seal',
        detail: `Seal found from ${describe(outcome.key)}. Confirming (${this.run} of ${this.policy.consecutiveForGreen}).`,
        identity,
        strong: false,
      });
    }

    this.run = 0;
    this.runKey = '';

    if (isRed(outcome.code)) {
      this.lastRed = outcome;
      this.redHold = this.policy.redHoldPeriods;
      return this.set({ level: 'red', code: outcome.code, ...redText(outcome), strong: true });
    }
    if (this.redHold > 0 && this.lastRed) {
      this.redHold--;
      return this.set({ level: 'red', code: this.lastRed.code, ...redText(this.lastRed), strong: true });
    }

    const text = amberText(outcome);
    // Once a call has been verified, any later loss of the seal is worth an interruption.
    if (this.everGreen) {
      return this.set({
        level: 'amber',
        code: 'seal-lost',
        title: 'Seal lost',
        detail: `This call was verified a moment ago and is not any more. ${text.detail}`,
        strong: true,
      });
    }
    if (context.expectedName && context.expectedUsuallySeals && outcome.code !== 'awaiting-challenge') {
      return this.set({
        level: 'amber',
        code: outcome.code,
        title: 'Not verified',
        detail: `${context.expectedName} usually verifies. This call does not. ${text.detail}`,
        strong: true,
      });
    }
    return this.set({ level: 'amber', code: outcome.code, ...text, strong: false });
  }

  private set(b: Badge): Badge {
    this.current = b;
    return b;
  }
}
