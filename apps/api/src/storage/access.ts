/**
 * The ownership rule for reading a stored asset, kept out of the route handler
 * so it can be tested on its own and reused by anything else that hands out
 * bytes (a future signed-download endpoint, an export job).
 *
 * The rule is deliberately dull: an asset is readable by exactly one user, and
 * "not yours" is reported identically to "does not exist" so the endpoint can
 * never be used to discover which asset ids are real.
 */

import type { AssetDb } from './persist.js';
import { keyBelongsToUser } from './driver.js';

export interface AssetKeyRow {
  storage_key: string;
  thumb_key: string | null;
  mime_type: string | null;
}

export type AssetAccess =
  | { ok: true; key: string; contentType: string | null; isThumb: boolean }
  /** `corrupt` means the row exists but its key is outside the owner's prefix. */
  | { ok: false; reason: 'not_found' | 'corrupt'; key?: string };

export async function resolveAssetForRead(
  db: AssetDb,
  assetId: string,
  userId: string,
  variant: 'full' | 'thumb',
): Promise<AssetAccess> {
  const row = await db.queryOne<AssetKeyRow>(
    `SELECT storage_key, thumb_key, mime_type
       FROM assets
      WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
    [assetId, userId],
  );
  if (!row) return { ok: false, reason: 'not_found' };

  // A thumbnail that failed to generate falls back to the full image: a slow
  // tile beats a broken one.
  const isThumb = variant === 'thumb' && !!row.thumb_key;
  const key = isThumb ? row.thumb_key! : row.storage_key;

  // Belt and braces. Keys are written under `u/<userId>/`, so one that is not
  // means the row is corrupt or was written by an older, buggier path — never
  // that this read should be allowed.
  if (!keyBelongsToUser(key, userId)) return { ok: false, reason: 'corrupt', key };

  return { ok: true, key, contentType: isThumb ? 'image/webp' : row.mime_type, isThumb };
}
