/**
 * Every database statement the library API makes.
 *
 * Two rules run through all of it:
 *
 *  1. Ownership lives in the WHERE clause, never in the handler. Each statement
 *     is scoped by `user_id`, so another user's asset is indistinguishable from
 *     one that does not exist — the same rule storage/access.ts applies to the
 *     bytes, applied here to the metadata.
 *  2. `deleted_at IS NULL` is part of that scope. A soft-deleted asset has to
 *     vanish from the grid, from every collection, and from the single-asset
 *     read; the only way to be sure of that is for no statement here to be
 *     able to see one.
 *
 * The db handle is an interface rather than an import so the unit tests can
 * exercise this without a live Postgres, exactly as storage/persist.ts does.
 */

import type { Asset, Job, JobKind, JobProgress, JobStatus, GenerationParams } from '@comfy/shared';
import { query as defaultQuery, queryOne as defaultQueryOne } from '../db.js';
import { rowToAsset, type AssetRow } from '../storage/persist.js';
import { encodeCursor, type Cursor } from './cursor.js';

export interface LibraryDb {
  query: typeof defaultQuery;
  queryOne: typeof defaultQueryOne;
}

export const realDb: LibraryDb = { query: defaultQuery, queryOne: defaultQueryOne };

/** The columns `rowToAsset` needs, aliased off the assets table. */
const ASSET_COLUMNS = `a.id, a.job_id, a.user_id, a.kind, a.storage_key, a.thumb_key,
                       a.width, a.height, a.duration, a.size_bytes, a.starred, a.created_at`;

/**
 * What the grid shows on a tile beyond the image itself.
 *
 * Denormalised into the list query rather than left to the client, because the
 * alternative is a detail fetch per tile: a hundred-tile scroll would issue a
 * hundred requests to render captions. The joins are left, not inner — an asset
 * whose job row was deleted still belongs in your library.
 */
const TILE_COLUMNS = `j.params->>'prompt' AS prompt,
                      m.display_name AS model_name,
                      COALESCE(
                        (SELECT array_agg(ca2.collection_id)
                           FROM collection_assets ca2 WHERE ca2.asset_id = a.id),
                        '{}'
                      ) AS collection_ids`;

const TILE_JOINS = `LEFT JOIN jobs j ON j.id = a.job_id AND j.user_id = a.user_id
                    LEFT JOIN models m ON m.id = (j.params->>'modelId')::uuid`;

/** The extra tile fields, as they come back from Postgres. */
export interface TileRow extends AssetRow {
  prompt: string | null;
  model_name: string | null;
  collection_ids: string[] | null;
}

export interface LibraryAsset extends ReturnType<typeof rowToAsset> {
  prompt: string | null;
  modelName: string | null;
  collectionIds: string[];
}

export function toLibraryAsset(row: TileRow): LibraryAsset {
  return {
    ...rowToAsset(row),
    prompt: row.prompt,
    modelName: row.model_name,
    collectionIds: row.collection_ids ?? [],
  };
}

// ---------------------------------------------------------------- listing

export interface ListAssetsFilter {
  userId: string;
  /** Already clamped by the route. */
  limit: number;
  cursor: Cursor | null;
  kind?: 'image' | 'video';
  starred?: boolean;
  collectionId?: string;
  /** Free text, matched against the originating job's prompt. */
  q?: string;
}

export interface AssetPage {
  assets: LibraryAsset[];
  nextCursor: string | null;
}

