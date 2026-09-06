/**
 * The paging hook, tested for the thing that is expensive to get wrong.
 *
 * A library grid that silently repeats a row is annoying; one that silently
 * *drops* a row is a data-loss bug from the user's point of view — the render
 * is still on disk, but they cannot find it and have no reason to think it
 * exists. Both failures happen at exactly one place: the page boundary, when
 * the feed changed while the user was scrolling. So that is what these
 * exercise.
 */
import { describe, expect, it } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useLibraryFeed } from './useLibraryFeed';
import { asset, assets, fakeLibrary } from './testing';

const PAGE = 10;

function ids(items: Array<{ id: string }>): string[] {
  return items.map((item) => item.id);
}

describe('useLibraryFeed', () => {
  it('pages with a cursor and stops when the server says there is no more', async () => {
    const api = fakeLibrary(assets(25));
    const { result } = renderHook(() =>
      useLibraryFeed({ filters: {}, pageSize: PAGE, api }),
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.items).toHaveLength(PAGE);

    act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.items).toHaveLength(20));

    act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.items).toHaveLength(25));
    expect(result.current.hasMore).toBe(false);

    // Every id exactly once, in feed order.
    expect(new Set(ids(result.current.items)).size).toBe(25);
    expect(ids(result.current.items)).toEqual(ids(assets(25)));

    // The second request asked for what came *after* a named row, not for an
    // offset — the distinction the whole design rests on.
    expect(api.requests[1]?.cursor).toBe('a9');
  });

  it('drops nothing and repeats nothing when rows arrive at the top mid-scroll', async () => {
    const api = fakeLibrary(assets(25));
    const { result } = renderHook(() =>
      useLibraryFeed({ filters: {}, pageSize: PAGE, api }),
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    const firstPage = ids(result.current.items);
    expect(firstPage).toHaveLength(PAGE);

    // A job finishes: three new renders land at the head of the feed while the
    // user is still looking at page one. With offset paging this is where the
    // boundary row gets served twice and its neighbour never gets served.
    api.rows.unshift(...assets(3, 900).reverse());

    act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.items).toHaveLength(20));

    act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.hasMore).toBe(false));

    const seen = ids(result.current.items);
    expect(new Set(seen).size).toBe(seen.length); // nothing twice
    // Everything that existed when we started is still reachable; the three
    // that arrived above the cursor are simply above where we are reading,
    // which is correct — they are newer than the whole feed we are walking.
    for (const original of ids(assets(25))) {
      expect(seen).toContain(original);
    }
  });

  it('does not serve the same row twice when a page overlaps rows already held', async () => {
    const api = fakeLibrary(assets(25));
    const { result } = renderHook(() =>
      useLibraryFeed({ filters: {}, pageSize: PAGE, api }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));

    // A row the client already holds is *also* returned in the next page —
    // what a retried request or a re-ordered feed produces. React would warn
    // about a duplicate key and the grid would render it twice.
    const duplicate = { ...result.current.items[3]! };
    api.rows.splice(12, 0, duplicate);

    act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.loadingMore).toBe(false));

    const seen = ids(result.current.items);
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.filter((id) => id === duplicate.id)).toHaveLength(1);
  });

  it('keeps following the cursor when a whole page turns out to be duplicates', async () => {
    // A scripted pager rather than the row-list fake, because this is about the
    // hook's reaction to a specific server answer: a full page of rows it
    // already holds, with a cursor still offered. Concluding "that page added
    // nothing, so we are done" would hide everything after it for good — the
    // scroll sentinel is already on screen and unmoved, so nothing would ever
    // fire again to correct it.
    const page1 = assets(10);
    const responses = [
      { items: page1, nextCursor: 'p1' },
      { items: page1.map((row) => ({ ...row })), nextCursor: 'p2' },
      { items: [asset({ id: 'fresh' })], nextCursor: null },
    ];
    const api = fakeLibrary([]);
    let call = 0;
    api.assets.list = () => Promise.resolve(responses[call++] ?? { items: [], nextCursor: null });

    const { result } = renderHook(() => useLibraryFeed({ filters: {}, pageSize: PAGE, api }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.items).toHaveLength(10);

    act(() => result.current.loadMore());

    // Page two adds nothing after deduplication; the hook must go on to page
    // three by itself rather than stalling.
    await waitFor(() => expect(ids(result.current.items)).toContain('fresh'));
    expect(new Set(ids(result.current.items)).size).toBe(11);
    expect(result.current.hasMore).toBe(false);
  });

  it('throws the feed away and starts from the top when the filters change', async () => {
    const api = fakeLibrary([
      ...assets(5),
      asset({ id: 'v1', kind: 'video', createdAt: '2026-09-05T12:00:00.000Z' }),
    ]);

    const { result, rerender } = renderHook(
      ({ kind }: { kind?: 'image' | 'video' }) =>
        useLibraryFeed({ filters: { kind }, pageSize: PAGE, api }),
      { initialProps: {} as { kind?: 'image' | 'video' } },
    );
    await waitFor(() => expect(result.current.items).toHaveLength(6));

    rerender({ kind: 'video' });
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(api.requests.at(-1)?.kind).toBe('video');
    expect(api.requests.at(-1)?.cursor).toBeNull();
  });

  it('does not restart the feed when the parent re-renders with equal filters', async () => {
    const api = fakeLibrary(assets(5));
    const { result, rerender } = renderHook(
      () => useLibraryFeed({ filters: { q: 'street' }, pageSize: PAGE, api }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    const before = api.requests.length;

    // A fresh `filters` object with identical contents, as every parent render
    // produces. Comparing by reference here would refetch on every keystroke
    // anywhere in the page.
    rerender();
    rerender();

    expect(api.requests).toHaveLength(before);
  });
});
