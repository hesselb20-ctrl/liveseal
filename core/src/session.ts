// Sender and receiver sessions: the complete logic of one sealed stream, with
// no DOM in it. The browser apps feed these classes with frames; the
// simulator's attack suite feeds them with codec output. Same code both ways.

import { keyIdOf, type Signer } from './crypto.ts';
import { DIGEST_READY_BEFORE_MS, compareDigest, computeDigest, digestWindowStart } from './digest.ts';
import type { KeyDirectory } from './directory.ts';
import { FrameHistory, makeFaceBox, type FaceBox } from './features.ts';
import {
  DEFAULT_DEMOD, DEFAULT_MODEM, Demodulator, SealSchedule, makeLayout, type DemodOptions, type ModemLayout,
  type ModemParams,
} from './modem.ts';
import { NO_SESSION, PERIOD_MS, PROTOCOL_VERSION, signStatement, type Statement } from './statement.ts';
import {
  BadgeMachine, DEFAULT_POLICY, SealChecker, type Badge, type BadgeContext, type PeriodOutcome, type VerifierPolicy,
} from './verify.ts';

/** Peak seal offset per plane (Y, Cb, Cr) in the encoder's 8-bit units. Chosen in docs/EVALUATION.md, section 4. */
export const SEAL_AMPLITUDE: readonly [number, number, number] = [2, 3, 3];
/** A gentler setting for good connections; recovers fewer statements through aggressive encoders. */
export const SEAL_AMPLITUDE_LIGHT: readonly [number, number, number] = [1.5, 2, 2];

/** Used until a face detector reports a position, and when no detector is available. */
export const DEFAULT_FACE_BOX: FaceBox = makeFaceBox(0.3, 0.12, 0.4, 0.6);

export interface SenderOptions {
  signer: Signer;
  amplitude?: ArrayLike<number>;
  modem?: ModemParams;
}

export class SenderSession {
  readonly layout: ModemLayout;
  private readonly schedule: SealSchedule;
  private readonly history = new FrameHistory();
  private readonly signer: Signer;
  private keyId: Uint8Array | null = null;
  private amplitude: ArrayLike<number>;
  private session: Uint8Array = NO_SESSION;
  private challenge: Uint8Array = new Uint8Array(0);
  private faceBox: FaceBox = DEFAULT_FACE_BOX;
  private prepared = new Set<number>();
  /** Called with every statement that was signed, for diagnostics. */
  onStatement: ((statement: Statement, wire: Uint8Array) => void) | null = null;
  /** Last error from signing, if any. */
  lastError: unknown = null;

  constructor(opts: SenderOptions) {
    this.layout = makeLayout(opts.modem ?? DEFAULT_MODEM);
    this.schedule = new SealSchedule(this.layout);
    this.signer = opts.signer;
    this.amplitude = opts.amplitude ?? SEAL_AMPLITUDE;
  }

  setAmplitude(amplitude: ArrayLike<number>): void {
    this.amplitude = amplitude;
  }

  /** The challenge received from the verifier (three words, or read from the peer's seal). Null clears it. */
  answerChallenge(challenge: Uint8Array | null): void {
    this.session = challenge ? challenge.slice() : NO_SESSION;
  }

  /** A challenge of our own for the peer to answer, carried inside our seal. Null clears it. */
  issueChallenge(challenge: Uint8Array | null): void {
    this.challenge = challenge ? challenge.slice() : new Uint8Array(0);
  }

  /** Face position from the detector, as fractions of the frame. */
  setFace(x: number, y: number, w: number, h: number): void {
    this.faceBox = makeFaceBox(x, y, w, h);
  }

  /**
   * Call for every captured frame. `unixMs` is the sender clock at capture and
   * `reducedLuma` the frame reduced to REDUCED_W x REDUCED_H luma. Shortly
   * before each period starts, the statement for it is built and signed.
   */
  pushFrame(unixMs: number, reducedLuma: ArrayLike<number>): void {
    this.history.push(unixMs, reducedLuma);
    const next = Math.floor(unixMs / PERIOD_MS) + 1;
    const nextStart = next * PERIOD_MS;
    if (this.prepared.has(next) || unixMs < nextStart - DIGEST_READY_BEFORE_MS) return;
    this.prepared.add(next);
    for (const p of this.prepared) if (p < next - 4) this.prepared.delete(p);
    const box = this.faceBox;
    const features = this.history.features(digestWindowStart(nextStart), box);
    if (!features) return; // not enough frames yet (just started): this period carries only pilots
    void this.sign(next, computeDigest(features, box), box);
  }

