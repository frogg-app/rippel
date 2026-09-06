/**
 * The ownership rule for reading an upload back.
 *
 * Identical in spirit to `storage/access.ts`, and identical in outcome: an
 * upload is readable by exactly one user, and "not yours" is indistinguishable
 * from "does not exist" so the endpoint cannot be used to probe for real ids.
 * It is a separate function only because it reads a different table — sharing
 * one query by interpolating a table name is exactly the kind of cleverness
 * that turns a typo into a cross-user leak.
 */

import { keyBelongsToUser } from '../storage/driver.js';
import type { UploadDb } from './store.js';

export interface UploadKeyRow {
  storage_key: string;
  thumb_key: string | null;
  mime_type: string | null;
}

export type UploadAccess =
  | { ok: true; key: string; contentType: string | null; isThumb: boolean }
  /** `corrupt` means the row exists but its key is outside the owner's prefix. */
  | { ok: false; reason: 'not_found' | 'corrupt'; key?: string };

export async function resolveUploadForRead(
  db: UploadDb,
  uploadId: string,
  userId: string,
  variant: 'full' | 'thumb',
): Promise<UploadAccess> {
  const row = await db.queryOne<UploadKeyRow>(
    `SELECT storage_key, thumb_key, mime_type
       FROM uploads
      WHERE id = $1 AND user_id = $2`,
    [uploadId, userId],
  );
  if (!row) return { ok: false, reason: 'not_found' };

  const isThumb = variant === 'thumb' && !!row.thumb_key;
  const key = isThumb ? row.thumb_key! : row.storage_key;

  // Belt and braces, as in storage/access.ts: keys are written under
  // `u/<userId>/`, so one that is not means the row is corrupt — never that
  // this read should be allowed.
  if (!keyBelongsToUser(key, userId)) return { ok: false, reason: 'corrupt', key };

  return { ok: true, key, contentType: isThumb ? 'image/webp' : row.mime_type, isThumb };
}
