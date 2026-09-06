import { useCallback, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Collection, LibraryAsset, LibraryFilters } from '../lib/api-library';
import { usingMockLibrary } from '../lib/api-library';
import { AssetGrid } from '../library/AssetGrid';
import { CollectionsRail } from '../library/CollectionsRail';
import { DetailDrawer } from '../library/DetailDrawer';
import { EmptyState } from '../library/EmptyState';
import { LibraryToolbar } from '../library/LibraryToolbar';
import { UndoBar } from '../library/UndoBar';
import type { CreateNavState, CreatePrefill } from '../library/remix';
import { useCollections } from '../library/useCollections';
import { useLibraryActions } from '../library/useLibraryActions';
import { useLibraryFeed } from '../library/useLibraryFeed';
import styles from './LibraryPage.module.css';

/**
 * The Library screen (phase 3).
 *
 * Layout: a collections rail on the sunken ground, the dated tile grid
 * filling the rest, and a centred detail modal over both when a tile is
 * opened (it used to be a 404px side drawer; a modal gives the render most of
 * the viewport and room for the settings underneath).
 *
 * This component owns only the state that genuinely spans the three panes:
 * the filters, which asset is open, and the feed. Paging, the optimistic
 * actions and collections each live in their own hook, because each is a thing
 * that can be wrong on its own and is tested on its own.
 *
 * Route: `/library`, inside the `RequireAuth` + `AppShell` block in App.tsx.
 */
export function LibraryPage() {
  const navigate = useNavigate();
  const [filters, setFilters] = useState<LibraryFilters>({});
  const [selected, setSelected] = useState<LibraryAsset | null>(null);
  const scroller = useRef<HTMLDivElement>(null);

  const feed = useLibraryFeed({ filters });
  const collections = useCollections();

  const onRemoved = useCallback(
    (assetId: string) => setSelected((current) => (current?.id === assetId ? null : current)),
    [],
  );
  const actions = useLibraryActions({ feed, onRemoved });

  // The drawer renders from the feed's copy of the row, not from the snapshot
  // taken when it was clicked, so an optimistic star shows in both places at
  // once and neither can drift from the other.
  const openAsset = useMemo(
    () => (selected ? (feed.items.find((item) => item.id === selected.id) ?? selected) : null),
    [feed.items, selected],
  );

  const filtered =
    Boolean(filters.kind) ||
    Boolean(filters.starred) ||
    Boolean(filters.collectionId) ||
    Boolean(filters.q?.trim());

  const activeCollection = collections.collections.find((c) => c.id === filters.collectionId);

  const handlePrefill = useCallback(
    (prefill: CreatePrefill) => {
      // The contract with the Create screen — see library/remix.ts for the
      // shape and for what Create has to do with it.
      const state: CreateNavState = { prefill };
      navigate('/create', { state });
    },
    [navigate],
  );

  return (
    <div className={styles.screen}>
      <CollectionsRail
        collections={collections.collections}
        loading={collections.loading}
        activeCollectionId={filters.collectionId ?? null}
        starredOnly={Boolean(filters.starred)}
        onSelectAll={() => setFilters((prev) => ({ q: prev.q }))}
        onSelectStarred={() => setFilters((prev) => ({ q: prev.q, starred: true }))}
        onSelectCollection={(collection: Collection) =>
          setFilters((prev) =>
            // Clicking the collection you are already in leaves it, which is
            // what every file browser does and saves a separate "clear".
            prev.collectionId === collection.id
              ? { q: prev.q }
              : { q: prev.q, collectionId: collection.id },
          )
        }
        onCreate={collections.create}
      />

      <div className={styles.main}>
        <LibraryToolbar filters={filters} onChange={setFilters} count={feed.items.length} />

        {activeCollection ? (
          <div className={styles.context}>
            Showing <strong>{activeCollection.name}</strong>
            <button type="button" className={styles.clear} onClick={() => setFilters((prev) => ({ q: prev.q }))}>
              Show everything
            </button>
          </div>
        ) : null}

        <div className={styles.scroller} ref={scroller}>
          {feed.loading ? (
            <div className={styles.skeletonGrid} aria-hidden>
              {Array.from({ length: 8 }, (_, index) => (
                <div key={index} className={`skeleton ${styles.skeleton}`} style={{ '--i': index } as React.CSSProperties} />
              ))}
            </div>
          ) : feed.error ? (
            <div className={styles.failure} role="alert">
              <p className={styles.failureText}>{feed.error}</p>
              <button type="button" className={styles.clear} onClick={feed.reload}>
                Try again
              </button>
            </div>
          ) : feed.items.length === 0 ? (
            <EmptyState filtered={filtered} onClearFilters={() => setFilters({})} />
          ) : (
            <AssetGrid
              items={feed.items}
              selectedId={openAsset?.id ?? null}
              onOpen={setSelected}
              onToggleStar={actions.toggleStar}
              onEndReached={feed.loadMore}
              hasMore={feed.hasMore}
              loadingMore={feed.loadingMore}
              scrollRoot={scroller}
            />
          )}
        </div>

        {actions.error ? (
          <UndoBar message={actions.error} tone="danger" onDismiss={actions.clearError} />
        ) : actions.pendingDelete ? (
          <UndoBar
            message="Deleted."
            actionLabel="Undo"
            onAction={() => void actions.undo()}
            onDismiss={actions.dismissUndo}
          />
        ) : null}

        {usingMockLibrary ? (
          // Only in dev, and only while the real routes are missing. Add
          // `?mock=empty` to the URL to see the first-run state.
          <div className={styles.mockFlag}>Library API mocked</div>
        ) : null}
      </div>

      {openAsset ? (
        <DetailDrawer
          key={openAsset.id}
          asset={openAsset}
          onClose={() => setSelected(null)}
          onToggleStar={actions.toggleStar}
          onDelete={actions.remove}
          onPrefill={handlePrefill}
          collections={collections.collections}
          onAddToCollection={collections.add}
          onRemoveFromCollection={collections.remove}
          onAssetPatched={feed.patch}
        />
      ) : null}
    </div>
  );
}