  private async sign(period: number, digest: Uint8Array, box: FaceBox): Promise<void> {
    try {
      if (!this.keyId) this.keyId = await keyIdOf(this.signer.publicKey);
      const statement: Statement = {
        version: PROTOCOL_VERSION,
        session: this.session,
        keyId: this.keyId,
        period,
        faceBox: box,
        digest,
        challenge: this.challenge,
      };
      const wire = await signStatement(statement, this.signer);
      this.schedule.setPeriod(period, wire);
      this.onStatement?.(statement, wire);
    } catch (err) {
      this.lastError = err;
    }
  }

  /** Per-cell offsets to add to the frame shown at `unixMs`. */
  field(unixMs: number, out?: Float32Array): Float32Array {
    return this.schedule.field(unixMs, this.amplitude, out);
  }
}

export interface ReceiverOptions {
  directory: KeyDirectory;
  policy?: VerifierPolicy;
  modem?: ModemParams;
  demod?: DemodOptions;
}

export interface PeriodReport {
  /** Start of the period in the receiver's frame timebase. */
  startMs: number;
  outcome: PeriodOutcome;
  badge: Badge;
  pilotScore: number;
  /** Measured seal amplitude per plane. */
  amplitude: number[];
  /** Channel bits corrected in this period. */
  bitErrors: number;
  /** A challenge the (verified) sender asks us to answer, if any. */
  peerChallenge: Uint8Array | null;
}

export class ReceiverSession {
  readonly layout: ModemLayout;
  readonly checker: SealChecker;
  readonly machine: BadgeMachine;
  private readonly demod: Demodulator;
  private readonly history = new FrameHistory(3 * PERIOD_MS + 1000);
  private context: BadgeContext = {};
  private chain: Promise<unknown> = Promise.resolve();

  constructor(opts: ReceiverOptions) {
    this.layout = makeLayout(opts.modem ?? DEFAULT_MODEM);
    this.demod = new Demodulator(this.layout, opts.demod ?? DEFAULT_DEMOD);
    const policy = opts.policy ?? DEFAULT_POLICY;
    this.checker = new SealChecker(opts.directory, policy);
    this.machine = new BadgeMachine(policy);
  }

  /** Who the user expects on this stream; only used to strengthen warnings. */
  setContext(context: BadgeContext): void {
    this.context = context;
  }

  get badge(): Badge {
    return this.machine.badge;
  }

  /**
   * Feeds one received frame.
   *  `tMs`         frame time on any monotonic clock (media time or arrival time)
   *  `cellMeans`   output of the cell sampler for this frame
   *  `reducedLuma` the frame reduced to REDUCED_W x REDUCED_H luma
   *  `unixMs`      the verifier's wall clock now
   * Resolves with a report when this frame completed a seal period, else null.
   */
  pushFrame(tMs: number, cellMeans: Float32Array, reducedLuma: ArrayLike<number>, unixMs: number): Promise<PeriodReport | null> {
    this.history.push(tMs, reducedLuma);
    this.demod.push(tMs, cellMeans);
    const res = this.demod.poll();
    if (!res) return Promise.resolve(null);
    const work = this.chain.then(async (): Promise<PeriodReport> => {
      const outcome = await this.checker.check({
        pilots: res.present,
        wire: res.wire,
        nowMs: unixMs,
        compare: (statement) => {
          const features = this.history.features(digestWindowStart(res.startMs), statement.faceBox);
          const cmp = compareDigest(statement.digest, features, statement.faceBox);
          return { verdict: cmp.verdict, score: cmp.score };
        },
      });
      const badge = this.machine.push(outcome, this.context);
      const peerChallenge = outcome.code === 'valid' && outcome.statement.challenge.length > 0 ? outcome.statement.challenge : null;
      return { startMs: res.startMs, outcome, badge, pilotScore: res.pilotScore, amplitude: res.amplitude, bitErrors: res.bitErrors, peerChallenge };
    });
    this.chain = work.catch(() => undefined);
    return work;
  }
}