export async function listAssets(db: LibraryDb, filter: ListAssetsFilter): Promise<AssetPage> {
  const params: unknown[] = [filter.userId];
  const where: string[] = ['a.user_id = $1', 'a.deleted_at IS NULL'];
  const joins: string[] = [];

  if (filter.collectionId) {
    // The collection is joined *and* re-scoped to the same owner, so asking for
    // someone else's collection id returns an empty page rather than their
    // assets or a distinguishable error.
    params.push(filter.collectionId);
    joins.push(`JOIN collection_assets ca ON ca.asset_id = a.id
                JOIN collections col ON col.id = ca.collection_id
                     AND col.id = $${params.length} AND col.user_id = $1`);
  }

  if (filter.q) {
    // Honest about what this is: a substring match over the prompt text of the
    // job that produced the asset. Not search — no stemming, no ranking, no
    // index. At a few thousand images per user that is genuinely fine, and it
    // is better to say so here than to dress a LIKE up as something it isn't.
    // No join needed: the tile columns already LEFT JOIN jobs as `j`. An asset
    // whose job row is gone has a NULL prompt, and NULL ILIKE anything is not
    // true, so those drop out of a search exactly as an inner join would have
    // made them — without a second alias for the same table.
    params.push(`%${escapeLike(filter.q)}%`);
    where.push(`j.params->>'prompt' ILIKE $${params.length}`);
  }

  if (filter.kind) {
    params.push(filter.kind);
    where.push(`a.kind = $${params.length}`);
  }

  if (filter.starred !== undefined) {
    params.push(filter.starred);
    where.push(`a.starred = $${params.length}`);
  }

  if (filter.cursor) {
    // Row-value comparison, which is the whole point of the composite key: it
    // is one strict "older than this row" test rather than the error-prone
    // (created_at < t OR (created_at = t AND id < i)) it expands to.
    params.push(filter.cursor.createdAt, filter.cursor.id);
    where.push(
      `(a.created_at, a.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`,
    );
  }

  // One extra row is the "is there more" probe: cheaper and more honest than a
  // COUNT, which would be stale by the time the client used it.
  params.push(filter.limit + 1);

  const rows = await db.query<TileRow>(
    `-- library:list-assets
     SELECT ${ASSET_COLUMNS}, ${TILE_COLUMNS}
       FROM assets a
       ${TILE_JOINS}
       ${joins.join('\n       ')}
      WHERE ${where.join(' AND ')}
      ORDER BY a.created_at DESC, a.id DESC
      LIMIT $${params.length}`,
    params,
  );

  const page = rows.slice(0, filter.limit);
  const last = page[page.length - 1];
  const nextCursor =
    rows.length > filter.limit && last
      ? encodeCursor({ createdAt: new Date(last.created_at).toISOString(), id: last.id })
      : null;

  return { assets: page.map(toLibraryAsset), nextCursor };
}

/** `%` and `_` in a user's search box mean those characters, not wildcards. */
function escapeLike(input: string): string {
  return input.replace(/[\\%_]/g, (c) => `\\${c}`);
}

// ---------------------------------------------------------------- one asset

export async function getAsset(
  db: LibraryDb,
  assetId: string,
  userId: string,
): Promise<Asset | null> {
  const row = await db.queryOne<AssetRow>(
    `-- library:get-asset
     SELECT ${ASSET_COLUMNS}
       FROM assets a
      WHERE a.id = $1 AND a.user_id = $2 AND a.deleted_at IS NULL`,
    [assetId, userId],
  );
  return row ? rowToAsset(row) : null;
}

export interface JobRow {
  id: string;
  user_id: string;
  kind: JobKind;
  status: JobStatus;
  params: GenerationParams;
  backend_id: string | null;
  progress: Partial<JobProgress> | null;
  error: string | null;
  created_at: string | Date;
  started_at: string | Date | null;
  finished_at: string | Date | null;
}

const EMPTY_PROGRESS: JobProgress = {
  step: null,
  totalSteps: null,
  frame: null,
  totalFrames: null,
  fraction: 0,
  etaSeconds: null,
  previewUrl: null,
};

export function rowToJob(row: JobRow, assets: Asset[]): Job {
  return {
    id: row.id,
    userId: row.user_id,
    kind: row.kind,
    status: row.status,
    // Queue position is a live property of the orchestrator's queue, not of a
    // finished job read out of the library. Null rather than a stale number.
    queuePosition: null,
    params: row.params,
    backendId: row.backend_id,
    progress: { ...EMPTY_PROGRESS, ...(row.progress ?? {}) },
    error: row.error,
    createdAt: new Date(row.created_at).toISOString(),
    startedAt: row.started_at ? new Date(row.started_at).toISOString() : null,
    finishedAt: row.finished_at ? new Date(row.finished_at).toISOString() : null,
    assets,
  };
}

