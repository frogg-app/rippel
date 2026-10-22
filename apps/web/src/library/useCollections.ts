/**
 * Collections — the sidebar list and the "add to…" menu.
 *
 * Deliberately small. This is not a management screen: you can see your
 * collections, filter by one, make a new one, and put the asset you are looking
 * at into or out of one. Renaming, reordering, covers and nesting are not here
 * because nothing in the design asks for them.
 *
 * Membership lives on the asset (`LibraryAsset.collectionIds`) rather than
 * being fetched per collection, so the drawer's tick marks are already in hand
 * and adding one is a local patch plus a request.
 */
import { useCallback, useEffect, useState } from 'react';
import type { Collection, LibraryApi } from '../lib/api-library';
import { libraryApi as defaultApi } from '../lib/api-library';
import { libraryCache } from './libraryCache';

export interface CollectionsState {
  collections: Collection[];
  loading: boolean;
  error: string | null;
  create: (name: string) => Promise<Collection | null>;
  /** Both sides of membership, with the count kept in step locally. */
  add: (collectionId: string, assetId: string) => Promise<boolean>;
  remove: (collectionId: string, assetId: string) => Promise<boolean>;
}

export function useCollections(api: LibraryApi = defaultApi): CollectionsState {
  // The last list, if this page has been visited: shown at once, refreshed below.
  const [collections, setCollections] = useState<Collection[]>(() => libraryCache(api).collections ?? []);
  const [loading, setLoading] = useState(() => libraryCache(api).collections === undefined);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    let live = true;
    api.collections
      .list(controller.signal)
      .then((result) => {
        if (live) setCollections(result.collections);
      })
      .catch(() => {
        // A failed collections load must not take the grid down with it — the
        // rail just shows nothing and the library still works.
        if (live) setError('Could not load collections.');
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
      controller.abort();
    };
  }, [api]);

  // Every local change (a new collection, a count bump) is what the next visit
  // should paint, so the cache follows the list rather than only the fetch.
  useEffect(() => {
    if (!loading) libraryCache(api).collections = collections;
  }, [api, loading, collections]);

  const create = useCallback(
    async (name: string) => {
      const trimmed = name.trim();
      if (!trimmed) return null;
      try {
        const { collection } = await api.collections.create(trimmed);
        setCollections((prev) => [...prev, collection]);
        return collection;
      } catch {
        setError('Could not create that collection.');
        return null;
      }
    },
    [api],
  );

  const bumpCount = useCallback((collectionId: string, delta: number) => {
    setCollections((prev) =>
      prev.map((collection) =>
        collection.id === collectionId
          ? { ...collection, assetCount: Math.max(0, collection.assetCount + delta) }
          : collection,
      ),
    );
  }, []);

  const add = useCallback(
    async (collectionId: string, assetId: string) => {
      bumpCount(collectionId, 1);
      try {
        await api.collections.add(collectionId, assetId);
        return true;
      } catch {
        bumpCount(collectionId, -1);
        setError('Could not add to that collection.');
        return false;
      }
    },
    [api, bumpCount],
  );

  const remove = useCallback(
    async (collectionId: string, assetId: string) => {
      bumpCount(collectionId, -1);
      try {
        await api.collections.remove(collectionId, assetId);
        return true;
      } catch {
        bumpCount(collectionId, 1);
        setError('Could not remove from that collection.');
        return false;
      }
    },
    [api, bumpCount],
  );

  return { collections, loading, error, create, add, remove };
}
