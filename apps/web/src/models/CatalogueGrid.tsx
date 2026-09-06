/**
 * The catalogue browser.
 *
 * The real box offers 372 entries. Painting all of them costs ~372 cards with a
 * gradient each on every keystroke of the search box, so the grid renders a
 * page at a time and grows on demand: enough to fill the viewport twice over,
 * then a button. That is a smaller and more predictable thing than a
 * virtualiser, and it keeps the whole list reachable by Ctrl-F and by the
 * screen reader, which a windowed list does not.
 *
 * The page resets whenever the filtered set changes, which is what makes
 * typing feel instant: a search that narrows 372 to 6 renders 6.
 */
import { useEffect, useState } from 'react';
import type { ModelCatalogEntry, ModelInstall } from '@comfy/shared';
import { CatalogueCard } from './CatalogueCard';
import { basename } from './catalogue';
import styles from './ModelsPanels.module.css';

/** Two viewports of a four-column grid, so the first scroll is already there. */
export const PAGE_SIZE = 48;

export interface CatalogueGridProps {
  entries: ModelCatalogEntry[];
  /** Latest install per file on this backend, keyed by filename basename. */
  installByFile: Map<string, ModelInstall>;
  starting: ReadonlySet<string>;
  canInstall: boolean;
  onInstall: (entry: ModelCatalogEntry) => void;
  failure: { ref: string; message: string } | null;
  now: number;
}

export function CatalogueGrid({
  entries,
  installByFile,
  starting,
  canInstall,
  onInstall,
  failure,
  now,
}: CatalogueGridProps) {
  const [limit, setLimit] = useState(PAGE_SIZE);

  // Any change to the result set puts us back at the top of it; holding a
  // limit of 300 across a new search would defeat the point of paging.
  useEffect(() => setLimit(PAGE_SIZE), [entries]);

  const shown = entries.slice(0, limit);
  const remaining = entries.length - shown.length;

  return (
    <>
      <div className={styles.grid}>
        {shown.map((entry, index) => (
          <CatalogueCard
            key={entry.ref}
            index={Math.min(index, 14)}
            entry={entry}
            install={installByFile.get(basename(entry.filename)) ?? null}
            starting={starting.has(entry.ref)}
            canInstall={canInstall}
            onInstall={onInstall}
            failure={failure?.ref === entry.ref ? failure.message : null}
            now={now}
          />
        ))}
      </div>

      {remaining > 0 ? (
        <div className={styles.more}>
          <button
            type="button"
            className={styles.moreButton}
            onClick={() => setLimit((current) => current + PAGE_SIZE)}
          >
            Show {Math.min(PAGE_SIZE, remaining)} more
          </button>
          <span className={`mono ${styles.moreCount}`}>
            {shown.length} of {entries.length}
          </span>
        </div>
      ) : null}
    </>
  );
}
