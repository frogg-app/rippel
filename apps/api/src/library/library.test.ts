/**
 * Unit tests for the library metadata API.
 *
 * Like storage.test.ts, these run against an in-memory stand-in for Postgres —
 * no live database. The stand-in is not a stub that returns canned rows: it
 * reads the SQL this module actually produces (the placeholder indexes, the
 * row-value cursor comparison, the joins) and evaluates it over arrays. That
 * keeps the paging tests meaningful, because a query that wired `$4` to the
 * wrong value fails here for the same reason it would fail against Postgres.
 *
 * It also refuses any statement that does not mention `user_id`, which is the
 * one rule that must hold for every query in queries.ts.
 */

import { describe, expect, it } from 'vitest';

import { decodeCursor, encodeCursor } from './cursor.js';
import {
  addAssetToCollection,
  createCollection,
  deleteCollection,
  getAsset,
  getAssetJobId,
  getJobForAsset,
  listAssets,
  listCollections,
  removeAssetFromCollection,
  setStarred,
  softDeleteAsset,
  type LibraryDb,
} from './queries.js';

const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';
const JOB = '33333333-3333-4333-8333-333333333333';
const COLLECTION = '44444444-4444-4444-8444-444444444444';
const BOB_COLLECTION = '55555555-5555-4555-8555-555555555555';

