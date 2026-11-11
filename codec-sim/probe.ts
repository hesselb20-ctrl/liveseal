// Quick single experiments from the command line, for exploring the design space.
// Usage: node codec-sim/probe.ts clip=johnny size=640x360 codec=vp8 kbps=600 amp=2 [denoise=1] [seconds=10]
//        [grid=32x18] [symbols=8] [edge=0.4] [fade=70] [fec=ldpc|rs] [red=125] [verbose=1]

import { DEFAULT_MODEM } from '../core/src/modem.ts';
import { runChannel, summarize } from './channel.ts';
import type { CodecName } from './video.ts';

const args = Object.fromEntries(process.argv.slice(2).map((a) => [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)] as [string, string]));
const [w, h] = (args.size ?? '640x360').split('x').map(Number);
const [gw, gh] = (args.grid ?? `${DEFAULT_MODEM.gridW}x${DEFAULT_MODEM.gridH}`).split('x').map(Number);
const clips = (args.clip ?? 'johnny').split(',');
const codecs = (args.codec ?? 'vp8').split(',') as CodecName[];
const rates = (args.kbps ?? '600').split(',').map(Number);
const amps = (args.amp ?? '2').split(',').map(Number);

for (const clip of clips) {
  for (const codec of codecs) {
    for (const kbps of rates) {
      for (const amplitude of amps) {
        const r = runChannel({
          clip, width: w, height: h, seconds: Number(args.seconds ?? 10),
          codec: { codec, kbps, denoise: args.denoise === '1', preFilter: args.pre, postFilter: args.post },
          amplitude,
          chroma: args.chroma !== undefined ? Number(args.chroma) : undefined,
          modem: {
            ...DEFAULT_MODEM, gridW: gw, gridH: gh,
            planes: Number(args.planes ?? DEFAULT_MODEM.planes),
            symbols: Number(args.symbols ?? DEFAULT_MODEM.symbols),
            edge: Number(args.edge ?? DEFAULT_MODEM.edge),
            fadeMs: Number(args.fade ?? DEFAULT_MODEM.fadeMs),
            fec: (args.fec ?? DEFAULT_MODEM.fec) as 'rs' | 'ldpc',
            redundancy: Number(args.red ?? ((args.fec ?? DEFAULT_MODEM.fec) === 'rs' ? 128 : 125)),
          },
          dropRate: args.drop ? Number(args.drop) : 0,
          outSize: args.out ? { width: Number(args.out.split('x')[0]), height: Number(args.out.split('x')[1]), fps: args.outfps ? Number(args.outfps) : undefined } : undefined,
        });
        console.log(summarize(r));
        if (args.verbose === '2') for (const q of r.perPeriod) console.log('   period ' + q.period + (q.ok ? ' ok ' : ' XX ') + 'score ' + q.score + ' errors/plane ' + q.planeErrors.join(',') + ' amp ' + q.amplitude.join(','));
        if (args.verbose === '1') console.log(r.perPeriod.map((p) => `${p.period}:${p.ok ? 'ok' : 'XX'}(${p.bitErrors},${p.score})`).join(' '));
      }
    }
  }
}
