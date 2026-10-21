import { useCallback, useContext, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type {
  Collection,
  LibraryAsset,
  LibraryFilters,
} from '../lib/api-library';
import { usingMockLibrary } from '../lib/api-library';
import { AuthContext } from '../auth/context';
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
    (assetId: string) =>
      setSelected((current) => (current?.id === assetId ? null : current)),
    [],
  );
  const actions = useLibraryActions({ feed, onRemoved });

  // The drawer renders from the feed's copy of the row, not from the snapshot
  // taken when it was clicked, so an optimistic star shows in both places at
  // once and neither can drift from the other.
  const openAsset = useMemo(
    () =>
      selected
        ? (feed.items.find((item) => item.id === selected.id) ?? selected)
        : null,
    [feed.items, selected],
  );

  // Where the open asset sits in what the grid shows. The grid renders the
  // feed in feed order (grouping only inserts headings), so stepping through
  // `feed.items` is stepping through the tiles as the user sees them.
  const openIndex = openAsset
    ? feed.items.findIndex((item) => item.id === openAsset.id)
    : -1;
  const navigate_ = useCallback(
    (direction: -1 | 1) => {
      if (openIndex < 0) return;
      const next = feed.items[openIndex + direction];
      if (next) {
        setSelected(next);
      } else if (direction === 1 && feed.hasMore) {
        // Off the end of what is loaded: fetch the next page, and the user's
        // next press lands on it.
        feed.loadMore();
      }
    },
    [feed, openIndex],
  );

  const view = filters.view ?? 'everything';
  // The server's retention rule, read off any archived row rather than asked
  // for separately: every row carries both ends of its own window.
  const sample = feed.items.find((item) => item.archivedAt && item.purgesAt);
  const retentionDays = sample
    ? Math.round(
        (Date.parse(sample.purgesAt!) - Date.parse(sample.archivedAt!)) / 86_400_000,
      )
    : null;
  // Read softly: outside an AuthProvider (the page tests) every asset is mine.
  const me = useContext(AuthContext)?.user?.id ?? null;

  const filtered =
    Boolean(filters.kind) ||
    Boolean(filters.starred) ||
    Boolean(filters.collectionId) ||
    Boolean(filters.q?.trim());

  const activeCollection = collections.collections.find(
    (c) => c.id === filters.collectionId,
  );

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
        view={view}
        // Picking a view drops a collection or Starred: those are narrower
        // slices of your own, not filters on top of another view.
        onSelectView={(next) => setFilters((prev) => ({ q: prev.q, kind: prev.kind, view: next }))}
        onSelectStarred={() =>
          setFilters((prev) => ({ q: prev.q, kind: prev.kind, starred: true, view: 'mine' }))
        }
        onSelectCollection={(collection: Collection) =>
          setFilters((prev) =>
            // Clicking the collection you are already in leaves it, which is
            // what every file browser does and saves a separate "clear".
            prev.collectionId === collection.id
              ? { q: prev.q }
              : { q: prev.q, collectionId: collection.id, view: 'mine' },
          )
        }
        onCreate={collections.create}
      />

      <div className={styles.main}>
        <LibraryToolbar
          filters={filters}
          onChange={setFilters}
          count={feed.items.length}
        />

        {view === 'archived' && !activeCollection && !filters.starred ? (
          <div className={styles.context}>
            {retentionDays !== null
              ? `Archived items are deleted for good after ${retentionDays} days.`
              : 'Archived items are deleted for good after a while.'}
            {feed.items.length > 0 ? (
              <button
                type="button"
                className={styles.clear}
                onClick={() => {
                  if (window.confirm('Delete everything in the archive for good? This cannot be undone.')) {
                    void actions.emptyArchive();
                  }
                }}
              >
                Empty archive
              </button>
            ) : null}
          </div>
        ) : null}

        {activeCollection ? (
          <div className={styles.context}>
            Showing <strong>{activeCollection.name}</strong>
            <button
              type="button"
              className={styles.clear}
              onClick={() => setFilters((prev) => ({ q: prev.q }))}
            >
              Show everything
            </button>
          </div>
        ) : null}

        <div className={styles.scroller} ref={scroller}>
          {feed.loading ? (
            <div className={styles.skeletonGrid} aria-hidden>
              {Array.from({ length: 8 }, (_, index) => (
                <div
                  key={index}
                  className={`skeleton ${styles.skeleton}`}
                  style={{ '--i': index } as React.CSSProperties}
                />
              ))}
            </div>
          ) : feed.error ? (
            <div className={styles.failure} role="alert">
              <p className={styles.failureText}>{feed.error}</p>
              <button
                type="button"
                className={styles.clear}
                onClick={feed.reload}
              >
                Try again
              </button>
            </div>
          ) : feed.items.length === 0 ? (
            <EmptyState
              filtered={filtered}
              onClearFilters={() => setFilters({})}
            />
          ) : (
            <AssetGrid
              items={feed.items}
              selectedId={openAsset?.id ?? null}
              onOpen={setSelected}
              onToggleStar={actions.toggleStar}
              me={me}
              onEndReached={feed.loadMore}
              hasMore={feed.hasMore}
              loadingMore={feed.loadingMore}
              scrollRoot={scroller}
            />
          )}
        </div>

        {actions.error ? (
          <UndoBar
            message={actions.error}
            tone="danger"
            onDismiss={actions.clearError}
          />
        ) : actions.pendingDelete ? (
          <UndoBar
            message="Moved to archive."
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
          asset={openAsset}
          position={{ index: openIndex, total: feed.items.length }}
          hasPrev={openIndex > 0}
          hasNext={openIndex < feed.items.length - 1 || feed.hasMore}
          onNavigate={navigate_}
          onClose={() => setSelected(null)}
          onToggleStar={actions.toggleStar}
          onDelete={actions.remove}
          me={me}
          onRestore={actions.restore}
          onPurge={actions.purge}
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
