/**
 * What the Library screen last showed, kept past the page's unmount, so going
 * back to it paints at once and refreshes underneath instead of starting from
 * skeleton tiles and "Loading…". The same idea as `lastLibrary` in
 * models/useModelLibrary.ts, and keyed the same way — by the api object — so
 * tests, which each make their own, never share.
 *
 * Unlike the Models caches this one holds a person's own renders, so it must
 * not outlive them: AuthProvider calls `clearLibraryCache` whenever the
 * signed-in user changes, sign-out included.
 *
 * Thumbnails are not cached here: tiles use the asset's plain `thumbUrl`, which
 * the browser's HTTP cache already serves without a refetch.
 */
import type { Collection, LibraryAsset, LibraryApi, LibraryFilters } from '../lib/api-library';

export interface FeedSnapshot {
  items: LibraryAsset[];
  cursor: string | null;
  hasMore: boolean;
}

interface LibraryCache {
  /** Per filter key (view, kind, starred, collection, search). */
  feeds: Map<string, FeedSnapshot>;
  collections?: Collection[];
  /** The filters last left, restored when the page mounts again. */
  filters?: LibraryFilters;
}

let caches = new WeakMap<LibraryApi, LibraryCache>();

export function libraryCache(api: LibraryApi): LibraryCache {
  let cache = caches.get(api);
  if (!cache) {
    cache = { feeds: new Map() };
    caches.set(api, cache);
  }
  return cache;
}

/** Forget everything, for every api. A WeakMap cannot be cleared, so replace it. */
export function clearLibraryCache(): void {
  caches = new WeakMap();
}
