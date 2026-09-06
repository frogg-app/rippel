import { describe, expect, it } from 'vitest';

import { MAX_SEED, randomSeed, resolveSeed } from '../seed.js';

describe('randomSeed', () => {
  it('stays a safe, non-negative integer', () => {
    for (let i = 0; i < 500; i += 1) {
      const seed = randomSeed();
      expect(Number.isSafeInteger(seed)).toBe(true);
      expect(seed).toBeGreaterThanOrEqual(0);
      expect(seed).toBeLessThanOrEqual(MAX_SEED);
    }
  });

  it('does not repeat itself in practice', () => {
    const seen = new Set<number>();
    for (let i = 0; i < 1000; i += 1) seen.add(randomSeed());
    expect(seen.size).toBe(1000);
  });

  it('spreads across the range rather than clustering low', () => {
    // A truncation bug (e.g. only using the low bytes) shows up as every value
    // sitting under a small ceiling.
    const max = Math.max(...Array.from({ length: 200 }, () => randomSeed()));
    expect(max).toBeGreaterThan(MAX_SEED / 4);
  });
});

describe('resolveSeed', () => {
  it('passes an explicit seed through, including 0', () => {
    expect(resolveSeed(12345)).toBe(12345);
    expect(resolveSeed(0)).toBe(0);
  });

  it('treats undefined and null alike as "give me a fresh one"', () => {
    expect(Number.isSafeInteger(resolveSeed(undefined))).toBe(true);
    expect(Number.isSafeInteger(resolveSeed(null))).toBe(true);
    expect(resolveSeed(null)).not.toBe(resolveSeed(null));
  });
});
