import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

/**
 * scrypt parameters. N=2^16 with r=8 costs roughly 100ms and 64MB per hash on a
 * modern core, which is the right order of magnitude for a login endpoint.
 * They are stored in the hash string so these can be raised later without
 * invalidating existing passwords.
 */
const PARAMS = { N: 65536, r: 8, p: 1, keylen: 64 };
const MAXMEM = 256 * 1024 * 1024;

/** Produces `scrypt$N$r$p$salt$hash`, all base64url. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const { N, r, p, keylen } = PARAMS;
  const derived = await scrypt(password.normalize('NFKC'), salt, keylen, { N, r, p, maxmem: MAXMEM });
  return ['scrypt', N, r, p, salt.toString('base64url'), derived.toString('base64url')].join('$');
}

/** Constant-time verify. Returns false rather than throwing on a malformed hash. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  const salt = Buffer.from(parts[4]!, 'base64url');
  const expected = Buffer.from(parts[5]!, 'base64url');
  if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p) || expected.length === 0) {
    return false;
  }

  try {
    const derived = await scrypt(password.normalize('NFKC'), salt, expected.length, {
      N, r, p, maxmem: MAXMEM,
    });
    return timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

/**
 * Burn roughly the same time as a real verify when the account does not exist,
 * so the endpoint does not leak which addresses are registered.
 */
export async function fakeVerify(): Promise<void> {
  const { N, r, p, keylen } = PARAMS;
  await scrypt('decoy', randomBytes(16), keylen, { N, r, p, maxmem: MAXMEM });
}
