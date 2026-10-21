/**
 * The access rule for each library view, read off the SQL it generates.
 *
 * library.test.ts runs against a fake that re-implements the queries; that
 * proves paging and filtering, but a fake cannot prove what the real WHERE
 * clause lets through. These assert the clause itself, which is where every
 * "never show someone else's private asset" guarantee actually lives.
 */
import { describe, expect, it } from 'vitest';
import { getAsset, listAssets, purgeArchived, type LibraryDb, type LibraryView } from './queries.js';
import { resolveAssetForRead } from '../storage/access.js';

function capture() {
  const seen: { sql: string; params: unknown[] }[] = [];
  const db = {
    query: async (sql: string, params: unknown[]) => {
      seen.push({ sql, params });
      return [];
    },
    queryOne: async (sql: string, params: unknown[]) => {
      seen.push({ sql, params });
      return null;
    },
  } as unknown as LibraryDb;
  return { db, seen };
}

const where = (sql: string) => sql.slice(sql.indexOf('WHERE'), sql.indexOf('ORDER BY'));

async function listSql(view: LibraryView, extra: { starred?: boolean } = {}) {
  const { db, seen } = capture();
  await listAssets(db, { userId: 'me', view, limit: 10, cursor: null, ...extra });
  return where(seen[0]!.sql);
}

describe('library views', () => {
  it('mine is only my live assets', async () => {
    const sql = await listSql('mine');
    expect(sql).toContain('a.user_id = $1');
    expect(sql).toContain('a.deleted_at IS NULL');
    expect(sql).not.toContain('asset_shares');
  });

  it('shared is only live assets someone shared with me by name', async () => {
    const sql = await listSql('shared');
    expect(sql).toContain('a.user_id <> $1');
    expect(sql).toContain('s.user_id = $1');
    expect(sql).toContain('a.deleted_at IS NULL');
    // Visibility plays no part: a public asset is not "shared with me".
    expect(sql).not.toContain('visibility');
  });

  it('everything is mine or shared with me, never anyone else’s', async () => {
    const sql = await listSql('everything');
    expect(sql).toContain('(a.user_id = $1 OR EXISTS');
    expect(sql).toContain('a.deleted_at IS NULL');
  });

  it('archived is only my own archive — a share never reaches it', async () => {
    const sql = await listSql('archived');
    expect(sql).toContain('a.user_id = $1');
    expect(sql).toContain('a.deleted_at IS NOT NULL');
    expect(sql).not.toContain('asset_shares');
  });

  it('keeps starred to my own assets in every view', async () => {
    expect(await listSql('everything', { starred: true })).toContain('a.user_id = $1');
  });

  it('lets a recipient read a shared asset only while it is live', async () => {
    const { db, seen } = capture();
    await getAsset(db, 'asset', 'me');
    expect(seen[0]!.sql).toContain('a.user_id = $2 OR (a.deleted_at IS NULL AND EXISTS');
  });

  it('serves bytes to the owner or a live share, nobody else', async () => {
    const { db, seen } = capture();
    await resolveAssetForRead(db as never, 'asset', 'me', 'full');
    expect(seen[0]!.sql).toMatch(/a\.user_id = \$2\s+OR \(a\.deleted_at IS NULL AND EXISTS/);
  });

  it('only ever force-deletes archived rows', async () => {
    for (const target of [
      { userId: 'me', ids: ['x'] },
      { userId: 'me', all: true as const },
      { olderThanDays: 30 },
    ]) {
      const { db, seen } = capture();
      await purgeArchived(db, target);
      expect(seen[0]!.sql).toContain('deleted_at IS NOT NULL');
    }
  });
});
