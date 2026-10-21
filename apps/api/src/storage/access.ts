/**
 * The ownership rule for reading a stored asset, kept out of the route handler
 * so it can be tested on its own and reused by anything else that hands out
 * bytes (a future signed-download endpoint, an export job).
 *
 * The rule is deliberately dull: an asset is readable by its owner and by the
 * users it was shared with by name, and "not yours" is reported identically to
 * "does not exist" so the endpoint can never be used to discover which asset
 * ids are real.
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
  const row = await db.queryOne<AssetKeyRow & { user_id: string }>(
    `SELECT a.storage_key, a.thumb_key, a.mime_type, a.user_id
       FROM assets a
      WHERE a.id = $1
        -- Yours, archived included (the archive grid shows them); or live
        -- and shared with you by name.
        AND (a.user_id = $2
             OR (a.deleted_at IS NULL AND EXISTS (
                   SELECT 1 FROM asset_shares s WHERE s.asset_id = a.id AND s.user_id = $2)))`,
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
  if (!keyBelongsToUser(key, row.user_id)) return { ok: false, reason: 'corrupt', key };

  return { ok: true, key, contentType: isThumb ? 'image/webp' : row.mime_type, isThumb };
}
