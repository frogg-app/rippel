/**
 * Unit tests for asset storage. Everything here runs against a temp directory
 * and an in-memory stand-in for the database — no Postgres, no ComfyUI.
 */

import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { LocalStorageDriver } from './local.js';
import { StorageNotFound, buildKey, assertSafeKey, keyBelongsToUser } from './driver.js';
import { resolveAssetForRead } from './access.js';
import { persistOutput, type AssetDb, type AssetRow } from './persist.js';

const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';
const JOB = '33333333-3333-4333-8333-333333333333';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'comfy-storage-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function pngBytes(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 200, g: 60, b: 90 } },
  })
    .png()
    .toBuffer();
}

// ---------------------------------------------------------------- keys

describe('storage keys', () => {
  it('namespaces every key under its owner', () => {
    const key = buildKey({ userId: ALICE, extension: 'png' });
    expect(key.startsWith(`u/${ALICE}/`)).toBe(true);
    expect(keyBelongsToUser(key, ALICE)).toBe(true);
    expect(keyBelongsToUser(key, BOB)).toBe(false);
  });

  it('is not guessable from the job or filename', () => {
    const a = buildKey({ userId: ALICE, extension: 'png' });
    const b = buildKey({ userId: ALICE, extension: 'png' });
    expect(a).not.toEqual(b);
    // 16 random bytes as hex, plus the extension.
    expect(a.split('/').pop()).toMatch(/^[0-9a-f]{32}\.png$/);
  });

  it('marks thumbnails distinctly', () => {
    const key = buildKey({ userId: ALICE, extension: 'webp', variant: 'thumb' });
    expect(key).toMatch(/_thumb\.webp$/);
  });

  it('rejects traversal and absolute keys', () => {
    for (const bad of ['../etc/passwd', 'u/../x', '/etc/passwd', 'u//x', 'u/x/..']) {
      expect(() => assertSafeKey(bad)).toThrow();
    }
  });
});

// ---------------------------------------------------------------- local driver