/**
 * The job that produced an asset, for the detail drawer — prompt, seed, model
 * and sampler all live in `jobs.params`, which is the stored GenerationParams.
 *
 * `assets.job_id` is ON DELETE SET NULL, so an asset can outlive its job. That
 * is a drawer with no metadata, not an error: callers get null and show the
 * image without the record.
 */
export async function getJobForAsset(
  db: LibraryDb,
  jobId: string | null,
  userId: string,
): Promise<Job | null> {
  if (!jobId) return null;

  const row = await db.queryOne<JobRow>(
    `-- library:get-job
     SELECT id, user_id, kind, status, params, backend_id, progress, error,
            created_at, started_at, finished_at
       FROM jobs
      WHERE id = $1 AND user_id = $2`,
    [jobId, userId],
  );
  if (!row) return null;

  // The job's other outputs, so the drawer can offer the rest of the batch.
  const siblings = await db.query<AssetRow>(
    `-- library:job-assets
     SELECT ${ASSET_COLUMNS}
       FROM assets a
      WHERE a.job_id = $1 AND a.user_id = $2 AND a.deleted_at IS NULL
      ORDER BY a.created_at ASC, a.id ASC`,
    [jobId, userId],
  );

  return rowToJob(row, siblings.map(rowToAsset));
}

/** The raw job_id, needed to look the job up after fetching the asset. */
export async function getAssetJobId(
  db: LibraryDb,
  assetId: string,
  userId: string,
): Promise<{ found: boolean; jobId: string | null }> {
  const row = await db.queryOne<{ job_id: string | null }>(
    `-- library:get-asset-job-id
     SELECT a.job_id
       FROM assets a
      WHERE a.id = $1 AND a.user_id = $2 AND a.deleted_at IS NULL`,
    [assetId, userId],
  );
  return row ? { found: true, jobId: row.job_id } : { found: false, jobId: null };
}

// ---------------------------------------------------------------- mutations

export async function setStarred(
  db: LibraryDb,
  assetId: string,
  userId: string,
  starred: boolean,
): Promise<Asset | null> {
  const row = await db.queryOne<AssetRow>(
    `-- library:set-starred
     UPDATE assets a
        SET starred = $3
      WHERE a.id = $1 AND a.user_id = $2 AND a.deleted_at IS NULL
      RETURNING ${ASSET_COLUMNS}`,
    [assetId, userId, starred],
  );
  return row ? rowToAsset(row) : null;
}

/**
 * Soft delete. The stored objects stay where they are: a later reaper can
 * remove them once nothing references them, and until then an undo costs a
 * single UPDATE. Deleting the bytes here would make "undo" a lie.
 *
 * Re-deleting an already-deleted asset returns false — the row is invisible to
 * this statement, as it is to every other one in this file.
 */
export async function softDeleteAsset(
  db: LibraryDb,
  assetId: string,
  userId: string,
): Promise<boolean> {
  const row = await db.queryOne<{ id: string }>(
    `-- library:soft-delete-asset
     UPDATE assets a
        SET deleted_at = now()
      WHERE a.id = $1 AND a.user_id = $2 AND a.deleted_at IS NULL
      RETURNING a.id`,
    [assetId, userId],
  );
  return row !== null;
}

/**
 * Undo a soft delete.
 *
 * The bytes were never removed — `softDeleteAsset` only stamps `deleted_at` —
 * so this is genuinely a restore rather than a re-upload, which is what makes
 * an undo affordance honest. Scoped to rows that *are* deleted so that
 * restoring twice is a 404 rather than silently succeeding.
 */
export async function restoreAsset(
  db: LibraryDb,
  assetId: string,
  userId: string,
): Promise<LibraryAsset | null> {
  const row = await db.queryOne<TileRow>(
    `-- library:restore-asset
     WITH restored AS (
       UPDATE assets a
          SET deleted_at = NULL
        WHERE a.id = $1 AND a.user_id = $2 AND a.deleted_at IS NOT NULL
        RETURNING a.*
     )
     SELECT ${ASSET_COLUMNS}, ${TILE_COLUMNS}
       FROM restored a
       ${TILE_JOINS}`,
    [assetId, userId],
  );
  return row ? toLibraryAsset(row) : null;
}

