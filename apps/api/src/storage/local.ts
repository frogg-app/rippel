/**
 * Local-filesystem storage driver — the default, and the reason `docker compose
 * up` needs no object store at all. Keys map one-to-one onto paths under a
 * configured root (a named volume in Compose, a temp dir in tests).
 */

import { createReadStream } from 'node:fs';
import { mkdir, rename, rm, stat, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  assertSafeKey,
  contentTypeForKey,
  StorageNotFound,
  type StorageDriver,
  type StoredObject,
} from './driver.js';

function isMissing(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | null)?.code === 'ENOENT';
}

export class LocalStorageDriver implements StorageDriver {
  readonly name = 'local' as const;
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  /**
   * Resolve a key to a path and prove the result is still inside the root.
   * `assertSafeKey` already rejects traversal, but a symlinked root or a future
   * caller with its own key format makes the second check worth its two lines.
   */
  private pathFor(key: string): string {
    assertSafeKey(key);
    const full = resolve(join(this.root, key));
    if (full !== this.root && !full.startsWith(this.root + sep)) {
      throw new Error(`Storage key escapes the root: ${JSON.stringify(key)}`);
    }
    return full;
  }

  async put(key: string, body: Buffer, _contentType: string): Promise<void> {
    const path = this.pathFor(key);
    await mkdir(dirname(path), { recursive: true });
    // Write to a sibling temp file and rename in. A crash mid-write then leaves
    // either the old object or none, never a truncated image that would be
    // served to the library as a broken thumbnail.
    const tmp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      await writeFile(tmp, body);
      await rename(tmp, path);
    } catch (err) {
      await rm(tmp, { force: true });
      throw err;
    }
  }

  async get(key: string): Promise<Buffer> {
    try {
      return await readFile(this.pathFor(key));
    } catch (err) {
      if (isMissing(err)) throw new StorageNotFound(key);
      throw err;
    }
  }

  async getStream(key: string): Promise<StoredObject> {
    const path = this.pathFor(key);
    let size: number;
    try {
      size = (await stat(path)).size;
    } catch (err) {
      if (isMissing(err)) throw new StorageNotFound(key);
      throw err;
    }
    return { stream: createReadStream(path), contentType: contentTypeForKey(key), size };
  }

  async exists(key: string): Promise<boolean> {
    try {
      await stat(this.pathFor(key));
      return true;
    } catch (err) {
      if (isMissing(err)) return false;
      throw err;
    }
  }

  async delete(key: string): Promise<void> {
    await rm(this.pathFor(key), { force: true });
  }
}
