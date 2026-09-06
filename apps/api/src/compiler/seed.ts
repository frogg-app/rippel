/**
 * Seeds.
 *
 * A generation is only reproducible if the *concrete* seed is recorded, so the
 * compiler always resolves one and hands it back — "random" is a UI state, never
 * a stored one. `Math.random` is deliberately not used: seeds end up in shared
 * library links and in re-run URLs, and a predictable PRNG makes distinct users'
 * jobs collide in ways that are tedious to debug and mildly privacy-leaking.
 */

import { randomBytes } from 'node:crypto';

/**
 * Upper bound. ComfyUI accepts up to 2^64-1, but a seed that survives JSON,
 * Postgres `bigint` reads through `pg` (which hands back JS numbers) and the
 * browser must stay inside Number.MAX_SAFE_INTEGER. We therefore draw from
 * [0, 2^53-1] — 9e15 values, ample entropy, exactly representable everywhere.
 */
export const MAX_SEED = Number.MAX_SAFE_INTEGER; // 2^53 - 1

export function randomSeed(): number {
  // 7 bytes = 56 bits, reduced to 53. The 3-bit shift is a clean truncation
  // rather than a modulo, so every value stays uniformly likely.
  const bytes = randomBytes(7);
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  return Number(value >> 3n);
}

/**
 * `undefined` or `null` mean "give me a fresh one" — the two are equivalent
 * because the UI sends null for an explicitly-cleared seed field and omits the
 * key entirely when the advanced drawer was never opened.
 */
export function resolveSeed(requested: number | null | undefined): number {
  if (requested === undefined || requested === null) return randomSeed();
  return requested;
}