describe('LocalStorageDriver', () => {
  it('round-trips bytes through put/get', async () => {
    const driver = new LocalStorageDriver(root);
    const key = buildKey({ userId: ALICE, extension: 'png' });
    const bytes = await pngBytes(8, 8);

    await driver.put(key, bytes, 'image/png');
    expect(await driver.exists(key)).toBe(true);
    expect(Buffer.compare(await driver.get(key), bytes)).toBe(0);
  });

  it('streams with a content type and a length', async () => {
    const driver = new LocalStorageDriver(root);
    const key = buildKey({ userId: ALICE, extension: 'png' });
    const bytes = await pngBytes(8, 8);
    await driver.put(key, bytes, 'image/png');

    const object = await driver.getStream(key);
    expect(object.contentType).toBe('image/png');
    expect(object.size).toBe(bytes.byteLength);

    const chunks: Buffer[] = [];
    for await (const chunk of object.stream) chunks.push(Buffer.from(chunk as Buffer));
    expect(Buffer.compare(Buffer.concat(chunks), bytes)).toBe(0);
  });

  it('reports a missing object as StorageNotFound', async () => {
    const driver = new LocalStorageDriver(root);
    const key = buildKey({ userId: ALICE, extension: 'png' });
    await expect(driver.get(key)).rejects.toBeInstanceOf(StorageNotFound);
    await expect(driver.getStream(key)).rejects.toBeInstanceOf(StorageNotFound);
    expect(await driver.exists(key)).toBe(false);
  });

  it('deletes idempotently and overwrites in place', async () => {
    const driver = new LocalStorageDriver(root);
    const key = buildKey({ userId: ALICE, extension: 'png' });
    await driver.put(key, Buffer.from('one'), 'image/png');
    await driver.put(key, Buffer.from('two'), 'image/png');
    expect((await driver.get(key)).toString()).toBe('two');

    await driver.delete(key);
    await driver.delete(key); // already gone: still fine
    expect(await driver.exists(key)).toBe(false);
  });

  it('leaves no temp files behind after a write', async () => {
    const driver = new LocalStorageDriver(root);
    const key = buildKey({ userId: ALICE, extension: 'png' });
    await driver.put(key, await pngBytes(4, 4), 'image/png');
    const dir = join(root, key.split('/').slice(0, -1).join('/'));
    expect((await readdir(dir)).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('refuses to write outside its root', async () => {
    const driver = new LocalStorageDriver(root);
    await expect(driver.put('../escaped.png', Buffer.from('x'), 'image/png')).rejects.toThrow();
  });
});

// ---------------------------------------------------------------- ownership

/** Just enough of the assets table to answer the read query. */
function fakeDbWithAssets(rows: Record<string, unknown>[]): AssetDb {
  const run = (_sql: string, params: unknown[] = []) => {
    const [id, userId] = params as [string, string];
    return rows.filter(
      (r) => r.id === id && r.user_id === userId && r.deleted_at == null,
    );
  };
  return {
    query: (async (sql: string, params?: unknown[]) => run(sql, params)) as AssetDb['query'],
    queryOne: (async (sql: string, params?: unknown[]) =>
      run(sql, params)[0] ?? null) as AssetDb['queryOne'],
  };
}

describe('asset read ownership', () => {
  const key = `u/${ALICE}/2026/09/${'a'.repeat(32)}.png`;
  const thumbKey = `u/${ALICE}/2026/09/${'b'.repeat(32)}_thumb.webp`;
  const assetId = '44444444-4444-4444-8444-444444444444';

  const db = fakeDbWithAssets([
    {
      id: assetId,
      user_id: ALICE,
      storage_key: key,
      thumb_key: thumbKey,
      mime_type: 'image/png',
      deleted_at: null,
    },
  ]);

  it('lets the owner read their own asset', async () => {
    const access = await resolveAssetForRead(db, assetId, ALICE, 'full');
    expect(access).toMatchObject({ ok: true, key, contentType: 'image/png' });
  });

  it('serves the thumbnail key for the thumb variant', async () => {
    const access = await resolveAssetForRead(db, assetId, ALICE, 'thumb');
    expect(access).toMatchObject({ ok: true, key: thumbKey, contentType: 'image/webp' });
  });

  it('refuses another user, indistinguishably from a missing asset', async () => {
    const other = await resolveAssetForRead(db, assetId, BOB, 'full');
    const missing = await resolveAssetForRead(
      db,
      '55555555-5555-4555-8555-555555555555',
      ALICE,
      'full',
    );
    expect(other).toEqual({ ok: false, reason: 'not_found' });
    expect(missing).toEqual(other);
  });

  it('refuses a soft-deleted asset even for its owner', async () => {
    const deletedDb = fakeDbWithAssets([
      {
        id: assetId,
        user_id: ALICE,
        storage_key: key,
        thumb_key: null,
        mime_type: 'image/png',
        deleted_at: new Date(),
      },
    ]);
    expect(await resolveAssetForRead(deletedDb, assetId, ALICE, 'full')).toEqual({
      ok: false,
      reason: 'not_found',
    });
  });

  it('refuses a row whose key is outside the owner namespace', async () => {
    const corruptDb = fakeDbWithAssets([
      {
        id: assetId,
        user_id: ALICE,
        storage_key: `u/${BOB}/2026/09/${'c'.repeat(32)}.png`,
        thumb_key: null,
        mime_type: 'image/png',
        deleted_at: null,
      },
    ]);
    const access = await resolveAssetForRead(corruptDb, assetId, ALICE, 'full');
    expect(access).toMatchObject({ ok: false, reason: 'corrupt' });
  });

  it('falls back to the full image when there is no thumbnail', async () => {
    const noThumb = fakeDbWithAssets([
      {
        id: assetId,
        user_id: ALICE,
        storage_key: key,
        thumb_key: null,
        mime_type: 'image/png',
        deleted_at: null,
      },
    ]);
    expect(await resolveAssetForRead(noThumb, assetId, ALICE, 'thumb')).toMatchObject({
      ok: true,
      key,
      isThumb: false,
    });
  });
});

// ---------------------------------------------------------------- persistence

/**
 * A stand-in for `assets` that honours the unique (job_id, source_filename)
 * index from migration 003, so ON CONFLICT DO NOTHING behaves as Postgres would.
 */
interface FakeTable {
  db: AssetDb;
  rows: AssetRow[];
  readonly inserts: number;
}

function fakeAssetsTable(): FakeTable {
  type Row = AssetRow & { source_filename: string; deleted_at: Date | null } & Record<
    string,
    unknown
  >;
  const rows: Row[] = [];
  const state = { inserts: 0 };

  const run = (sql: string, params: unknown[] = []): Record<string, unknown>[] => {
    if (sql.trimStart().startsWith('SELECT')) {
      const [jobId, filename] = params as [string, string];
      const hit = rows.find(
        (r) => r.job_id === jobId && r.source_filename === filename && r.deleted_at === null,
      );
      return hit ? [hit] : [];
    }
    if (sql.trimStart().startsWith('INSERT')) {
      state.inserts += 1;
      const [
        jobId,
        userId,
        kind,
        storageKey,
        thumbKey,
        width,
        height,
        duration,
        sizeBytes,
        sourceFilename,
      ] = params as [
        string,
        string,
        'image' | 'video',
        string,
        string | null,
        number,
        number,
        number | null,
        number,
        string,
      ];
      // The unique index: a second insert for the same output does nothing.
      if (rows.some((r) => r.job_id === jobId && r.source_filename === sourceFilename)) {
        return [];
      }
      const row: Row = {
        id: `asset-${rows.length + 1}`,
        job_id: jobId,
        user_id: userId,
        kind,
        storage_key: storageKey,
        thumb_key: thumbKey,
        width,
        height,
        duration,
        size_bytes: sizeBytes,
        starred: false,
        created_at: new Date('2026-09-06T12:00:00Z'),
        source_filename: sourceFilename,
        deleted_at: null,
      };
      rows.push(row);
      return [row];
    }
    throw new Error(`unexpected SQL in test: ${sql}`);
  };

  const db: AssetDb = {
    query: (async (sql: string, params?: unknown[]) => run(sql, params)) as AssetDb['query'],
    queryOne: (async (sql: string, params?: unknown[]) =>
      run(sql, params)[0] ?? null) as AssetDb['queryOne'],
  };
  return {
    db,
    rows: rows as AssetRow[],
    get inserts() {
      return state.inserts;
    },
  };
}

describe('persistOutput', () => {
  it('stores the image, a thumbnail, and the real dimensions', async () => {
    const driver = new LocalStorageDriver(root);
    const { db, rows } = fakeAssetsTable();
    const bytes = await pngBytes(1024, 768);

    const asset = await persistOutput({
      userId: ALICE,
      jobId: JOB,
      source: { filename: 'ComfyUI_00001_.png', subfolder: '', type: 'output' },
      bytes,
      driver,
      db,
    });

    // Dimensions come from the bytes, not from anything the caller claimed.
    expect(asset.width).toBe(1024);
    expect(asset.height).toBe(768);
    expect(asset.url).toBe(`/api/assets/${asset.id}`);
    expect(asset.thumbUrl).toBe(`/api/assets/${asset.id}/thumb`);

    const row = rows[0]!;
    expect(await driver.exists(row.storage_key)).toBe(true);
    expect(row.thumb_key).toBeTruthy();

    const thumb = await sharp(await driver.get(row.thumb_key!)).metadata();
    expect(Math.max(thumb.width!, thumb.height!)).toBe(512);
    expect(thumb.format).toBe('webp');
    // Aspect ratio preserved.
    expect(thumb.width! / thumb.height!).toBeCloseTo(1024 / 768, 2);
  });

  it('never enlarges an image smaller than the thumbnail bound', async () => {
    const driver = new LocalStorageDriver(root);
    const { db, rows } = fakeAssetsTable();
    await persistOutput({
      userId: ALICE,
      jobId: JOB,
      source: { filename: 'small.png' },
      bytes: await pngBytes(64, 64),
      driver,
      db,
    });
    const thumb = await sharp(await driver.get(rows[0]!.thumb_key!)).metadata();
    expect(thumb.width).toBe(64);
  });

  it('is idempotent per (jobId, filename)', async () => {
    const driver = new LocalStorageDriver(root);
    const table = fakeAssetsTable();
    const bytes = await pngBytes(256, 256);
    const source = { filename: 'ComfyUI_00001_.png', subfolder: '', type: 'output' as const };

    const first = await persistOutput({ userId: ALICE, jobId: JOB, source, bytes, driver, db: table.db });
    // A reconciliation pass after a restart re-persists the same output.
    const second = await persistOutput({ userId: ALICE, jobId: JOB, source, bytes, driver, db: table.db });

    expect(second.id).toBe(first.id);
    expect(table.rows).toHaveLength(1);
    // The second call short-circuits before touching storage at all.
    expect(table.inserts).toBe(1);
  });

  it('keeps separate outputs of one job apart', async () => {
    const driver = new LocalStorageDriver(root);
    const table = fakeAssetsTable();
    const bytes = await pngBytes(64, 64);

    const a = await persistOutput({
      userId: ALICE, jobId: JOB, source: { filename: 'ComfyUI_00001_.png' }, bytes, driver, db: table.db,
    });
    const b = await persistOutput({
      userId: ALICE, jobId: JOB, source: { filename: 'ComfyUI_00002_.png' }, bytes, driver, db: table.db,
    });

    expect(a.id).not.toBe(b.id);
    expect(table.rows).toHaveLength(2);
    // Identical bytes must still land on different, non-guessable keys.
    expect(table.rows[0]!.storage_key).not.toBe(table.rows[1]!.storage_key);
  });

  it('cleans up the objects it wrote when it loses an insert race', async () => {
    const driver = new LocalStorageDriver(root);
    const table = fakeAssetsTable();
    const bytes = await pngBytes(64, 64);
    const source = { filename: 'ComfyUI_00001_.png' };

    // The "other worker" persists first.
    await persistOutput({ userId: ALICE, jobId: JOB, source, bytes, driver, db: table.db });
    const winnerKey = table.rows[0]!.storage_key;

    // Hide only the *first* lookup, so this call believes nothing exists yet,
    // writes its objects, and then loses the INSERT — exactly the race two
    // workers (or reconciliation overlapping a live completion) can hit.
    let hidden = false;
    const racingDb: AssetDb = {
      query: table.db.query,
      queryOne: (async (sql: string, params?: unknown[]) => {
        if (!hidden && sql.trimStart().startsWith('SELECT')) {
          hidden = true;
          return null;
        }
        return table.db.queryOne(sql, params);
      }) as AssetDb['queryOne'],
    };

    const before = await countObjects(driver, root);
    const asset = await persistOutput({ userId: ALICE, jobId: JOB, source, bytes, driver, db: racingDb });

    expect(asset.id).toBe(table.rows[0]!.id);
    expect(table.rows).toHaveLength(1);
    expect(await driver.exists(winnerKey)).toBe(true);
    // The losing call's image and thumbnail were both removed again.
    expect(await countObjects(driver, root)).toBe(before);
  });
});

/** Count every file under the driver root, temp files included. */
async function countObjects(_driver: LocalStorageDriver, dir: string): Promise<number> {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true });
  return entries.filter((e) => e.isFile()).length;
}
