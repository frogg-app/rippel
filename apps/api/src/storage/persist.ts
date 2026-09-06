/**
 * Turning a finished ComfyUI output into a row in `assets`.
 *
 * bytes -> storage -> thumbnail -> INSERT. The orchestrator calls this once per
 * output file of a completed job; the restart reconciliation pass calls it again
 * for the same files, which is why every step here is safe to repeat.
 */

import type { Asset } from '@comfy/shared';
import { query as defaultQuery, queryOne as defaultQueryOne } from '../db.js';
import { env } from '../env.js';
import { ComfyClient, type ComfyOutputRef } from '../lib/comfy.js';
import { buildKey, type StorageDriver } from './driver.js';
import { extensionFor, makeThumbnail, readImageInfo } from './images.js';
import { storage } from './index.js';

/**
 * The database calls this module makes, as an interface, so the unit tests can
 * exercise the idempotency logic without a live Postgres. Production passes the
 * real helpers from db.ts.
 */
export interface AssetDb {
  query: typeof defaultQuery;
  queryOne: typeof defaultQueryOne;
}

const realDb: AssetDb = { query: defaultQuery, queryOne: defaultQueryOne };

export interface AssetRow {
  id: string;
  job_id: string | null;
  user_id: string;
  kind: 'image' | 'video';
  storage_key: string;
  thumb_key: string | null;
  width: number;
  height: number;
  duration: number | null;
  size_bytes: string | number | null;
  starred: boolean;
  created_at: string | Date;
}

/** Public URLs are always our own route — object storage is never exposed. */
export function assetUrls(id: string): { url: string; thumbUrl: string } {
  return { url: `/api/assets/${id}`, thumbUrl: `/api/assets/${id}/thumb` };
}

export function rowToAsset(row: AssetRow): Asset {
  const { url, thumbUrl } = assetUrls(row.id);
  return {
    id: row.id,
    // The shared Asset type treats jobId as required; every asset this module
    // creates has one, and a job deleted later nulls the column via ON DELETE.
    jobId: row.job_id ?? '',
    kind: row.kind,
    url,
    // Fall back to the full image when thumbnailing failed, so the grid still
    // renders something rather than a broken tile.
    thumbUrl: row.thumb_key ? thumbUrl : url,
    width: row.width,
    height: row.height,
    duration: row.duration,
    starred: row.starred,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

const SELECT_COLUMNS = `id, job_id, user_id, kind, storage_key, thumb_key,
                        width, height, duration, size_bytes, starred, created_at`;

export interface PersistOptions {
  userId: string;
  jobId: string;
  /** The ComfyUI output record this came from — the idempotency key. */
  source: ComfyOutputRef;
  bytes: Buffer;
  kind?: 'image' | 'video';
  /** Seconds; video only. */
  duration?: number | null;
  driver?: StorageDriver;
  db?: AssetDb;
}

/**
 * Persist one output. Calling this twice for the same (jobId, source.filename)
 * returns the first asset and creates neither a second row nor orphaned objects.
 */
export async function persistOutput(opts: PersistOptions): Promise<Asset> {
  const db = opts.db ?? realDb;
  const driver = opts.driver ?? storage();

  // Cheap path first: a reconciliation pass over a job that already completed
  // normally hits this and never touches storage or sharp at all.
  const existing = await findExisting(db, opts.jobId, opts.source.filename);
  if (existing) return rowToAsset(existing);

  const info = await readImageInfo(opts.bytes);
  const extension = extensionFor(opts.source.filename, info.format);
  const storageKey = buildKey({ userId: opts.userId, extension });
  const mimeType = mimeForFormat(info.format, extension);

  await driver.put(storageKey, opts.bytes, mimeType);

  // A failed thumbnail must not lose the generation: record the asset without
  // one and let the UI fall back to the full image.
  let thumbKey: string | null = null;
  try {
    const thumb = await makeThumbnail(opts.bytes, env.storage.thumbMaxPx);
    thumbKey = buildKey({ userId: opts.userId, extension: thumb.extension, variant: 'thumb' });
    await driver.put(thumbKey, thumb.bytes, thumb.contentType);
  } catch {
    thumbKey = null;
  }

  const inserted = await db.queryOne<AssetRow>(
    `INSERT INTO assets
       (job_id, user_id, kind, storage_key, thumb_key, width, height,
        duration, size_bytes, source_filename, source_type, mime_type)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     ON CONFLICT (job_id, source_filename) WHERE job_id IS NOT NULL AND source_filename IS NOT NULL
       DO NOTHING
     RETURNING ${SELECT_COLUMNS}`,
    [
      opts.jobId,
      opts.userId,
      opts.kind ?? 'image',
      storageKey,
      thumbKey,
      info.width,
      info.height,
      opts.duration ?? null,
      opts.bytes.byteLength,
      opts.source.filename,
      opts.source.type ?? 'output',
      mimeType,
    ],
  );

  if (inserted) return rowToAsset(inserted);

  // Lost a race with a concurrent persist of the same output (two workers, or a
  // reconciliation overlapping the live completion). The winner's row is the
  // truth, so drop the objects this call just wrote rather than leaving them
  // unreferenced on disk forever.
  await driver.delete(storageKey).catch(() => {});
  if (thumbKey) await driver.delete(thumbKey).catch(() => {});

  const winner = await findExisting(db, opts.jobId, opts.source.filename);
  if (!winner) {
    throw new Error(
      `assets INSERT for ${opts.source.filename} conflicted but no existing row was found.`,
    );
  }
  return rowToAsset(winner);
}

async function findExisting(
  db: AssetDb,
  jobId: string,
  filename: string,
): Promise<AssetRow | null> {
  return db.queryOne<AssetRow>(
    `SELECT ${SELECT_COLUMNS}
       FROM assets
      WHERE job_id = $1 AND source_filename = $2 AND deleted_at IS NULL`,
    [jobId, filename],
  );
}

function mimeForFormat(format: string, extension: string): string {
  if (format === 'jpeg' || extension === 'jpg' || extension === 'jpeg') return 'image/jpeg';
  if (format && format !== 'unknown') return `image/${format}`;
  return `image/${extension}`;
}

/**
 * The whole path for one finished output: download from the backend, then
 * persist. Kept here so the orchestrator only ever needs the job's owner, its
 * backend URL, and the history entry's output record.
 */
export async function fetchAndPersist(opts: {
  userId: string;
  jobId: string;
  backendUrl: string;
  source: ComfyOutputRef;
  kind?: 'image' | 'video';
  driver?: StorageDriver;
  db?: AssetDb;
}): Promise<Asset> {
  const db = opts.db ?? realDb;

  // Skip the download entirely if this output is already recorded — after a
  // restart most of what /history reports has already been persisted.
  const existing = await findExisting(db, opts.jobId, opts.source.filename);
  if (existing) return rowToAsset(existing);

  const client = new ComfyClient(opts.backendUrl);
  const { bytes } = await client.viewImage(opts.source, env.storage.fetchTimeoutMs);

  return persistOutput({
    userId: opts.userId,
    jobId: opts.jobId,
    source: opts.source,
    bytes,
    kind: opts.kind,
    driver: opts.driver,
    db,
  });
}
