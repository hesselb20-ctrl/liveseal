// Monte-Carlo check of the error-correcting codes on synthetic channels.
// Reports the frame failure rate against the fraction of unusable bits
// (erasures) and against Gaussian noise, for the code sizes the modem uses.
// Usage: node codec-sim/fec-bench.ts [trials=200]

import { prng } from '../core/src/bytes.ts';
import { makeFec } from '../core/src/frame.ts';

const trials = Number((process.argv[2] ?? 'trials=200').split('=')[1]);
const rand = prng(4242);
const uniform = () => rand() / 4294967296;
const gauss = () => Math.sqrt(-2 * Math.log(uniform() + 1e-12)) * Math.cos(2 * Math.PI * uniform());

function run(label: string, bits: number, kind: 'rs' | 'ldpc', red: number, erase: number, sigma: number): string {
  const fec = makeFec(kind, bits, red);
  let fail = 0;
  let wrong = 0;
  const t0 = performance.now();
  for (let t = 0; t < trials; t++) {
    const wire = Uint8Array.from({ length: fec.capacity }, () => rand() & 0xff);
    const coded = fec.encode(wire);
    const llr = new Float32Array(fec.codedBits);
    for (let i = 0; i < llr.length; i++) {
      if (uniform() < erase) { llr[i] = 0.3 * gauss(); continue; } // garbage with low confidence
      const x = (coded[i] ? -1 : 1) + sigma * gauss();
      llr[i] = (2 * x) / Math.max(sigma * sigma, 0.05);
    }
    const res = fec.decode(llr);
    if (!res) fail++;
    else if (res.wire.length !== wire.length || res.wire.some((b, i) => b !== wire[i])) wrong++;
  }
  const ms = (performance.now() - t0) / trials;
  return `${label.padEnd(14)} erase ${(erase * 100).toFixed(0).padStart(3)}%  sigma ${sigma.toFixed(2)}  fail ${fail}/${trials}  wrong ${wrong}  ${ms.toFixed(1)} ms/frame`;
}

for (const [label, bits, kind, red] of [
  ['rs  1 plane', 2016, 'rs', 128], ['ldpc 1 plane', 2016, 'ldpc', 125], ['ldpc 3 planes', 6048, 'ldpc', 125],
] as const) {
  for (const [erase, sigma] of [[0, 0.3], [0.2, 0.3], [0.3, 0.3], [0.4, 0.3], [0.5, 0.3], [0.6, 0.3], [0.7, 0.3], [0.75, 0.3], [0, 0.7], [0, 1.0], [0, 1.4], [0.3, 0.8], [0.5, 0.8]]) {
    console.log(run(label, bits, kind, red, erase, sigma));
  }
}
