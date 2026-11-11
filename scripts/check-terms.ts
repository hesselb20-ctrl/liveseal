// Release check: makes sure certain words never appear in the repository or
// in its history. The word list is kept as character codes so that this file
// does not itself contain the words it looks for.
// Run with: node scripts/check-terms.ts

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const TERMS = [
  [99, 108, 97, 117, 100, 101], [97, 110, 116, 104, 114, 111, 112, 105, 99], [102, 97, 98, 108, 101],
  [99, 104, 97, 116, 103, 112, 116], [111, 112, 101, 110, 97, 105], [99, 111, 112, 105, 108, 111, 116],
  [103, 101, 109, 105, 110, 105], [99, 111, 45, 97, 117, 116, 104, 111, 114, 101, 100, 45, 98, 121],
  [103, 101, 110, 101, 114, 97, 116, 101, 100, 32, 119, 105, 116, 104], [108, 108, 109],
  [97, 105, 32, 97, 115, 115, 105, 115, 116, 97, 110, 116], [97, 105, 45, 103, 101, 110, 101, 114, 97, 116, 101, 100],
].map((codes) => String.fromCharCode(...codes));

const git = (args: string[]) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 1 << 28 });
const pattern = new RegExp(`\\b(${TERMS.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`, 'i');
const problems: string[] = [];

for (const file of git(['ls-files', '-z']).split('\0').filter(Boolean)) {
  if (/\.(png|jpg|jpeg|webp|mp4|tflite|wasm|ico)$/i.test(file)) continue;
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    continue;
  }
  text.split('\n').forEach((line, i) => {
    const hit = pattern.exec(line);
    if (hit) problems.push(`${file}:${i + 1}: "${hit[0]}"`);
  });
  if (pattern.test(file)) problems.push(`file name: ${file}`);
}

// every commit on every ref: author, committer and message
const log = git(['log', '--all', '--format=%H%x1f%an%x1f%ae%x1f%cn%x1f%ce%x1f%B%x1e']);
for (const entry of log.split('\x1e')) {
  const [hash, ...rest] = entry.trim().split('\x1f');
  if (!hash) continue;
  const hit = pattern.exec(rest.join('\n'));
  if (hit) problems.push(`commit ${hash.slice(0, 10)}: "${hit[0]}"`);
}

if (problems.length) {
  console.error(`Found ${problems.length} problem(s):\n` + problems.join('\n'));
  process.exit(1);
}
console.log('check-terms: clean (tracked files and all commit metadata)');
