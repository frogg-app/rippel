/**
 * One-time pairing codes: the whole enrolment credential, in eight characters.
 *
 * A machine joins a rippel by being told two things a person can read aloud —
 * where rippel is, and a code. That replaces a scheme where the *download* was
 * per-deployment and carried the token in its own filename, which meant every
 * rippel served its own executable and a renamed file broke the install.
 *
 * The code is redeemed with no session, because the machine being set up has no
 * rippel login — that is the point of it. So the code *is* a credential and is
 * treated as one throughout: hashed at rest, never logged, never put in a URL,
 * single-use, short-lived, and rate-limited on the way in.
 */

import { createHash, randomInt, timingSafeEqual } from 'node:crypto';

/**
 * The alphabet, chosen so a code can be read over a phone and typed back.
 *
 * Omitted: `O` and `0`, `I` and `1` and `L`. Those are the pairs a person
 * actually confuses, in both directions — reading a code aloud and typing one
 * they were sent. Removing both members of each pair is stronger than mapping
 * one onto the other, because it means no code can ever *contain* an ambiguous
 * character, so there is no pair to resolve at redemption.
 *
 * 31 characters, 8 of them: 31^8 ≈ 8.5e11 codes. Against the rate limit below
 * (10 attempts per IP per 15 minutes) guessing is not a threat model; the
 * lifetime is what bounds it, not the length alone.
 */
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

export const CODE_LENGTH = 8;

/** How long a code is good for. Minutes, not days — it is a credential. */
export const CODE_TTL_MS = 15 * 60 * 1000;

/**
 * A fresh code.
 *
 * `randomInt` rather than `randomBytes` with a modulo: the alphabet's length is
 * not a power of two, so a modulo would make the first few characters slightly
 * likelier than the rest. `randomInt` rejects-and-retries internally, which is
 * the correct unbiased draw and costs nothing at this size.
 */
export function generateCode(): string {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) code += ALPHABET[randomInt(ALPHABET.length)];
  return code;
}

/**
 * What a human typed, as the stored form.
 *
 * Case-insensitive, and separators are forgiven: people write a code down with
 * a dash or a space in the middle whether or not they were shown one, and
 * refusing that would be pedantry at exactly the wrong moment.
 *
 * Returns null when the result is not a well-formed code — including when it
 * contains a character the alphabet deliberately excludes. There is nothing
 * sensible to fold `0` or `I` *onto*, since neither their lookalikes nor they
 * themselves are ever in a real code, so the honest answer is to refuse and let
 * the route say so.
 */
export function normaliseCode(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  // Strip anything a person might use to group the characters, but nothing
  // else: a stray letter must fail rather than be silently dropped.
  const text = raw.trim().toUpperCase().replace(/[\s_-]+/g, '');
  if (text.length !== CODE_LENGTH) return null;
  for (const character of text) {
    if (!ALPHABET.includes(character)) return null;
  }
  return text;
}

/**
 * The stored form of a code.
 *
 * A plain SHA-256, deliberately not a slow KDF: the input is 40 bits of uniform
 * randomness from a generator we control, not a human-chosen password, so there
 * is no dictionary to run and nothing for a work factor to buy. What the hash is
 * for is making a database dump useless for pairing.
 */
export function hashCode(normalised: string): string {
  return createHash('sha256').update(normalised, 'utf8').digest('hex');
}

/**
 * Constant-time equality for two hex hashes.
 *
 * The lookup itself is an indexed equality on the hash, which is not a timing
 * oracle — an index tells an attacker nothing they could measure about a value
 * they already supplied. This exists for the comparison the route makes *after*
 * loading a row, so that no code path anywhere compares a credential with `===`.
 */
export function hashesMatch(a: string, b: string): boolean {
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  if (left.length !== right.length || left.length === 0) return false;
  return timingSafeEqual(left, right);
}

/**
 * A fixed-window counter, per key.
 *
 * In memory, and therefore per API process: this rippel runs as one process, and
 * a limiter that needed Postgres to say "no" would be doing a write per guess,
 * which is the thing being defended against. If rippel is ever run as several
 * processes behind a load balancer, this becomes per-process and wants moving to
 * Redis — that is a real limitation and it is written down rather than implied.
 */
export class RateLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  /** Count one attempt. False when this key is over its limit. */
  take(key: string, now = Date.now()): boolean {
    // Opportunistic sweep: this map is only ever as large as the number of
    // distinct callers in one window, and pairing is rare.
    if (this.hits.size > 10_000) {
      for (const [k, v] of this.hits) if (v.resetAt <= now) this.hits.delete(k);
    }

    const existing = this.hits.get(key);
    if (!existing || existing.resetAt <= now) {
      this.hits.set(key, { count: 1, resetAt: now + this.windowMs });
      return true;
    }
    existing.count += 1;
    return existing.count <= this.limit;
  }

  /** Forget a key — called on success, so a good pairing does not count. */
  clear(key: string): void {
    this.hits.delete(key);
  }

  /** Test seam. */
  reset(): void {
    this.hits.clear();
  }
}

/**
 * Redemption attempts from one address.
 *
 * Ten in fifteen minutes is far above what setting a machine up takes (one, or
 * two after a typo) and far below what guessing 31^8 needs.
 */
export const redeemByIp = new RateLimiter(10, 15 * 60 * 1000);

/**
 * Redemption attempts against one deployment, counted once a code has actually
 * matched a row. This is the per-deployment half the contract asks for: it
 * bounds what a distributed set of addresses can do to a single machine's
 * enrolment, which the per-IP limit alone does not.
 */
export const redeemByDeployment = new RateLimiter(10, 15 * 60 * 1000);

/** Issuing is an admin action, but an admin should not be able to spin either. */
export const issueByDeployment = new RateLimiter(20, 15 * 60 * 1000);

/** Test seam: forget every window. */
export function resetPairingLimits(): void {
  redeemByIp.reset();
  redeemByDeployment.reset();
  issueByDeployment.reset();
}
