/**
 * The infinite-scroll feed behind the grid.
 *
 * The whole difficulty of this hook is that the library is not a static list
 * being paged through — it is a feed with rows arriving at the *top* while the
 * user scrolls down it. A job finishing inserts assets ahead of everything
 * already on screen. Three things fall out of that, and each one is a bug this
 * hook exists to not have:
 *
 *  1. Paging is by cursor, never by offset. An offset counts from the head, so
 *     one insertion shifts every later page by one and the reader sees the row
 *     at the boundary twice and never sees the one after it. A cursor names the
 *     row itself, so insertions above it are irrelevant. (The API side of that
 *     promise is documented in `lib/api-library.ts`.)
 *
 *  2. Appends are deduplicated by id anyway. A cursor makes duplicates
 *     impossible *in the steady state*, but a local prepend racing a page that
 *     was already in flight, or a retry after a partial failure, can still hand
 *     us a row we are holding. Belt and braces, because a duplicated React key
 *     is a rendering bug, not just a cosmetic one.
 *
 *  3. A page that turns out to be entirely duplicates is not the end of the
 *     feed. Concluding "no new rows, so we are done" would silently truncate
 *     the library; if the server still offers a cursor we keep following it.
 *
 * Everything else here is ordinary: one request in flight at a time, and a
 * generation counter so a response for filters the user has already changed is
 * dropped rather than painted.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { LibraryApi, LibraryAsset, LibraryFilters } from '../lib/api-library';
import { libraryApi as defaultApi } from '../lib/api-library';

export interface LibraryFeed {
  items: LibraryAsset[];
  /** True only while the *first* page of the current filters is loading. */
  loading: boolean;
  /** True while a subsequent page is loading — drives the bottom spinner. */
  loadingMore: boolean;
  error: string | null;
  /** False once the server has said there is no next cursor. */
  hasMore: boolean;
  /** Safe to call at any time; ignored when a request is already in flight. */
  loadMore: () => void;
  /** Throw the feed away and re-fetch from the top. */
  reload: () => void;

  // -- local mutations, so an optimistic action does not refetch the world --

  /** Merge fields into one row in place. No-op if the row is not held. */
  patch: (id: string, patch: Partial<LibraryAsset>) => void;
  /**
   * Take a row out and hand back where it was, so it can be put back exactly
   * there if the user undoes. Returns null when the row is not held.
   */
  take: (id: string) => { item: LibraryAsset; index: number } | null;
  /** Put a row back at an index — the other half of `take`. */
  put: (item: LibraryAsset, index: number) => void;
  /**
   * Remove a row we already have in hand. `take` has to *find* the row to
   * report where it was, which means reading a snapshot of state; this one
   * only removes, so it is safe to call immediately after a `put` that React
   * has not flushed yet — which is exactly what a failed undo does.
   */
  drop: (id: string) => void;
}

export interface LibraryFeedOptions {
  filters: LibraryFilters;
  pageSize?: number;
  /** Injected by the tests; production uses the module's own client. */
  api?: LibraryApi;
}

interface FeedState {
  items: LibraryAsset[];
  cursor: string | null;
  hasMore: boolean;
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
  /**
   * How many rows the last completed page actually added, after deduplication.
   * Zero with a cursor still in hand means the page was entirely rows we were
   * already holding — see the auto-continue effect below.
   */
  lastAppended: number | null;
}

const EMPTY: FeedState = {
  items: [],
  cursor: null,
  hasMore: true,
  loading: true,
  loadingMore: false,
  error: null,
  lastAppended: null,
};

