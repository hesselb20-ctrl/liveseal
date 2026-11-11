// Browser loop-back measurements, unattended. Drives an installed Chrome or
// Edge (headless, fresh temporary profile) through the lab page, which runs a
// real WebRTC call between two peer connections in one page, and collects
// what the page measured. Also takes the screenshots used on the landing page.
//
// Needs the dev server (npm run dev) and, for the measurement runs, a test
// clip served from data/test/ (see docs/EVALUATION.md, section 7).
//
// Usage: node scripts/browser-loopback.ts [quick]
// Output: docs/browser-loopback.json, docs/media/lab-*.jpg

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright-core';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const base = process.env.LIVESEAL_URL ?? 'http://localhost:5173';
const quick = process.argv.includes('quick');
const clip = '/data/test/johnny.mp4';
const other = '/data/test/vidyo4.mp4';
const haveClips = existsSync(join(root, 'data', 'test', 'johnny.mp4'));

async function launch(): Promise<Browser> {
  const args = [
    '--autoplay-policy=no-user-gesture-required',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    '--use-fake-ui-for-media-stream',
  ];
  for (const channel of ['chrome', 'msedge']) {
    try {
      return await chromium.launch({ channel, headless: true, args });
    } catch {
      // try the next browser
    }
  }
  throw new Error('No installed Chrome or Edge was found.');
}

type Result = Record<string, unknown>;

async function run(page: Page, path: string, waitSeconds: number): Promise<Result> {
  await page.goto(base + path);
  await page.waitForFunction(() => (window as unknown as { liveseal?: { done?: boolean } }).liveseal?.done === true, null, { timeout: (waitSeconds + 60) * 1000 });
  return page.evaluate(() => (window as unknown as { liveseal: Result }).liveseal);
}

const browser = await launch();
const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: 'dark' });
const page = await context.newPage();
const version = browser.version();
const runs: Result[] = [];
const bank: Result[] = [];
const log = (r: Result) => console.log(JSON.stringify({ codec: r.codec, kbps: r.measuredKbps, size: r.size, attack: r.attack, levels: r.levels, green: r.timeToGreenMs, path: r.path, error: r.error }));

// `rejoin` mode: only the "verifier joins a running call" measurement, merged into the existing file
if (process.argv.includes('rejoin') && haveClips) {
  const r = await run(page, `/lab/?auto=1&codec=VP8&kbps=600&seconds=2&rejoin=12&source=${clip}&other=${other}`, 260);
  const all = r.rejoinGreenMs as number[];
  const ok = all.filter((v) => v >= 0).sort((a, b) => a - b);
  console.log('rejoin', JSON.stringify(all));
  const file = join(root, 'docs', 'browser-loopback.json');
  const data = JSON.parse(readFileSync(file, 'utf8')) as { cost: [string, string][] };
  const label = 'Time to green for a verifier joining a sealed call, VP8 600 kbps';
  const row: [string, string] = [label, `${ok.length} of ${all.length} joins reached green: ${(ok[0] / 1000).toFixed(1)} to ${(ok[ok.length - 1] / 1000).toFixed(1)} s, median ${(ok[ok.length >> 1] / 1000).toFixed(1)} s`];
  data.cost = data.cost.filter((c) => c[0] !== label);
  data.cost.splice(Math.max(0, data.cost.length - 1), 0, row);
  writeFileSync(file, JSON.stringify(data, null, 1) + '\n');
  await browser.close();
  process.exit(0);
}

