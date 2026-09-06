import { useEffect, useMemo, useRef } from 'react';
import type { LibraryAsset } from '../lib/api-library';
import { AssetTile } from './AssetTile';
import { groupByDay } from './grouping';
import styles from './AssetGrid.module.css';

/**
 * The dated grid, plus the sentinel that drives infinite scroll.
 *
 * The sentinel is an empty element after the last group, watched by an
 * IntersectionObserver with a generous bottom margin so the next page starts
 * loading a screenful before the user reaches the end and the scroll never
 * visibly stops. The observer is re-created whenever `onEndReached` changes —
 * the callback closes over the current cursor — and the browser's own
 * `rootMargin` is measured against the scroll container, not the viewport,
 * which is why the container is passed in rather than left to default.
 */
export function AssetGrid({
  items,
  selectedId,
  onOpen,
  onToggleStar,
  onEndReached,
  hasMore,
  loadingMore,
  scrollRoot,
}: {
  items: LibraryAsset[];
  selectedId: string | null;
  onOpen: (asset: LibraryAsset) => void;
  onToggleStar: (asset: LibraryAsset) => void;
  onEndReached: () => void;
  hasMore: boolean;
  loadingMore: boolean;
  scrollRoot: React.RefObject<HTMLElement | null>;
}) {
  const groups = useMemo(() => groupByDay(items), [items]);
  const sentinel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const target = sentinel.current;
    if (!target || !hasMore) return;
    // jsdom and very old browsers have no observer; without one the grid is
    // still correct, it simply stops paging, which is better than throwing.
    if (typeof IntersectionObserver === 'undefined') return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) onEndReached();
      },
      { root: scrollRoot.current ?? null, rootMargin: '600px 0px' },
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, [hasMore, onEndReached, scrollRoot]);

  return (
    <>
      {groups.map((group) => (
        <section key={group.key} className={styles.group}>
          <h2 className={`label ${styles.heading}`}>{group.label}</h2>
          <div className={styles.grid}>
            {group.items.map((asset, index) => (
              <AssetTile
                key={asset.id}
                asset={asset}
                index={index}
                selected={asset.id === selectedId}
                onOpen={onOpen}
                onToggleStar={onToggleStar}
              />
            ))}
          </div>
        </section>
      ))}

      <div ref={sentinel} className={styles.sentinel} aria-hidden />

      {loadingMore ? (
        <p className={styles.more} role="status">
          Loading more…
        </p>
      ) : null}
    </>
  );
}
