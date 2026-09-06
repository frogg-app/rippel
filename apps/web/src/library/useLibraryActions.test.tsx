/**
 * Star, delete and undo.
 *
 * The optimism is the risk. Every one of these updates the screen before the
 * server has agreed, so what actually needs proving is not the happy path —
 * that is visible the moment you click anything — but that a refusal puts the
 * world back exactly as it was, and that undo restores the row *where it was*
 * rather than dropping it at the top of the grid.
 */
import { describe, expect, it } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useLibraryActions } from './useLibraryActions';
import { useLibraryFeed } from './useLibraryFeed';
import { assets, fakeLibrary, type FakeLibrary } from './testing';

/** The two hooks as the page wires them, since they are only correct together. */
function renderLibrary(api: FakeLibrary) {
  return renderHook(() => {
    const feed = useLibraryFeed({ filters: {}, pageSize: 40, api });
    const actions = useLibraryActions({ feed, api });
    return { feed, actions };
  });
}

describe('star', () => {
  it('fills in immediately and stays filled when the server agrees', async () => {
    const api = fakeLibrary(assets(5));
    const { result } = renderLibrary(api);
    await waitFor(() => expect(result.current.feed.items).toHaveLength(5));

    const target = result.current.feed.items[2]!;
    expect(target.starred).toBe(false);

    await act(async () => {
      await result.current.actions.toggleStar(target);
    });

    expect(result.current.feed.items[2]?.starred).toBe(true);
    expect(api.rows.find((row) => row.id === target.id)?.starred).toBe(true);
    expect(result.current.actions.error).toBeNull();
  });

  it('reverts and says so when the request fails', async () => {
    const api = fakeLibrary(assets(5));
    const { result } = renderLibrary(api);
    await waitFor(() => expect(result.current.feed.items).toHaveLength(5));

    const target = result.current.feed.items[2]!;
    api.failNext.setStarred = true;

    await act(async () => {
      await result.current.actions.toggleStar(target);
    });

    // Back to false — not left lit, and not left in some third "pending" state
    // the user cannot act on.
    expect(result.current.feed.items[2]?.starred).toBe(false);
    expect(result.current.actions.error).toMatch(/could not star/i);
  });

  it('reverts an unstar to starred, not to false', async () => {
    // The revert has to restore what the row *was*, which is the opposite of
    // the naive `!next`. Getting this backwards only shows up when unstarring
    // fails, which is exactly when nobody is looking.
    const api = fakeLibrary(assets(3).map((row, index) => ({ ...row, starred: index === 1 })));
    const { result } = renderLibrary(api);
    await waitFor(() => expect(result.current.feed.items).toHaveLength(3));

    const target = result.current.feed.items[1]!;
    expect(target.starred).toBe(true);
    api.failNext.setStarred = true;

    await act(async () => {
      await result.current.actions.toggleStar(target);
    });

    expect(result.current.feed.items[1]?.starred).toBe(true);
    expect(result.current.actions.error).toMatch(/could not unstar/i);
  });
});

describe('delete and undo', () => {
  it('removes the row at once, then restores it to the same position on undo', async () => {
    const api = fakeLibrary(assets(6));
    const { result } = renderLibrary(api);
    await waitFor(() => expect(result.current.feed.items).toHaveLength(6));

    const before = result.current.feed.items.map((item) => item.id);
    const target = result.current.feed.items[3]!;

    await act(async () => {
      await result.current.actions.remove(target);
    });

    expect(result.current.feed.items.map((item) => item.id)).toEqual(
      before.filter((id) => id !== target.id),
    );
    expect(api.deleted.has(target.id)).toBe(true);
    // The undo affordance is up, and knows where the row belongs.
    expect(result.current.actions.pendingDelete?.asset.id).toBe(target.id);
    expect(result.current.actions.pendingDelete?.index).toBe(3);

    await act(async () => {
      await result.current.actions.undo();
    });

    // Exactly the original order — restoring to index 0, or appending at the
    // end, would look to the user like undo moved their picture.
    expect(result.current.feed.items.map((item) => item.id)).toEqual(before);
    expect(api.deleted.has(target.id)).toBe(false);
    expect(result.current.actions.pendingDelete).toBeNull();
  });

  it('puts the row straight back and offers no undo when the delete itself fails', async () => {
    const api = fakeLibrary(assets(4));
    const { result } = renderLibrary(api);
    await waitFor(() => expect(result.current.feed.items).toHaveLength(4));

    const before = result.current.feed.items.map((item) => item.id);
    api.failNext.remove = true;

    await act(async () => {
      await result.current.actions.remove(result.current.feed.items[1]!);
    });

    expect(result.current.feed.items.map((item) => item.id)).toEqual(before);
    // Nothing was deleted, so offering to undo it would be a lie.
    expect(result.current.actions.pendingDelete).toBeNull();
    expect(result.current.actions.error).toMatch(/could not delete/i);
  });

  it('takes the row back out when the restore is refused', async () => {
    const api = fakeLibrary(assets(4));
    const { result } = renderLibrary(api);
    await waitFor(() => expect(result.current.feed.items).toHaveLength(4));

    const target = result.current.feed.items[2]!;
    await act(async () => {
      await result.current.actions.remove(target);
    });

    api.failNext.restore = true;
    await act(async () => {
      await result.current.actions.undo();
    });

    expect(result.current.feed.items.some((item) => item.id === target.id)).toBe(false);
    expect(result.current.actions.error).toMatch(/could not restore/i);
  });

  it('closes an open drawer when its asset is deleted', async () => {
    const api = fakeLibrary(assets(3));
    let closed: string | null = null;
    const { result } = renderHook(() => {
      const feed = useLibraryFeed({ filters: {}, pageSize: 40, api });
      const actions = useLibraryActions({
        feed,
        api,
        onRemoved: (id) => {
          closed = id;
        },
      });
      return { feed, actions };
    });
    await waitFor(() => expect(result.current.feed.items).toHaveLength(3));

    const target = result.current.feed.items[0]!;
    await act(async () => {
      await result.current.actions.remove(target);
    });

    expect(closed).toBe(target.id);
  });
});
