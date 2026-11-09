export interface GenOptions {
  length: number;
  upper: boolean;
  lower: boolean;
  digits: boolean;
  symbols: boolean;
}

export const DEFAULT_GEN: GenOptions = { length: 20, upper: true, lower: true, digits: true, symbols: true };

export const SETS = {
  upper: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  lower: 'abcdefghijklmnopqrstuvwxyz',
  digits: '0123456789',
  symbols: '!@#$%^&*-_=+?',
} as const;

/** Uniform integer in [0, n) via rejection sampling. */
export function randomInt(n: number): number {
  if (n <= 0 || n > 2 ** 32) throw new Error('bad range');
  const limit = Math.floor(2 ** 32 / n) * n;
  const buf = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(buf);
    if (buf[0]! < limit) return buf[0]! % n;
  }
}

export function generatePassword(opts: Partial<GenOptions> = {}): string {
  const o = { ...DEFAULT_GEN, ...opts };
  const length = Math.min(128, Math.max(8, Math.floor(o.length) || 20));
  const sets = (Object.keys(SETS) as (keyof typeof SETS)[]).filter((k) => o[k]).map((k) => SETS[k]);
  if (!sets.length) sets.push(SETS.lower);
  const all = sets.join('');
  const chars = sets.map((s) => s[randomInt(s.length)]!);
  while (chars.length < length) chars.push(all[randomInt(all.length)]!);
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j]!, chars[i]!];
  }
  return chars.join('');
}