function assetId(n: number): string {
  return `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

// ---------------------------------------------------------------- fake pg

interface FakeAsset {
  id: string;
  job_id: string | null;
  user_id: string;
  kind: 'image' | 'video';
  storage_key: string;
  thumb_key: string | null;
  width: number;
  height: number;
  duration: number | null;
  size_bytes: number | null;
  starred: boolean;
  deleted_at: Date | null;
  created_at: string;
}

interface FakeJob {
  id: string;
  user_id: string;
  kind: string;
  status: string;
  params: Record<string, unknown>;
  backend_id: string | null;
  progress: Record<string, unknown> | null;
  error: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

interface FakeCollection {
  id: string;
  user_id: string;
  name: string;
  created_at: string;
}

interface World {
  assets: FakeAsset[];
  jobs: FakeJob[];
  collections: FakeCollection[];
  members: { collection_id: string; asset_id: string }[];
  db: LibraryDb;
}

function makeAsset(overrides: Partial<FakeAsset> & { id: string }): FakeAsset {
  return {
    job_id: JOB,
    user_id: ALICE,
    kind: 'image',
    storage_key: `u/${overrides.user_id ?? ALICE}/2026/09/${'a'.repeat(32)}.png`,
    thumb_key: `u/${overrides.user_id ?? ALICE}/2026/09/${'b'.repeat(32)}_thumb.webp`,
    width: 1024,
    height: 1024,
    duration: null,
    size_bytes: 1234,
    starred: false,
    deleted_at: null,
    created_at: '2026-09-01T00:00:00.000Z',
    ...overrides,
  };
}

/** ORDER BY created_at DESC, id DESC — the total order the cursor relies on. */
function newestFirst(a: FakeAsset, b: FakeAsset): number {
  const byTime = Date.parse(b.created_at) - Date.parse(a.created_at);
  return byTime !== 0 ? byTime : b.id.localeCompare(a.id);
}

/** `(created_at, id) < (t, i)`, as Postgres evaluates a row-value comparison. */
function olderThan(row: FakeAsset, t: string, i: string): boolean {
  const rowTime = Date.parse(row.created_at);
  const cursorTime = Date.parse(t);
  if (rowTime !== cursorTime) return rowTime < cursorTime;
  return row.id < i;
}

function placeholder(sql: string, pattern: RegExp, params: unknown[]): unknown {
  const match = sql.match(pattern);
  return match ? params[Number(match[1]) - 1] : undefined;
}

function ilike(haystack: string, pattern: string): boolean {
  // The pattern is always %escaped-needle%, so undo the LIKE escaping and do a
  // case-insensitive substring test.
  const needle = pattern.slice(1, -1).replace(/\\(.)/g, '$1');
  return haystack.toLowerCase().includes(needle.toLowerCase());
}

function world(seed: Partial<Omit<World, 'db'>> = {}): World {
  const w: World = {
    assets: seed.assets ?? [],
    jobs: seed.jobs ?? [],
    collections: seed.collections ?? [],
    members: seed.members ?? [],
    db: null as unknown as LibraryDb,
  };

  const run = (sql: string, params: unknown[] = []): Record<string, unknown>[] => {
    // The rule that has to hold for every statement in queries.ts.
    if (!sql.includes('user_id')) {
      throw new Error(`statement is not scoped by user_id: ${sql}`);
    }
    const tag = sql.match(/-- library:([a-z-]+)/)?.[1];

    switch (tag) {
      case 'list-assets': {
        const userId = params[0];
        const limit = Number(params[params.length - 1]);

        const collectionId = placeholder(sql, /col\.id = \$(\d+)/, params) as string | undefined;
        const prompt = placeholder(sql, /prompt' ILIKE \$(\d+)/, params) as string | undefined;
        const kind = placeholder(sql, /a\.kind = \$(\d+)/, params) as string | undefined;
        const starred = placeholder(sql, /a\.starred = \$(\d+)/, params) as boolean | undefined;
        const cursorMatch = sql.match(
          /\(a\.created_at, a\.id\) < \(\$(\d+)::timestamptz, \$(\d+)::uuid\)/,
        );

        let rows = w.assets.filter((a) => a.user_id === userId && a.deleted_at === null);

        if (collectionId !== undefined) {
          const owned = w.collections.some((c) => c.id === collectionId && c.user_id === userId);
          rows = owned
            ? rows.filter((a) =>
                w.members.some((m) => m.collection_id === collectionId && m.asset_id === a.id),
              )
            : [];
        }
        if (prompt !== undefined) {
          rows = rows.filter((a) => {
            const job = w.jobs.find((j) => j.id === a.job_id && j.user_id === userId);
            return job ? ilike(String(job.params.prompt ?? ''), prompt) : false;
          });
        }
        if (kind !== undefined) rows = rows.filter((a) => a.kind === kind);
        if (starred !== undefined) rows = rows.filter((a) => a.starred === starred);
        if (cursorMatch) {
          const t = params[Number(cursorMatch[1]) - 1] as string;
          const i = params[Number(cursorMatch[2]) - 1] as string;
          rows = rows.filter((a) => olderThan(a, t, i));
        }

        return rows.sort(newestFirst).slice(0, limit) as unknown as Record<string, unknown>[];
      }

      case 'get-asset':
      case 'get-asset-job-id': {
        const [id, userId] = params as [string, string];
        const hit = w.assets.find(
          (a) => a.id === id && a.user_id === userId && a.deleted_at === null,
        );
        return hit ? [hit as unknown as Record<string, unknown>] : [];
      }

      case 'get-job': {
        const [id, userId] = params as [string, string];
        const hit = w.jobs.find((j) => j.id === id && j.user_id === userId);
        return hit ? [hit as unknown as Record<string, unknown>] : [];
      }

      case 'job-assets': {
        const [jobId, userId] = params as [string, string];
        return w.assets
          .filter((a) => a.job_id === jobId && a.user_id === userId && a.deleted_at === null)
          .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at)) as unknown as Record<
          string,
          unknown
        >[];
      }

      case 'set-starred': {
        const [id, userId, starred] = params as [string, string, boolean];
        const hit = w.assets.find(
          (a) => a.id === id && a.user_id === userId && a.deleted_at === null,
        );
        if (!hit) return [];
        hit.starred = starred;
        return [hit as unknown as Record<string, unknown>];
      }

      case 'soft-delete-asset': {
        const [id, userId] = params as [string, string];
        const hit = w.assets.find(
          (a) => a.id === id && a.user_id === userId && a.deleted_at === null,
        );
        if (!hit) return [];
        hit.deleted_at = new Date();
        return [{ id: hit.id }];
      }

      case 'list-collections': {
        const [userId] = params as [string];
        return w.collections
          .filter((c) => c.user_id === userId)
          .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
          .map((c) => ({
            id: c.id,
            name: c.name,
            created_at: c.created_at,
            // COUNT(a.id) over the join to live assets, not to membership rows.
            count: String(
              w.members.filter(
                (m) =>
                  m.collection_id === c.id &&
                  w.assets.some((a) => a.id === m.asset_id && a.deleted_at === null),
              ).length,
            ),
          }));
      }

      case 'create-collection': {
        const [userId, name] = params as [string, string];
        const row: FakeCollection = {
          id: `col-${w.collections.length + 1}`,
          user_id: userId,
          name,
          created_at: new Date().toISOString(),
        };
        w.collections.push(row);
        // Mirror the real RETURNING clause, created_at included — the caller
        // turns it into an ISO string and a missing column is an invalid date.
        return [{ id: row.id, name: row.name, created_at: row.created_at }];
      }

      case 'delete-collection': {
        const [id, userId] = params as [string, string];
        const index = w.collections.findIndex((c) => c.id === id && c.user_id === userId);
        if (index < 0) return [];
        w.collections.splice(index, 1);
        w.members = w.members.filter((m) => m.collection_id !== id); // ON DELETE CASCADE
        return [{ id }];
      }

      case 'add-to-collection': {
        const [collectionId, id, userId] = params as [string, string, string];
        const collection = w.collections.find(
          (c) => c.id === collectionId && c.user_id === userId,
        );
        const asset = w.assets.find(
          (a) => a.id === id && a.user_id === userId && a.deleted_at === null,
        );
        if (!collection || !asset) return [];
        if (!w.members.some((m) => m.collection_id === collectionId && m.asset_id === id)) {
          w.members.push({ collection_id: collectionId, asset_id: id });
        }
        return [{ asset_id: id }];
      }

      case 'remove-from-collection': {
        const [collectionId, id, userId] = params as [string, string, string];
        const owned = w.collections.some((c) => c.id === collectionId && c.user_id === userId);
        const index = w.members.findIndex(
          (m) => m.collection_id === collectionId && m.asset_id === id,
        );
        if (!owned || index < 0) return [];
        w.members.splice(index, 1);
        return [{ asset_id: id }];
      }

      default:
        throw new Error(`unexpected SQL in test: ${sql}`);
    }
  };

  w.db = {
    query: (async (sql: string, params?: unknown[]) => run(sql, params)) as LibraryDb['query'],
    queryOne: (async (sql: string, params?: unknown[]) =>
      run(sql, params)[0] ?? null) as LibraryDb['queryOne'],
  };
  return w;
}

// ---------------------------------------------------------------- cursors

describe('cursors', () => {
  it('round-trips and stays opaque', () => {
    const cursor = { createdAt: '2026-09-01T10:00:00.000Z', id: assetId(7) };
    const encoded = encodeCursor(cursor);
    expect(encoded).not.toContain(cursor.id);
    expect(decodeCursor(encoded)).toEqual(cursor);
  });

  it('rejects anything it did not produce', () => {
    for (const bad of ['', 'nonsense', encodeCursor({ createdAt: 'not-a-date', id: assetId(1) })]) {
      expect(decodeCursor(bad)).toBeNull();
    }
    // A well-formed timestamp with a non-uuid id is still not ours.
    expect(
      decodeCursor(Buffer.from('2026-09-01T00:00:00Z|../etc', 'utf8').toString('base64url')),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------- ownership

describe('ownership', () => {
  const mine = makeAsset({ id: assetId(1) });
  const theirs = makeAsset({ id: assetId(2), user_id: BOB });
  const deleted = makeAsset({ id: assetId(3), deleted_at: new Date() });

  it('lets the owner read their own asset, with URLs the client can render', async () => {
    const w = world({ assets: [mine, theirs, deleted] });
    const asset = await getAsset(w.db, mine.id, ALICE);
    expect(asset).toMatchObject({
      id: mine.id,
      url: `/api/assets/${mine.id}`,
      thumbUrl: `/api/assets/${mine.id}/thumb`,
    });
  });

  it("reports another user's asset exactly as it reports a missing one", async () => {
    const w = world({ assets: [mine, theirs, deleted] });
    expect(await getAsset(w.db, theirs.id, ALICE)).toBeNull();
    expect(await getAsset(w.db, assetId(99), ALICE)).toBeNull();
  });

  it('hides a soft-deleted asset from its own owner', async () => {
    const w = world({ assets: [mine, theirs, deleted] });
    expect(await getAsset(w.db, deleted.id, ALICE)).toBeNull();
    expect(await setStarred(w.db, deleted.id, ALICE, true)).toBeNull();
    expect(await softDeleteAsset(w.db, deleted.id, ALICE)).toBe(false);
  });

  it('lists only live assets belonging to the caller', async () => {
    const w = world({ assets: [mine, theirs, deleted] });
    const page = await listAssets(w.db, { userId: ALICE, limit: 50, cursor: null });
    expect(page.assets.map((a) => a.id)).toEqual([mine.id]);
    expect(page.nextCursor).toBeNull();
  });

  it('drops an asset out of every list the moment it is deleted', async () => {
    const w = world({
      assets: [makeAsset({ id: assetId(1) })],
      collections: [{ id: COLLECTION, user_id: ALICE, name: 'Keepers', created_at: '2026-09-01T00:00:00Z' }],
      members: [{ collection_id: COLLECTION, asset_id: assetId(1) }],
    });

    expect(await softDeleteAsset(w.db, assetId(1), ALICE)).toBe(true);

    expect((await listAssets(w.db, { userId: ALICE, limit: 50, cursor: null })).assets).toEqual([]);
    expect(
      (await listAssets(w.db, { userId: ALICE, limit: 50, cursor: null, collectionId: COLLECTION }))
        .assets,
    ).toEqual([]);
    expect(await getAsset(w.db, assetId(1), ALICE)).toBeNull();
    // The bytes are still there: the reaper's job, not ours.
    expect(w.assets[0]!.storage_key).toBeTruthy();
  });

  it('refuses to run a statement that is not scoped by user_id', async () => {
    const w = world();
    await expect(w.db.query('SELECT 1 FROM assets')).rejects.toThrow(/user_id/);
  });
});

// ---------------------------------------------------------------- paging

describe('cursor paging', () => {
  /** Ten assets, one minute apart, newest last in this array. */
  function tenAssets(): FakeAsset[] {
    return Array.from({ length: 10 }, (_, i) =>
      makeAsset({
        id: assetId(i + 1),
        created_at: new Date(Date.UTC(2026, 8, 1, 12, i)).toISOString(),
      }),
    );
  }

  it('walks the whole table exactly once, newest first', async () => {
    const w = world({ assets: tenAssets() });
    const seen: string[] = [];
    let cursor: string | null = null;

    do {
      const page: Awaited<ReturnType<typeof listAssets>> = await listAssets(w.db, {
        userId: ALICE,
        limit: 3,
        cursor: cursor ? decodeCursor(cursor) : null,
      });
      seen.push(...page.assets.map((a) => a.id));
      cursor = page.nextCursor;
    } while (cursor);

    expect(seen).toHaveLength(10);
    expect(new Set(seen).size).toBe(10);
    expect(seen[0]).toBe(assetId(10));
    expect(seen.at(-1)).toBe(assetId(1));
  });

  it('does not repeat a row when new ones arrive at the top mid-scroll', async () => {
    const w = world({ assets: tenAssets() });

    const first = await listAssets(w.db, { userId: ALICE, limit: 3, cursor: null });
    expect(first.assets.map((a) => a.id)).toEqual([assetId(10), assetId(9), assetId(8)]);

    // A batch finishes while the user is reading: four rows land above the
    // cursor. With OFFSET 3 the next page would re-serve rows 10, 9 and 8.
    for (let i = 0; i < 4; i++) {
      w.assets.push(
        makeAsset({
          id: assetId(20 + i),
          created_at: new Date(Date.UTC(2026, 8, 1, 13, i)).toISOString(),
        }),
      );
    }

    const second = await listAssets(w.db, {
      userId: ALICE,
      limit: 3,
      cursor: decodeCursor(first.nextCursor!),
    });
    expect(second.assets.map((a) => a.id)).toEqual([assetId(7), assetId(6), assetId(5)]);
    for (const id of first.assets.map((a) => a.id)) {
      expect(second.assets.map((a) => a.id)).not.toContain(id);
    }
  });

  it('breaks ties by id when a batch shares a timestamp', async () => {
    // Four outputs of one job, inserted together, same created_at.
    const sameInstant = '2026-09-02T09:00:00.000Z';
    const w = world({
      assets: [1, 2, 3, 4].map((n) => makeAsset({ id: assetId(n), created_at: sameInstant })),
    });

    const first = await listAssets(w.db, { userId: ALICE, limit: 2, cursor: null });
    const second = await listAssets(w.db, {
      userId: ALICE,
      limit: 2,
      cursor: decodeCursor(first.nextCursor!),
    });

    expect(first.assets.map((a) => a.id)).toEqual([assetId(4), assetId(3)]);
    expect(second.assets.map((a) => a.id)).toEqual([assetId(2), assetId(1)]);
    expect(second.nextCursor).toBeNull();
  });

  it('reports no next cursor on an exactly-full final page', async () => {
    const w = world({ assets: tenAssets().slice(0, 3) });
    const page = await listAssets(w.db, { userId: ALICE, limit: 3, cursor: null });
    expect(page.assets).toHaveLength(3);
    expect(page.nextCursor).toBeNull();
  });
});

// ---------------------------------------------------------------- filters

describe('filters', () => {
  it('matches the prompt of the job that produced the asset', async () => {
    const w = world({
      assets: [
        makeAsset({ id: assetId(1), job_id: 'job-a' }),
        makeAsset({ id: assetId(2), job_id: 'job-b' }),
      ],
      jobs: [
        fakeJob('job-a', { prompt: 'a copper teapot on a windowsill' }),
        fakeJob('job-b', { prompt: 'a wolf in the snow' }),
      ],
    });

    const hits = await listAssets(w.db, { userId: ALICE, limit: 50, cursor: null, q: 'TEAPOT' });
    expect(hits.assets.map((a) => a.id)).toEqual([assetId(1)]);
    expect((await listAssets(w.db, { userId: ALICE, limit: 50, cursor: null, q: 'zebra' })).assets)
      .toEqual([]);
  });

  it('filters by kind and starred', async () => {
    const w = world({
      assets: [
        makeAsset({ id: assetId(1), kind: 'image', starred: true }),
        makeAsset({ id: assetId(2), kind: 'video' }),
      ],
    });
    expect(
      (await listAssets(w.db, { userId: ALICE, limit: 50, cursor: null, kind: 'video' })).assets
        .map((a) => a.id),
    ).toEqual([assetId(2)]);
    expect(
      (await listAssets(w.db, { userId: ALICE, limit: 50, cursor: null, starred: true })).assets
        .map((a) => a.id),
    ).toEqual([assetId(1)]);
  });

  it("returns nothing for another user's collection id", async () => {
    const w = world({
      assets: [makeAsset({ id: assetId(1), user_id: BOB })],
      collections: [
        { id: BOB_COLLECTION, user_id: BOB, name: 'Bob', created_at: '2026-09-01T00:00:00Z' },
      ],
      members: [{ collection_id: BOB_COLLECTION, asset_id: assetId(1) }],
    });
    const page = await listAssets(w.db, {
      userId: ALICE,
      limit: 50,
      cursor: null,
      collectionId: BOB_COLLECTION,
    });
    expect(page.assets).toEqual([]);
  });
});

// ---------------------------------------------------------------- job metadata

function fakeJob(id: string, params: Record<string, unknown>): FakeJob {
  return {
    id,
    user_id: ALICE,
    kind: 'txt2img',
    status: 'complete',
    params,
    backend_id: null,
    progress: { fraction: 1 },
    error: null,
    created_at: '2026-09-01T00:00:00.000Z',
    started_at: '2026-09-01T00:00:01.000Z',
    finished_at: '2026-09-01T00:00:09.000Z',
  };
}

describe('asset detail', () => {
  it('returns the job that produced it, with the stored generation params', async () => {
    const w = world({
      assets: [makeAsset({ id: assetId(1), job_id: JOB }), makeAsset({ id: assetId(2), job_id: JOB })],
      jobs: [fakeJob(JOB, { prompt: 'a copper teapot', advanced: { seed: 42 } })],
    });

    const { jobId } = await getAssetJobId(w.db, assetId(1), ALICE);
    const job = await getJobForAsset(w.db, jobId, ALICE);

    expect(job?.params).toMatchObject({ prompt: 'a copper teapot' });
    expect(job?.progress.fraction).toBe(1);
    // Queue position is a live queue property, never replayed from history.
    expect(job?.queuePosition).toBeNull();
    // The rest of the batch comes along for the drawer.
    expect(job?.assets.map((a) => a.id)).toEqual([assetId(1), assetId(2)]);
  });

  it('returns job: null when the job row is gone rather than failing', async () => {
    // assets.job_id is ON DELETE SET NULL, so this really happens.
    const w = world({ assets: [makeAsset({ id: assetId(1), job_id: null })] });
    const { found, jobId } = await getAssetJobId(w.db, assetId(1), ALICE);
    expect(found).toBe(true);
    expect(await getJobForAsset(w.db, jobId, ALICE)).toBeNull();

    // And a job row that survives but belongs to someone else is equally null.
    const other = world({
      assets: [makeAsset({ id: assetId(1), job_id: JOB })],
      jobs: [{ ...fakeJob(JOB, {}), user_id: BOB }],
    });
    expect(await getJobForAsset(other.db, JOB, ALICE)).toBeNull();
  });
});

// ---------------------------------------------------------------- collections

describe('collections', () => {
  function collectionWorld(): World {
    return world({
      assets: [
        makeAsset({ id: assetId(1) }),
        makeAsset({ id: assetId(2) }),
        makeAsset({ id: assetId(3), user_id: BOB }),
      ],
      collections: [
        { id: COLLECTION, user_id: ALICE, name: 'Keepers', created_at: '2026-09-01T00:00:00Z' },
        { id: BOB_COLLECTION, user_id: BOB, name: 'Bob', created_at: '2026-09-01T00:00:00Z' },
      ],
    });
  }

  it('counts only the live assets actually in the collection', async () => {
    const w = collectionWorld();
    expect(await addAssetToCollection(w.db, COLLECTION, assetId(1), ALICE)).toBe(true);
    expect(await addAssetToCollection(w.db, COLLECTION, assetId(2), ALICE)).toBe(true);
    // Adding twice is idempotent, and must not inflate the count.
    expect(await addAssetToCollection(w.db, COLLECTION, assetId(2), ALICE)).toBe(true);

    expect(await listCollections(w.db, ALICE)).toEqual([
      { id: COLLECTION, name: 'Keepers', assetCount: 2, createdAt: expect.any(String) },
    ]);

    // A soft delete leaves the membership row behind; the count must not.
    await softDeleteAsset(w.db, assetId(1), ALICE);
    expect((await listCollections(w.db, ALICE))[0]!.assetCount).toBe(1);

    await removeAssetFromCollection(w.db, COLLECTION, assetId(2), ALICE);
    expect((await listCollections(w.db, ALICE))[0]!.assetCount).toBe(0);
  });

  it('refuses to add an asset the caller does not own', async () => {
    const w = collectionWorld();
    // Bob's asset, Alice's collection: nothing inserted, reported as 404.
    expect(await addAssetToCollection(w.db, COLLECTION, assetId(3), ALICE)).toBe(false);
    expect(w.members).toEqual([]);

    // A nonexistent asset gives exactly the same answer.
    expect(await addAssetToCollection(w.db, COLLECTION, assetId(99), ALICE)).toBe(false);
  });

  it("refuses to touch another user's collection", async () => {
    const w = collectionWorld();
    expect(await addAssetToCollection(w.db, BOB_COLLECTION, assetId(1), ALICE)).toBe(false);
    expect(await removeAssetFromCollection(w.db, BOB_COLLECTION, assetId(3), ALICE)).toBe(false);
    expect(await deleteCollection(w.db, BOB_COLLECTION, ALICE)).toBe(false);
    expect(w.collections.some((c) => c.id === BOB_COLLECTION)).toBe(true);
  });

  it('creates and deletes, leaving the assets alone', async () => {
    const w = collectionWorld();
    const created = await createCollection(w.db, ALICE, 'Blues');
    expect(created).toMatchObject({ name: 'Blues', assetCount: 0 });

    await addAssetToCollection(w.db, created.id, assetId(1), ALICE);
    expect(await deleteCollection(w.db, created.id, ALICE)).toBe(true);
    expect(await deleteCollection(w.db, created.id, ALICE)).toBe(false);
    // The asset itself survives its collection.
    expect(await getAsset(w.db, assetId(1), ALICE)).not.toBeNull();
  });
});
