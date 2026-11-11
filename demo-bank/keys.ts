// Keys of the demo bank. THESE KEYS ARE PUBLIC ON PURPOSE: the demo page has to
// play the bank's agent in your browser, so it needs the private halves. They
// protect nothing. A real organisation keeps its private keys on its own
// systems and publishes only the JSON file.

import { sha256, softwareSigner, type Signer } from '../core/src/crypto.ts';
import { utf8 } from '../core/src/bytes.ts';

const SEEDS = {
  root: 'LiveSeal demo bank root key (public on purpose)',
  agent: 'LiveSeal demo bank agent 042 key (public on purpose)',
  stolen: 'LiveSeal demo bank old key, reported stolen (public on purpose)',
} as const;

export type DemoKeyName = keyof typeof SEEDS;

export async function demoSigner(name: DemoKeyName): Promise<Signer> {
  return softwareSigner(await sha256(utf8(SEEDS[name])));
}

export const DEMO_VALID_FROM = '2026-01-01T00:00:00Z';
export const DEMO_VALID_TO = '2031-01-01T00:00:00Z';