if (haveClips) {
  const src = `&source=${clip}&other=${other}`;
  const genuine: [string, number, number, string][] = quick
    ? [['VP8', 600, 30, '']]
    : [
      ['VP8', 300, 60, ''], ['VP8', 600, 60, ''], ['VP8', 1000, 60, ''], ['VP8', 2000, 40, ''],
      ['VP9', 300, 60, ''], ['VP9', 600, 60, ''], ['H264', 600, 60, ''], ['H264', 1000, 40, ''], ['AV1', 600, 60, ''],
      ['VP8', 600, 40, '&insertable=1&worker=1'], ['VP8', 600, 40, '&strength=light'],
    ];
  for (const [codec, kbps, seconds, extra] of genuine) {
    try {
      const r = await run(page, `/lab/?auto=1&codec=${codec}&kbps=${kbps}&seconds=${seconds}${src}${extra}`, seconds);
      runs.push(r);
      log(r);
    } catch (err) {
      console.log(`run ${codec} ${kbps} failed: ${(err as Error).message.split('\n')[0]}`);
    }
  }
  // time to green, repeated from a cold start
  const greens: number[] = [];
  for (let i = 0; i < (quick ? 2 : 8); i++) {
    try {
      const r = await run(page, `/lab/?auto=1&codec=VP8&kbps=600&seconds=14${src}`, 14);
      if (typeof r.timeToGreenMs === 'number' && r.timeToGreenMs >= 0) greens.push(r.timeToGreenMs);
    } catch {
      // counted as missing
    }
  }
  // time to green for a verifier that joins a call which is already sealed
  let rejoin: number[] = [];
  try {
    const r = await run(page, `/lab/?auto=1&codec=VP8&kbps=600&seconds=2&rejoin=${quick ? 3 : 12}${src}`, 260);
    rejoin = (r.rejoinGreenMs as number[]).filter((v) => v >= 0);
    console.log('rejoin', JSON.stringify(r.rejoinGreenMs));
  } catch (err) {
    console.log(`rejoin run failed: ${(err as Error).message.split('\n')[0]}`);
  }
  const attacks: [string, string][] = [
    ['strip', 'Fake picture, no seal (T1)'], ['replay', 'Sealed recording played 5 minutes later (T2)'],
    ['swap', 'Another face pasted in under the copied seal (T3)'], ['other', 'Another person under the copied seal (T3)'],
    ['impostor', 'Sealed with a key the receiver never verified (T5)'], ['revoked', 'Sealed with a revoked key (T6)'],
  ];
  for (const [attack, label] of quick ? attacks.slice(2, 3) : attacks) {
    try {
      const r = await run(page, `/lab/?auto=1&codec=VP8&kbps=600&seconds=22&attack=${attack}&attackAfter=14${src}`, 40);
      r.attackLabel = label;
      runs.push(r);
      log(r);
    } catch (err) {
      console.log(`attack ${attack} failed: ${(err as Error).message.split('\n')[0]}`);
    }
  }
  // cost at 720p
  let cost720: Result | null = null;
  if (existsSync(join(root, 'data', 'test', 'johnny720.mp4'))) {
    try {
      cost720 = await run(page, `/lab/?auto=1&codec=VP8&kbps=2000&seconds=30&source=/data/test/johnny720.mp4&other=${other}`, 30);
      log(cost720);
    } catch {
      cost720 = null;
    }
  }
  for (const who of quick ? ['agent'] : ['agent', 'stolen', 'fake', 'none']) {
    try {
      const r = await run(page, `/demo-bank/?auto=${who}&seconds=22&source=${clip}`, 30);
      bank.push(r);
      console.log(JSON.stringify(r));
    } catch (err) {
      console.log(`demo bank ${who} failed: ${(err as Error).message.split('\n')[0]}`);
    }
  }
  const base600 = runs.find((r) => r.attack === 'none' && r.codec === 'video/VP8' && r.targetKbps === 600 && String(r.path).startsWith('canvas'));
  const ms = (v: unknown) => (typeof v === 'number' ? `${v.toFixed(2)} ms` : 'n/a');
  const share = (v: unknown) => (typeof v === 'number' ? `${((v / (1000 / 30)) * 100).toFixed(1)}% of one core at 30 fps` : 'n/a');
  const cost: [string, string][] = [
    ['Browser', `${version} (headless)`],
    ['Sealing, 640x360, per frame', `${ms(base600?.sealCostMs)} (${share(base600?.sealCostMs)})`],
    ['Verifying, per frame', `${ms(base600?.verifyCostMs)} (${share(base600?.verifyCostMs)})`],
  ];
  if (cost720) {
    cost.push(['Sealing, 1280x720, per frame', `${ms(cost720.sealCostMs)} (${share(cost720.sealCostMs)})`]);
    cost.push(['1280x720 run', `${cost720.codec} at ${cost720.measuredKbps} kbps, encoded ${cost720.size}, badge per period \`${cost720.levels}\``]);
  }
  if (greens.length) {
    greens.sort((a, b) => a - b);
    cost.push(['Time to green from a cold start, VP8 600 kbps', `${greens.length} runs: ${(greens[0] / 1000).toFixed(1)} to ${(greens[greens.length - 1] / 1000).toFixed(1)} s, median ${(greens[greens.length >> 1] / 1000).toFixed(1)} s`]);
  }
  if (rejoin.length) {
    rejoin.sort((a, b) => a - b);
    cost.push(['Time to green for a verifier joining a sealed call, VP8 600 kbps', `${rejoin.length} joins: ${(rejoin[0] / 1000).toFixed(1)} to ${(rejoin[rejoin.length - 1] / 1000).toFixed(1)} s, median ${(rejoin[rejoin.length >> 1] / 1000).toFixed(1)} s`]);
  }
  cost.push(['Per-frame cost covers', 'the page\'s own work (reduction, digest, shader draw, sampling, decoding); the camera and the video encoder are extra']);
  const file = join(root, 'docs', 'browser-loopback.json');
  const previous = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  writeFileSync(file, JSON.stringify({ ...previous, measured: new Date().toISOString().slice(0, 10), browser: version, runs, bank, cost }, null, 1) + '\n');
  console.log('wrote docs/browser-loopback.json');
} else {
  console.log('data/test/johnny.mp4 not found: skipping the measurement runs');
}

// screenshots for the landing page, with the drawn stand-in (no real person)
mkdirSync(join(root, 'docs', 'media'), { recursive: true });
try {
  await page.goto(`${base}/lab/`);
  await page.addStyleTag({ content: '.nav{position:static}' });
  await page.click('#start');
  await page.waitForFunction(() => document.querySelector('.ls-badge')?.getAttribute('data-level') === 'green', null, { timeout: 40000 });
  await page.waitForTimeout(800);
  await page.locator('main .grid.two').first().screenshot({ path: join(root, 'docs', 'media', 'lab-verified.jpg'), quality: 82, type: 'jpeg' });
  await page.click('button[data-attack="swap"]');
  await page.waitForFunction(() => document.querySelector('.ls-badge')?.getAttribute('data-level') === 'red', null, { timeout: 40000 });
  await page.waitForTimeout(800);
  await page.locator('main .grid.two').first().screenshot({ path: join(root, 'docs', 'media', 'lab-swapped.jpg'), quality: 82, type: 'jpeg' });
  console.log('wrote docs/media/lab-verified.jpg and lab-swapped.jpg');
} catch (err) {
  console.log(`screenshots failed: ${(err as Error).message.split('\n')[0]}`);
}
await browser.close();
