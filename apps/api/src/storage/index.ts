/**
 * Which driver the process uses, decided once from env.
 *
 * Chosen lazily rather than at import time so that unit tests — and any future
 * CLI that imports a route module — do not have to have S3 credentials or a
 * writable /data just to load the file.
 */

import { env, assertStorageConfigured } from '../env.js';
import { LocalStorageDriver } from './local.js';
import { S3StorageDriver } from './s3.js';
import type { StorageDriver } from './driver.js';

let current: StorageDriver | null = null;

export function storage(): StorageDriver {
  if (current) return current;
  assertStorageConfigured();
  current =
    env.storage.driver === 's3'
      ? new S3StorageDriver({
          endpoint: env.storage.s3Endpoint,
          bucket: env.storage.s3Bucket,
          accessKey: env.storage.s3AccessKey,
          secretKey: env.storage.s3SecretKey,
          region: env.storage.s3Region,
          forcePathStyle: env.storage.s3ForcePathStyle,
        })
      : new LocalStorageDriver(env.storage.localPath);
  return current;
}

/** Test seam: swap in a driver rooted at a temp dir. Pass null to reset. */
export function setStorage(driver: StorageDriver | null): void {
  current = driver;
}

export * from './driver.js';
export { LocalStorageDriver } from './local.js';
export { S3StorageDriver } from './s3.js';
