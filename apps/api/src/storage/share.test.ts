import { describe, expect, it } from 'vitest';
import { newShareToken, rowToAsset, type AssetRow } from './persist.js';
import { resolveSharedAsset } from './share.js';

const row = (overrides: Partial<AssetRow>): AssetRow => ({
  id: '00000000-0000-4000-8000-000000000001',
  job_id: '00000000-0000-4000-8000-000000000002',
  user_id: 'u1',
  kind: 'image',
  storage_key: 'u/u1/a.png',
  thumb_key: null,
  width: 1,
  height: 1,
  duration: null,
  size_bytes: 1,
  starred: false,
  visibility: 'private',
  share_token: null,
  created_at: '2026-10-21T00:00:00Z',
  ...overrides,
});

describe('share links', () => {
  it('mints unguessable, URL-safe tokens', () => {
    const a = newShareToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(newShareToken()).not.toBe(a);
  });

  it('gives a private asset no share URL, even when it kept an old token', () => {
    expect(rowToAsset(row({ share_token: 'kept-from-before' })).shareUrl).toBeNull();
  });

  it('serves a link or public asset by token, never by id', () => {
    const asset = rowToAsset(row({ visibility: 'link', share_token: 'tok' }));
    expect(asset.shareUrl).toBe('/api/share/tok');
    expect(asset.shareUrl).not.toContain(asset.id);
  });

  it('only resolves a token for an asset that is currently shared', async () => {
    let sql = '';
    await resolveSharedAsset(
      {
        queryOne: (async (text: string) => {
          sql = text;
          return null;
        }) as never,
      },
      'tok',
    );
    expect(sql).toContain("visibility IN ('link', 'public')");
    expect(sql).toContain('deleted_at IS NULL');
  });
});
