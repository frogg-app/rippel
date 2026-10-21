/**
 * Emptying the archive: rows first, then bytes.
 *
 * The row goes before the object on purpose. A row whose object is missing
 * serves a 404 and is otherwise harmless; an object whose row is missing is a
 * leak nobody will ever find. So a storage error after the DELETE is logged
 * and left, never retried by putting the row back.
 */
import { env } from '../env.js';
import type { StorageDriver } from '../storage/driver.js';
import { storage } from '../storage/index.js';
import { purgeArchived, realDb, type LibraryDb, type PurgedKeys } from './queries.js';

export async function removeObjects(
  keys: readonly PurgedKeys[],
  driver: StorageDriver = storage(),
  log: (msg: string) => void = () => {},
): Promise<void> {
  for (const row of keys) {
    for (const key of [row.storage_key, row.thumb_key]) {
      if (!key) continue;
      await driver.delete(key).catch((err: unknown) => log(`could not remove ${key}: ${String(err)}`));
    }
  }
}

/** One sweep of the retention rule. Returns how many assets went. */
export async function purgeExpired(
  log: (msg: string) => void,
  db: LibraryDb = realDb,
  days = env.storage.archiveRetentionDays,
): Promise<number> {
  const keys = await purgeArchived(db, { olderThanDays: days });
  await removeObjects(keys, undefined, log);
  if (keys.length > 0) log(`purged ${keys.length} archived asset(s) older than ${days} days`);
  return keys.length;
}