export function useLibraryFeed({
  filters,
  pageSize = 40,
  api = defaultApi,
}: LibraryFeedOptions): LibraryFeed {
  const [state, setState] = useState<FeedState>(EMPTY);

  // Filters are a fresh object every render; comparing their *contents* is what
  // stops every parent render from restarting the feed.
  const filterKey = JSON.stringify([
    filters.kind ?? null,
    filters.starred ?? false,
    filters.collectionId ?? null,
    filters.q?.trim() ?? '',
  ]);

  /**
   * Bumped whenever the feed is thrown away. A response carrying an older
   * generation belongs to filters the user has already moved on from, so it is
   * dropped — otherwise a slow first request can land after a fast second one
   * and repopulate the grid with the previous search.
   */
  const generation = useRef(0);
  const inFlight = useRef(false);
  const stateRef = useRef(state);
  stateRef.current = state;

  const [nonce, setNonce] = useState(0);

  const fetchPage = useCallback(
    async (mine: number, cursor: string | null) => {
      if (inFlight.current) return;
      inFlight.current = true;

      setState((prev) => ({
        ...prev,
        error: null,
        loading: cursor === null,
        loadingMore: cursor !== null,
      }));

      try {
        const page = await api.assets.list({ ...filters, cursor, limit: pageSize });
        if (generation.current !== mine) return;

        setState((prev) => {
          const held = new Set(prev.items.map((item) => item.id));
          const fresh = page.items.filter((item) => !held.has(item.id));
          return {
            items: cursor === null ? page.items : [...prev.items, ...fresh],
            cursor: page.nextCursor,
            hasMore: page.nextCursor !== null,
            loading: false,
            loadingMore: false,
            error: null,
            lastAppended: cursor === null ? page.items.length : fresh.length,
          };
        });
      } catch (cause) {
        if (generation.current !== mine) return;
        setState((prev) => ({
          ...prev,
          loading: false,
          loadingMore: false,
          error: cause instanceof Error ? cause.message : 'Could not load your library.',
        }));
      } finally {
        if (generation.current === mine) inFlight.current = false;
      }
    },
    // `filters` is captured by value here; `filterKey` is what actually changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [filterKey, pageSize, api],
  );

  // First page, and a fresh one whenever the filters change or `reload` fires.
  useEffect(() => {
    generation.current += 1;
    inFlight.current = false;
    const mine = generation.current;
    setState({ ...EMPTY });
    void fetchPage(mine, null);
    return () => {
      // Anything still in flight belongs to a feed that no longer exists.
      generation.current += 1;
      inFlight.current = false;
    };
  }, [fetchPage, nonce]);

  const loadMore = useCallback(() => {
    const current = stateRef.current;
    if (inFlight.current || !current.hasMore || current.loading || current.error) return;
    void fetchPage(generation.current, current.cursor);
  }, [fetchPage]);

  /**
   * A page can add nothing at all — every row in it already held, because a
   * retry re-served them or the feed shifted under us. That is emphatically not
   * the end of the library, and treating it as one would truncate the grid
   * permanently: the scroll sentinel is already on screen and unmoved, so it
   * will never fire again to correct the mistake. If the server still offers a
   * cursor, follow it.
   */
  const lastAutoCursor = useRef<string | null>(null);
  useEffect(() => {
    if (state.loading || state.loadingMore || state.error || !state.hasMore) return;
    if (state.lastAppended !== 0 || state.cursor === null) return;
    // Guard against a server that keeps handing back the same cursor with
    // nothing behind it — one retry per cursor, then stop.
    if (lastAutoCursor.current === state.cursor) return;
    lastAutoCursor.current = state.cursor;
    loadMore();
  }, [
    state.loading,
    state.loadingMore,
    state.error,
    state.hasMore,
    state.lastAppended,
    state.cursor,
    loadMore,
  ]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  const patch = useCallback((id: string, changes: Partial<LibraryAsset>) => {
    setState((prev) => {
      const index = prev.items.findIndex((item) => item.id === id);
      if (index === -1) return prev;
      const items = prev.items.slice();
      items[index] = { ...items[index]!, ...changes };
      return { ...prev, items };
    });
  }, []);

  const take = useCallback((id: string) => {
    const index = stateRef.current.items.findIndex((item) => item.id === id);
    if (index === -1) return null;
    const item = stateRef.current.items[index]!;
    setState((prev) => ({ ...prev, items: prev.items.filter((candidate) => candidate.id !== id) }));
    return { item, index };
  }, []);

  const drop = useCallback((id: string) => {
    setState((prev) => ({ ...prev, items: prev.items.filter((item) => item.id !== id) }));
  }, []);

  const put = useCallback((item: LibraryAsset, index: number) => {
    setState((prev) => {
      if (prev.items.some((candidate) => candidate.id === item.id)) return prev;
      const items = prev.items.slice();
      items.splice(Math.min(Math.max(index, 0), items.length), 0, item);
      return { ...prev, items };
    });
  }, []);

  return useMemo(
    () => ({
      items: state.items,
      loading: state.loading,
      loadingMore: state.loadingMore,
      error: state.error,
      hasMore: state.hasMore,
      loadMore,
      reload,
      patch,
      take,
      put,
      drop,
    }),
    [state, loadMore, reload, patch, take, put, drop],
  );
}
