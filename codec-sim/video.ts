// Raw I420 video files and real codec round-trips through ffmpeg.
// Requires an ffmpeg build with libvpx, libx264 and libaom on the PATH.

import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const DATA = join(ROOT, 'data');
export const CACHE = join(DATA, 'cache');
export const TMP = join(DATA, 'tmp');
export const RESULTS = join(DATA, 'results');
for (const d of [CACHE, TMP, RESULTS]) mkdirSync(d, { recursive: true });

export function ffmpeg(args: string[]): void {
  const res = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { encoding: 'utf8', maxBuffer: 1 << 26 });
  if (res.status !== 0) throw new Error(`ffmpeg failed: ${args.join(' ')}\n${res.stderr}`);
}

export interface RawInfo {
  path: string;
  width: number;
  height: number;
  frames: number;
  fps: number;
}

export function frameBytes(width: number, height: number): number {
  return width * height + 2 * ((width + 1) >> 1) * ((height + 1) >> 1);
}

export function rawInfo(path: string, width: number, height: number, fps: number): RawInfo {
  return { path, width, height, fps, frames: Math.floor(statSync(path).size / frameBytes(width, height)) };
}

/** Sequential-or-random reader for a raw I420 file. */
export class RawReader {
  readonly info: RawInfo;
  private fd: number;
  private size: number;

  constructor(info: RawInfo) {
    this.info = info;
    this.fd = openSync(info.path, 'r');
    this.size = frameBytes(info.width, info.height);
  }

  /** Reads frame `index`. With `pingPong`, indexes beyond the end walk back and forth so there is never a cut. */
  read(index: number, into?: Uint8Array, pingPong = false): Uint8Array {
    const n = this.info.frames;
    let i = index;
    if (pingPong && n > 1) {
      const cycle = 2 * n - 2;
      i = index % cycle;
      if (i >= n) i = cycle - i;
    }
    if (i < 0 || i >= n) throw new Error(`frame ${index} out of range`);
    const buf = into ?? new Uint8Array(this.size);
    readSync(this.fd, buf, 0, this.size, i * this.size);
    return buf;
  }

  close(): void {
    closeSync(this.fd);
  }
}

export class RawWriter {
  private fd: number;
  readonly path: string;

  constructor(path: string) {
    this.path = path;
    this.fd = openSync(path, 'w');
  }

  write(frame: Uint8Array): void {
    writeSync(this.fd, frame);
  }

  close(): void {
    closeSync(this.fd);
  }
}

export const CLIPS: Record<string, { file: string; fps60: boolean }> = {
  akiyo: { file: 'akiyo_cif.y4m', fps60: false },
  foreman: { file: 'foreman_cif.y4m', fps60: false },
  mother_daughter: { file: 'mother_daughter_cif.y4m', fps60: false },
  news: { file: 'news_cif.y4m', fps60: false },
  silent: { file: 'silent_cif.y4m', fps60: false },
  paris: { file: 'paris_cif.y4m', fps60: false },
  deadline: { file: 'deadline_cif.y4m', fps60: false },
  sign_irene: { file: 'sign_irene_cif.y4m', fps60: false },
  students: { file: 'students_cif.y4m', fps60: false },
  johnny: { file: 'Johnny_1280x720_60.y4m', fps60: true },
  kristen_sara: { file: 'KristenAndSara_1280x720_60.y4m', fps60: true },
  vidyo1: { file: 'vidyo1_720p_60fps.y4m', fps60: true },
  vidyo4: { file: 'vidyo4_720p_60fps.y4m', fps60: true },
};

/**
 * Converts a source clip to cached raw I420 at 30 fps and the requested size.
 * At most `maxFrames` frames are kept (default 300, i.e. 10 seconds).
 */
export function prepareClip(name: string, width: number, height: number, maxFrames = 300): RawInfo {
  const clip = CLIPS[name];
  if (!clip) throw new Error(`unknown clip ${name}`);
  const out = join(CACHE, `${name}_${width}x${height}_${maxFrames}.yuv`);
  if (!existsSync(out)) {
    const filters = [clip.fps60 ? 'fps=30' : null, `scale=${width}:${height}:flags=area`].filter(Boolean).join(',');
    ffmpeg(['-i', join(DATA, 'xiph', clip.file), '-vf', filters, '-frames:v', String(maxFrames), '-f', 'rawvideo', '-pix_fmt', 'yuv420p', out]);
  }
  return rawInfo(out, width, height, 30);
}

export type CodecName = 'vp8' | 'vp9' | 'h264' | 'av1' | 'none';

