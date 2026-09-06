/**
 * The storage driver interface.
 *
 * Two implementations ship: `local` (a directory on disk, the zero-dependency
 * default) and `s3` (any S3-compatible endpoint, including the optional MinIO
 * service in docker-compose). Everything above this line — persisting a
 * finished generation, serving it back — only ever sees this interface, so
 * swapping the backing store is an env var and nothing else.
 */

import { randomBytes } from 'node:crypto';
import type { Readable } from 'node:stream';

export interface StoredObject {
  stream: Readable;
  contentType: string;
  /** Bytes, when the driver can say without reading the object. */
  size: number | null;
}

export interface StorageDriver {
  readonly name: 'local' | 's3';

  /** Write (or overwrite) `key`. Writing the same key twice is idempotent. */
  put(key: string, body: Buffer, contentType: string): Promise<void>;

  /** Read the whole object. Throws {@link StorageNotFound} if it is missing. */
  get(key: string): Promise<Buffer>;

  /**
   * Open the object for streaming to an HTTP response, so serving a 6 MB PNG
   * never buffers it in the API process.
   */
  getStream(key: string): Promise<StoredObject>;

  exists(key: string): Promise<boolean>;

  /** Deleting a key that is already gone succeeds. */
  delete(key: string): Promise<void>;
}

export class StorageNotFound extends Error {
  constructor(readonly key: string) {
    super(`No stored object at ${key}`);
    this.name = 'StorageNotFound';
  }
}

/** Content types we are willing to store and hand back to a browser. */
const EXTENSION_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  avif: 'image/avif',
  mp4: 'video/mp4',
  webm: 'video/webm',
};

export function contentTypeForKey(key: string): string {
  const ext = key.split('.').pop()?.toLowerCase() ?? '';
  return EXTENSION_TYPES[ext] ?? 'application/octet-stream';
}

/**
 * Build a storage key.
 *
 * Two properties matter and both are enforced here rather than at call sites:
 *
 *  - **Namespaced per user.** Every key starts `u/<userId>/`, so a bug in a
 *    listing query cannot mix two people's files, an object-store policy can be
 *    written per prefix, and the read route's ownership check is a prefix test.
 *  - **Non-guessable.** The leaf is 16 random bytes, never the job id or the
 *    ComfyUI filename. If a URL leaks or a bucket is misconfigured, the
 *    neighbouring keys still cannot be enumerated by counting upwards.
 *
 * The date segment exists only so an operator browsing the volume, or a future
 * retention sweep, can work by month without listing millions of keys.
 */
export function buildKey(opts: {
  userId: string;
  extension: string;
  variant?: 'thumb';
  now?: Date;
}): string {
  const now = opts.now ?? new Date();
  const yyyy = String(now.getUTCFullYear());
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  const ext = opts.extension.replace(/^\./, '').toLowerCase();
  const id = randomBytes(16).toString('hex');
  const suffix = opts.variant ? `_${opts.variant}` : '';
  return `u/${opts.userId}/${yyyy}/${mm}/${id}${suffix}.${ext}`;
}

/**
 * Reject keys that could escape the namespace. The local driver joins keys onto
 * a root path, so `..` traversal has to die before it reaches the filesystem;
 * the S3 driver gets the same check so the two behave identically.
 */
const SAFE_KEY = /^[A-Za-z0-9][A-Za-z0-9/_.-]{0,511}$/;

export function assertSafeKey(key: string): void {
  if (!SAFE_KEY.test(key) || key.split('/').some((s) => s === '' || s === '.' || s === '..')) {
    throw new Error(`Unsafe storage key: ${JSON.stringify(key)}`);
  }
}

/** Does `key` belong to `userId`? The rule the read route enforces. */
export function keyBelongsToUser(key: string, userId: string): boolean {
  return key.startsWith(`u/${userId}/`);
}