// ---------------------------------------------------------------- collections

export interface CollectionSummary {
  id: string;
  name: string;
  count: number;
}

interface CollectionRow {
  id: string;
  name: string;
  count: string | number;
}

/**
 * Collections with an accurate count. The join to `assets` is what makes it
 * accurate: counting `collection_assets` rows alone would keep counting an
 * asset the user deleted, since the membership row survives a soft delete.
 */
export async function listCollections(
  db: LibraryDb,
  userId: string,
): Promise<CollectionSummary[]> {
  const rows = await db.query<CollectionRow>(
    `-- library:list-collections
     SELECT c.id, c.name, COUNT(a.id) AS count
       FROM collections c
       LEFT JOIN collection_assets ca ON ca.collection_id = c.id
       LEFT JOIN assets a ON a.id = ca.asset_id AND a.deleted_at IS NULL
      WHERE c.user_id = $1
      GROUP BY c.id, c.name, c.created_at
      ORDER BY c.created_at DESC`,
    [userId],
  );
  return rows.map((r) => ({ id: r.id, name: r.name, count: Number(r.count) }));
}

export async function createCollection(
  db: LibraryDb,
  userId: string,
  name: string,
): Promise<CollectionSummary> {
  const row = await db.queryOne<{ id: string; name: string }>(
    `-- library:create-collection
     INSERT INTO collections (user_id, name) VALUES ($1, $2)
     RETURNING id, name`,
    [userId, name],
  );
  if (!row) throw new Error('collections INSERT returned no row');
  return { id: row.id, name: row.name, count: 0 };
}

export async function deleteCollection(
  db: LibraryDb,
  collectionId: string,
  userId: string,
): Promise<boolean> {
  // Membership rows go with it via ON DELETE CASCADE; the assets themselves are
  // untouched — a collection is a view of the library, not a container for it.
  const row = await db.queryOne<{ id: string }>(
    `-- library:delete-collection
     DELETE FROM collections WHERE id = $1 AND user_id = $2 RETURNING id`,
    [collectionId, userId],
  );
  return row !== null;
}

/**
 * Add an asset to a collection.
 *
 * One statement decides both halves of the ownership question: the SELECT only
 * produces a row when the caller owns the collection *and* owns a live asset
 * with that id. A collection you do not own and an asset you do not own both
 * come back as "nothing inserted", which the route reports as 404 — never 403,
 * which would confirm the id exists.
 *
 * ON CONFLICT DO UPDATE rather than DO NOTHING so that re-adding something
 * already in the collection still RETURNS a row: with DO NOTHING an idempotent
 * repeat would be indistinguishable from a failed ownership check.
 */
export async function addAssetToCollection(
  db: LibraryDb,
  collectionId: string,
  assetId: string,
  userId: string,
): Promise<boolean> {
  const row = await db.queryOne<{ asset_id: string }>(
    `-- library:add-to-collection
     INSERT INTO collection_assets (collection_id, asset_id)
     SELECT c.id, a.id
       FROM collections c
       JOIN assets a ON a.user_id = c.user_id AND a.deleted_at IS NULL
      WHERE c.id = $1 AND a.id = $2 AND c.user_id = $3
     ON CONFLICT (collection_id, asset_id)
       DO UPDATE SET added_at = collection_assets.added_at
     RETURNING asset_id`,
    [collectionId, assetId, userId],
  );
  return row !== null;
}

export async function removeAssetFromCollection(
  db: LibraryDb,
  collectionId: string,
  assetId: string,
  userId: string,
): Promise<boolean> {
  const row = await db.queryOne<{ asset_id: string }>(
    `-- library:remove-from-collection
     DELETE FROM collection_assets ca
      USING collections c
      WHERE ca.collection_id = c.id
        AND c.id = $1 AND ca.asset_id = $2 AND c.user_id = $3
     RETURNING ca.asset_id`,
    [collectionId, assetId, userId],
  );
  return row !== null;
}
