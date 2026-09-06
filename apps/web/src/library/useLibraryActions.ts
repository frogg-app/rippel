/**
 * Star, delete and undo — the three actions that change something.
 *
 * Both are optimistic, for the same reason: a star that waits 200ms before
 * filling in feels broken, and a tile that lingers after you delete it feels
 * broken in a worse way. Optimism is only honest if the failure path is real,
 * so each one keeps enough state to put the world back exactly as it was:
 *
 *   star   — flip the flag, call the API, flip it back and say so on failure.
 *   delete — take the row out and *remember its index*, soft-delete on the
 *            server, and offer an undo that restores the row to that same
 *            position rather than dropping it at the top of the grid.
 *
 * The undo window is the only reason the API's delete is soft. The bytes are
 * still there; the row just has a `deleted_at`.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { LibraryApi, LibraryAsset } from '../lib/api-library';
import { libraryApi as defaultApi } from '../lib/api-library';
import type { LibraryFeed } from './useLibraryFeed';

/** How long the undo bar stays up. Long enough to notice, short enough to go. */
export const UNDO_WINDOW_MS = 8000;

export interface PendingDelete {
  asset: LibraryAsset;
  /** Where it was in the grid, so undo puts it back there and not at the top. */
  index: number;
}

export interface LibraryActions {
  toggleStar: (asset: LibraryAsset) => Promise<void>;
  remove: (asset: LibraryAsset) => Promise<void>;
  undo: () => Promise<void>;
  dismissUndo: () => void;
  /** Set while the undo bar should be showing. */
  pendingDelete: PendingDelete | null;
  /** A short sentence to show when an action failed. Cleared on the next one. */
  error: string | null;
  clearError: () => void;
}

export interface LibraryActionsOptions {
  feed: Pick<LibraryFeed, 'patch' | 'take' | 'put' | 'drop'>;
  /** Called when a row disappears, so an open drawer can close itself. */
  onRemoved?: (assetId: string) => void;
  api?: LibraryApi;
}

export function useLibraryActions({
  feed,
  onRemoved,
  api = defaultApi,
}: LibraryActionsOptions): LibraryActions {
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimer = useCallback(() => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);

  useEffect(() => clearTimer, [clearTimer]);

  const toggleStar = useCallback(
    async (asset: LibraryAsset) => {
      const next = !asset.starred;
      setError(null);
      // Optimistic: the star fills in on the click, not on the round trip.
      feed.patch(asset.id, { starred: next });
      try {
        await api.assets.setStarred(asset.id, next);
      } catch {
        // Revert to what it actually was, not to `!next` — those differ if
        // something else changed the row while the request was out.
        feed.patch(asset.id, { starred: asset.starred });
        setError(next ? 'Could not star that.' : 'Could not unstar that.');
      }
    },
    [api, feed],
  );

  const remove = useCallback(
    async (asset: LibraryAsset) => {
      setError(null);
      const taken = feed.take(asset.id);
      if (!taken) return;
      onRemoved?.(asset.id);
      clearTimer();
      setPendingDelete({ asset: taken.item, index: taken.index });

      try {
        await api.assets.remove(asset.id);
      } catch {
        // Nothing was deleted, so put it straight back and drop the undo bar:
        // offering to undo something that never happened is worse than the
        // failure itself.
        feed.put(taken.item, taken.index);
        setPendingDelete(null);
        setError('Could not delete that.');
        return;
      }

      timer.current = setTimeout(() => setPendingDelete(null), UNDO_WINDOW_MS);
    },
    [api, clearTimer, feed, onRemoved],
  );

  const undo = useCallback(async () => {
    const pending = pendingDelete;
    if (!pending) return;
    clearTimer();
    setPendingDelete(null);
    // Optimistic again: the row reappears immediately, and only comes back out
    // if the server refuses to restore it.
    feed.put(pending.asset, pending.index);
    try {
      await api.assets.restore(pending.asset.id);
    } catch {
      // `drop`, not `take`: the `put` above may not have been flushed yet, so
      // a lookup by id would find nothing and quietly leave the row on screen.
      feed.drop(pending.asset.id);
      setError('Could not restore that.');
    }
  }, [api, clearTimer, feed, pendingDelete]);

  const dismissUndo = useCallback(() => {
    clearTimer();
    setPendingDelete(null);
  }, [clearTimer]);

  const clearError = useCallback(() => setError(null), []);

  return { toggleStar, remove, undo, dismissUndo, pendingDelete, error, clearError };
}
