import { describe, expect, it } from 'vitest';
import { generatePassword, randomInt, SETS } from '../src/lib/generator';

describe('generatePassword', () => {
  it('defaults to 20 chars with every set', () => {
    for (let i = 0; i < 200; i++) {
      const p = generatePassword();
      expect(p).toHaveLength(20);
      expect(p).toMatch(/[A-Z]/);
      expect(p).toMatch(/[a-z]/);
      expect(p).toMatch(/[0-9]/);
      expect([...p].some((c) => SETS.symbols.includes(c))).toBe(true);
    }
  });

  it('clamps length to 8..128', () => {
    expect(generatePassword({ length: 3 })).toHaveLength(8);
    expect(generatePassword({ length: 500 })).toHaveLength(128);
    expect(generatePassword({ length: 64 })).toHaveLength(64);
  });

  it('uses only enabled sets, each at least once', () => {
    for (let i = 0; i < 200; i++) {
      const p = generatePassword({ length: 8, upper: false, symbols: false });
      expect(p).toMatch(/^[a-z0-9]{8}$/);
      expect(p).toMatch(/[a-z]/);
      expect(p).toMatch(/[0-9]/);
    }
    expect(generatePassword({ upper: false, lower: false, symbols: false })).toMatch(/^[0-9]{20}$/);
  });

  it('randomInt stays in range and covers it', () => {
    const seen = new Set<number>();
    for (let i = 0; i < 2000; i++) {
      const n = randomInt(7);
      expect(n).toBeGreaterThanOrEqual(0);
      expect(n).toBeLessThan(7);
      seen.add(n);
    }
    expect(seen.size).toBe(7);
  });
});
