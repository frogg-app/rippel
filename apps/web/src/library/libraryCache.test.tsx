/**
 * Coming back to the Library paints what it showed last, at once, and then
 * refreshes underneath — the same promise the Models page makes. And none of
 * it survives a change of user.
 */
import { describe, expect, it } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useLibraryFeed } from './useLibraryFeed';
import { useCollections } from './useCollections';
import { clearLibraryCache, libraryCache } from './libraryCache';
import { asset, assets, fakeLibrary } from './testing';

const collection = { id: 'c1', name: 'Moodboard', assetCount: 2 } as never;

describe('library cache', () => {
  it('paints a revisited feed from cache, then revalidates in the background', async () => {
    const api = fakeLibrary(assets(5));
    const first = renderHook(() => useLibraryFeed({ filters: {}, api }));
    await waitFor(() => expect(first.result.current.loading).toBe(false));
    first.unmount();

    // A render lands while the page is away.
    api.rows.unshift(asset({ id: 'new' }));

    const second = renderHook(() => useLibraryFeed({ filters: {}, api }));
    // No skeleton: the old rows are there on the very first render.
    expect(second.result.current.loading).toBe(false);
    expect(second.result.current.items).toHaveLength(5);
    await waitFor(() => expect(second.result.current.items).toHaveLength(6));
    expect(second.result.current.items[0]?.id).toBe('new');
    expect(api.requests).toHaveLength(2);
  });

  it('keys the cache by filter and search, never filing rows under another', async () => {
    const api = fakeLibrary(assets(5));
    const { result, rerender, unmount } = renderHook(
      ({ q }) => useLibraryFeed({ filters: { q }, api }),
      { initialProps: { q: '' } },
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    rerender({ q: 'cat' });
    await waitFor(() => expect(result.current.loading).toBe(false));
    unmount();

    const keys = [...libraryCache(api).feeds.keys()];
    expect(keys).toHaveLength(2);
    expect(keys.some((key) => key.includes('"cat"'))).toBe(true);

    // A search never seen before still starts from a skeleton.
    const fresh = renderHook(() => useLibraryFeed({ filters: { q: 'dog' }, api }));
    expect(fresh.result.current.loading).toBe(true);
  });

  it('remembers local edits, so a star is not undone on the next visit', async () => {
    const api = fakeLibrary(assets(3));
    const first = renderHook(() => useLibraryFeed({ filters: {}, api }));
    await waitFor(() => expect(first.result.current.loading).toBe(false));
    act(() => first.result.current.patch('a0', { starred: true }));
    first.unmount();

    const second = renderHook(() => useLibraryFeed({ filters: {}, api }));
    expect(second.result.current.items[0]?.starred).toBe(true);
  });

  it('shows cached collections at once instead of "Loading…"', async () => {
    const api = fakeLibrary([], [collection]);
    const first = renderHook(() => useCollections(api));
    await waitFor(() => expect(first.result.current.loading).toBe(false));
    first.unmount();

    const second = renderHook(() => useCollections(api));
    expect(second.result.current.loading).toBe(false);
    expect(second.result.current.collections.map((c) => c.id)).toEqual(['c1']);
  });

  it('forgets everything when cleared, as on sign-out or a change of user', async () => {
    const api = fakeLibrary(assets(3), [collection]);
    const feed = renderHook(() => useLibraryFeed({ filters: {}, api }));
    const rail = renderHook(() => useCollections(api));
    await waitFor(() => expect(feed.result.current.loading).toBe(false));
    await waitFor(() => expect(rail.result.current.loading).toBe(false));
    feed.unmount();
    rail.unmount();
    libraryCache(api).filters = { view: 'archived' };

    clearLibraryCache();

    expect(libraryCache(api).feeds.size).toBe(0);
    expect(libraryCache(api).collections).toBeUndefined();
    expect(libraryCache(api).filters).toBeUndefined();
    expect(renderHook(() => useLibraryFeed({ filters: {}, api })).result.current.loading).toBe(true);
  });
});
