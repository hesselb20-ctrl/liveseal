// End-to-end test of the recording checker in a real browser: pairs with the
// test key through the page's own pairing panel, then checks the recordings
// made by codec-sim/make-recording.ts and prints each report.
//
// Usage: node scripts/browser-checker.ts <pairing code> <file.webm> [more files]

import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const base = process.env.LIVESEAL_URL ?? 'http://localhost:5173';
const [code, ...files] = process.argv.slice(2);
if (!code || files.length === 0) {
  console.error('usage: node scripts/browser-checker.ts <pairing code> <file.webm> [more files]');
  process.exit(1);
}
const args = ['--autoplay-policy=no-user-gesture-required', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'];
let browser;
for (const channel of ['chrome', 'msedge']) {
  try {
    browser = await chromium.launch({ channel, headless: true, args });
    break;
  } catch {
    // try the next one
  }
}
if (!browser) throw new Error('No installed Chrome or Edge was found.');
const page = await (await browser.newContext()).newPage();
page.on('dialog', (d) => void d.accept()); // the pairing confirmation
await page.goto(`${base}/verifier/checker.html`);
await page.fill('#contacts textarea', code);
await page.click('#contacts button.primary');
await page.waitForFunction(() => document.querySelector('#contacts')?.textContent?.includes('Recorded caller'));

const results: Record<string, unknown>[] = [];
for (const file of files) {
  await page.reload();
  await page.setInputFiles('#file', file);
  await page.waitForFunction(() => (document.getElementById('download') as HTMLButtonElement | null)?.disabled === false
    || /too short|cannot play/.test(document.getElementById('summary')?.textContent ?? ''), null, { timeout: 120000 });
  const report = await page.evaluate(() => ({
    summary: [...document.querySelectorAll('#summary p')].map((p) => p.textContent),
    rows: [...document.querySelectorAll('#rows tr')].map((tr) => [...tr.children].map((td) => td.textContent).join(' | ')),
  }));
  console.log(`\n${file}`);
  for (const line of report.summary) console.log('  ' + line);
  for (const row of report.rows) console.log('    ' + row);
  results.push({ file: file.split(/[\\/]/).pop(), ...report });
}
await browser.close();
const out = join(root, 'docs', 'browser-loopback.json');
const previous = existsSync(out) ? JSON.parse(readFileSync(out, 'utf8')) : {};
writeFileSync(out, JSON.stringify({ ...previous, checker: results }, null, 1) + '\n');