export interface CodecConfig {
  codec: CodecName;
  kbps: number;
  /** Encoder temporal denoiser, as real-time call stacks enable it for camera video (VP8 and VP9 only). */
  denoise?: boolean;
  /** Extra video filters applied before encoding (scaling, cropping, frame-rate change...). */
  preFilter?: string;
  /** Extra video filters applied after decoding. */
  postFilter?: string;
}

function encoderArgs(c: CodecConfig): string[] {
  const k = `${c.kbps}k`;
  switch (c.codec) {
    case 'vp8':
      // mirrors the settings real-time call stacks use: no lookahead, constant bitrate,
      // one keyframe at the start, error resilience on
      return ['-c:v', 'libvpx', '-deadline', 'realtime', '-cpu-used', '6', '-b:v', k, '-minrate', k, '-maxrate', k,
        '-bufsize', k, '-undershoot-pct', '100', '-overshoot-pct', '15', '-lag-in-frames', '0', '-error-resilient', '1',
        '-g', '3000', '-keyint_min', '3000', '-qmin', '2', '-qmax', '56', '-static-thresh', '1',
        '-noise-sensitivity', c.denoise ? '4' : '0', '-threads', '4'];
    case 'vp9':
      return ['-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '7', '-b:v', k, '-minrate', k, '-maxrate', k,
        '-bufsize', k, '-lag-in-frames', '0', '-error-resilient', '1', '-g', '3000', '-keyint_min', '3000',
        '-qmin', '2', '-qmax', '52', '-aq-mode', '3', '-row-mt', '1', '-tile-columns', '1',
        '-noise-sensitivity', c.denoise ? '1' : '0', '-threads', '4'];
    case 'h264':
      return ['-c:v', 'libx264', '-profile:v', 'baseline', '-preset', 'veryfast', '-tune', 'zerolatency', '-b:v', k,
        '-maxrate', k, '-bufsize', k, '-g', '3000', '-keyint_min', '3000', '-sc_threshold', '0', '-bf', '0', '-refs', '1',
        '-threads', '4'];
    case 'av1':
      return ['-c:v', 'libaom-av1', '-usage', 'realtime', '-cpu-used', '8', '-b:v', k, '-maxrate', k, '-bufsize', k,
        '-lag-in-frames', '0', '-g', '3000', '-keyint_min', '3000', '-aq-mode', '3', '-row-mt', '1', '-threads', '4'];
    default:
      throw new Error('no encoder for ' + c.codec);
  }
}

export interface TranscodeResult {
  out: RawInfo;
  /** Bitrate the encoder actually produced. */
  kbps: number;
}

let counter = 0;
export function tmpPath(ext: string): string {
  return join(TMP, `t${process.pid}_${Date.now()}_${counter++}.${ext}`);
}

export function remove(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // already gone
  }
}

/**
 * Encodes a raw clip with a real encoder and decodes it again.
 * `outSize` is the size after `preFilter`/`postFilter` when they change it.
 */
export function transcode(src: RawInfo, c: CodecConfig, outSize?: { width: number; height: number; fps?: number }): TranscodeResult {
  const outW = outSize?.width ?? src.width;
  const outH = outSize?.height ?? src.height;
  const outFps = outSize?.fps ?? src.fps;
  const outPath = tmpPath('yuv');
  const input = ['-f', 'rawvideo', '-pix_fmt', 'yuv420p', '-s', `${src.width}x${src.height}`, '-r', String(src.fps), '-i', src.path];
  if (c.codec === 'none') {
    const filters = [c.preFilter, c.postFilter].filter(Boolean).join(',');
    ffmpeg([...input, ...(filters ? ['-vf', filters] : []), '-f', 'rawvideo', '-pix_fmt', 'yuv420p', outPath]);
    return { out: rawInfo(outPath, outW, outH, outFps), kbps: 0 };
  }
  const stream = tmpPath('mkv');
  ffmpeg([...input, ...(c.preFilter ? ['-vf', c.preFilter] : []), ...encoderArgs(c), '-an', stream]);
  const bits = statSync(stream).size * 8;
  ffmpeg(['-i', stream, ...(c.postFilter ? ['-vf', c.postFilter] : []), '-f', 'rawvideo', '-pix_fmt', 'yuv420p', outPath]);
  remove(stream);
  const out = rawInfo(outPath, outW, outH, outFps);
  return { out, kbps: bits / (src.frames / src.fps) / 1000 };
}

export function psnr(a: Uint8Array, b: Uint8Array, count: number): number {
  let se = 0;
  for (let i = 0; i < count; i++) {
    const d = a[i] - b[i];
    se += d * d;
  }
  return se === 0 ? 99 : 10 * Math.log10((255 * 255 * count) / se);
}
