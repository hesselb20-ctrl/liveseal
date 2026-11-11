// Challenge codes. A challenge is 3 random bytes shown as 3 words from a
// 256-word list, so it can be read out during a call and typed by the caller.

export const CHALLENGE_LENGTH = 3;

export const WORDS: readonly string[] = [
  'apple', 'arrow', 'autumn', 'badge', 'bakery', 'balloon', 'bamboo', 'banana', 'basket', 'beach', 'beacon', 'berry', 'bicycle', 'blanket', 'blossom', 'bottle',
  'branch', 'breeze', 'bridge', 'bubble', 'bucket', 'butter', 'button', 'cabin', 'cactus', 'camel', 'candle', 'canyon', 'carpet', 'castle', 'cedar', 'cherry',
  'circle', 'citrus', 'clover', 'cobalt', 'coffee', 'comet', 'copper', 'coral', 'cotton', 'cradle', 'crayon', 'cricket', 'crystal', 'cushion', 'daisy', 'dancer',
  'desert', 'diamond', 'dolphin', 'donkey', 'dragon', 'drummer', 'eagle', 'ember', 'engine', 'falcon', 'feather', 'fiddle', 'forest', 'fossil', 'fountain', 'galaxy',
  'garden', 'garlic', 'ginger', 'glacier', 'goblet', 'granite', 'guitar', 'hammer', 'harbor', 'harvest', 'hazel', 'helmet', 'hickory', 'honey', 'horizon', 'island',
  'ivory', 'jacket', 'jasmine', 'jelly', 'jungle', 'kettle', 'kitten', 'ladder', 'lagoon', 'lantern', 'lemon', 'lilac', 'lizard', 'lobster', 'magnet', 'mango',
  'maple', 'marble', 'meadow', 'melon', 'mirror', 'mitten', 'monkey', 'mountain', 'muffin', 'nectar', 'needle', 'noodle', 'nutmeg', 'oasis', 'ocean', 'olive',
  'onion', 'orange', 'orchid', 'otter', 'oyster', 'paddle', 'pancake', 'panda', 'parrot', 'pebble', 'pencil', 'pepper', 'pigeon', 'pillow', 'planet', 'pocket',
  'pony', 'poppy', 'potato', 'pumpkin', 'puzzle', 'quartz', 'rabbit', 'raccoon', 'radish', 'rainbow', 'raven', 'ribbon', 'river', 'rocket', 'saddle', 'salmon',
  'sandal', 'sapphire', 'scooter', 'shadow', 'shovel', 'silver', 'sparrow', 'spider', 'spinach', 'sponge', 'squirrel', 'stable', 'sunset', 'table', 'teapot', 'temple',
  'thimble', 'thunder', 'ticket', 'tiger', 'timber', 'tomato', 'tractor', 'trumpet', 'tulip', 'tunnel', 'turtle', 'umbrella', 'valley', 'velvet', 'violin', 'walnut',
  'wagon', 'waffle', 'whistle', 'willow', 'window', 'winter', 'wizard', 'yogurt', 'zebra', 'zipper', 'anchor', 'acorn', 'almond', 'antler', 'apricot', 'atlas',
  'badger', 'barrel', 'beaver', 'biscuit', 'bonnet', 'buffalo', 'cannon', 'canoe', 'carrot', 'cashew', 'chimney', 'cinder', 'compass', 'cookie', 'curtain', 'dagger',
  'domino', 'eclipse', 'emerald', 'fabric', 'ferry', 'flannel', 'garnet', 'gazelle', 'giraffe', 'hamlet', 'hornet', 'iceberg', 'igloo', 'jaguar', 'kayak', 'koala',
  'locket', 'mammoth', 'marigold', 'mustard', 'napkin', 'nickel', 'orchard', 'ostrich', 'parsley', 'peacock', 'pelican', 'penguin', 'pretzel', 'quiver', 'raisin', 'rooster',
  'satchel', 'scarlet', 'shamrock', 'sherbet', 'sleigh', 'spruce', 'stadium', 'sundial', 'tadpole', 'toffee', 'topaz', 'trolley', 'turnip', 'vessel', 'walrus', 'yonder',
];

const INDEX = new Map<string, number>(WORDS.map((w, i) => [w, i]));

export function challengeToWords(challenge: Uint8Array): string {
  if (challenge.length !== CHALLENGE_LENGTH) throw new Error('challenge must be 3 bytes');
  return Array.from(challenge, (b) => WORDS[b]).join(' ');
}

/**
 * Parses typed or dictated words. Accepts any mix of spaces, commas and
 * hyphens, ignores case, and returns null if a word is not on the list.
 */
export function wordsToChallenge(text: string): Uint8Array | null {
  const parts = text.toLowerCase().split(/[^a-z]+/).filter(Boolean);
  if (parts.length !== CHALLENGE_LENGTH) return null;
  const out = new Uint8Array(CHALLENGE_LENGTH);
  for (let i = 0; i < parts.length; i++) {
    const idx = INDEX.get(parts[i]);
    if (idx === undefined) return null;
    out[i] = idx;
  }
  return out;
}

/** Suggests the closest list word for a mistyped one (edit distance 1 or 2), for the typing UI. */
export function suggestWord(typed: string): string | null {
  const t = typed.toLowerCase();
  if (INDEX.has(t)) return t;
  let best: string | null = null;
  let bestDist = 3;
  for (const w of WORDS) {
    if (Math.abs(w.length - t.length) >= bestDist) continue;
    const d = editDistance(t, w, bestDist);
    if (d < bestDist) {
      bestDist = d;
      best = w;
    }
  }
  return best;
}

function editDistance(a: string, b: string, cap: number): number {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      cur.push(v);
      if (v < rowMin) rowMin = v;
    }
    if (rowMin >= cap) return cap;
    prev = cur;
  }
  return prev[b.length];
}
