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
 *
 * The grid also owns the detail drawer, by ref rather than by entry object:
 * the catalogue is re-read while previews fill in, and a drawer holding a stale
 * copy would show an install button for a file that has since landed.
 */
import { useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ModelCatalogEntry, ModelInstall } from '@comfy/shared';
import type { LoadVariants } from './VersionPicker';
import { CatalogueCard } from './CatalogueCard';
import { FindPartContext, type PartSearch } from './MissingParts';
import { CatalogueDrawer } from './CatalogueDrawer';
import type { TagKey } from './discover';
import { KIND_HEADINGS, basename, splitByKind } from './catalogue';
import styles from './ModelsPanels.module.css';

/** Two viewports of a four-column grid, so the first scroll is already there. */
export const PAGE_SIZE = 48;

export interface CatalogueGridProps {
  entries: ModelCatalogEntry[];
  /** Latest install per file on this backend, keyed by filename basename. */
  installByFile: Map<string, ModelInstall>;
  starting: ReadonlySet<string>;
  canInstall: boolean;
  onInstall: (entry: ModelCatalogEntry, variant?: string) => void;
  /** Reads a Hugging Face model's versions for the drawer's picker. */
  loadVariants?: LoadVariants;
  failure: { ref: string; message: string } | null;
  now: number;
  onWorkflows?: (entry: ModelCatalogEntry) => void;
  /** Toggle a tag filter, from a card chip or the drawer. */
  onTag?: (key: TagKey) => void;
  activeTags?: ReadonlySet<TagKey>;
  /** Named in the drawer beside the verdict. */
  backendName?: string | null;
}

const NO_TAGS: ReadonlySet<TagKey> = new Set();

export type { LoadVariants };

/**
 * The latest install of this entry, whichever of its versions it was: a
 * Hugging Face model installed as its Q4 build is still that model.
 */
function installForEntry(byFile: Map<string, ModelInstall>, entry: ModelCatalogEntry): ModelInstall | null {
  const files = [entry.filename, ...(entry.variants ?? []).map((variant) => variant.filename)];
  let latest: ModelInstall | null = null;
  for (const file of files) {
    const install = byFile.get(basename(file));
    if (install && (!latest || Date.parse(install.createdAt) > Date.parse(latest.createdAt))) latest = install;
  }
  return latest;
}

export function CatalogueGrid({
  entries,
  installByFile,
  starting,
  canInstall,
  onInstall,
  loadVariants,
  failure,
  now,
  onWorkflows,
  onTag,
  activeTags = NO_TAGS,
  backendName = null,
}: CatalogueGridProps) {
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [openRef, setOpenRef] = useState<string | null>(null);
  const open = openRef ? entries.find((entry) => entry.ref === openRef) ?? null : null;
  const openDrawer = useCallback((entry: ModelCatalogEntry) => setOpenRef(entry.ref), []);
  const closeDrawer = useCallback(() => setOpenRef(null), []);

  // Any change to the result set puts us back at the top of it; holding a
  // limit of 300 across a new search would defeat the point of paging.
  useEffect(() => setLimit(PAGE_SIZE), [entries]);

  // Ordered by kind *before* the slice, so the first page is the things you can
  // actually generate with and the paging still means what it says. The split
  // happens after it, so a section's cards are exactly the ones on screen.
  const ordered = splitByKind(entries, (entry) => entry.type).flatMap((section) => section.items);
  const shown = ordered.slice(0, limit);
  const remaining = ordered.length - shown.length;
  const sections = splitByKind(shown, (entry) => entry.type);

  // "Find" on a missing part runs a new search, and the drawer it was clicked
  // in would otherwise sit over the results.
  const findPart = useContext(FindPartContext);
  const findAndClose = useMemo(
    () => (findPart ? (search: PartSearch) => { closeDrawer(); findPart(search); } : null),
    [findPart, closeDrawer],
  );

  return (
    <FindPartContext.Provider value={findAndClose}>
      {sections.map((section) => {
        const heading = KIND_HEADINGS[section.kind];
        return (
          <section
            key={section.kind}
            className={`${styles.band} ${section.kind === 'support' ? styles.bandSupport : ''}`}
            aria-label={heading.title}
          >
            <header className={styles.bandHead}>
              <h2 className={styles.bandTitle}>{heading.title}</h2>
              <span className={`mono ${styles.bandCount}`}>{section.items.length}</span>
              <p className={styles.bandBlurb}>{heading.blurb}</p>
            </header>
            <div className={styles.grid}>
              {section.items.map((entry, index) => (
                <CatalogueCard
                  key={entry.ref}
                  index={Math.min(index, 14)}
                  entry={entry}
                  onWorkflows={onWorkflows}
                  onOpen={openDrawer}
                  onTag={onTag}
                  activeTags={activeTags}
                  install={installForEntry(installByFile, entry)}
                  starting={starting.has(entry.ref)}
                  canInstall={canInstall}
                  onInstall={onInstall}
                  failure={failure?.ref === entry.ref ? failure.message : null}
                  now={now}
                />
              ))}
            </div>
          </section>
        );
      })}

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

      {open ? (
        <CatalogueDrawer
          entry={open}
          onClose={closeDrawer}
          onTag={onTag ?? (() => {})}
          activeTags={activeTags}
          onWorkflows={onWorkflows}
          backendName={backendName}
          install={installForEntry(installByFile, open)}
          starting={starting.has(open.ref)}
          canInstall={canInstall}
          onInstall={onInstall}
          loadVariants={loadVariants}
          failure={failure?.ref === open.ref ? failure.message : null}
          now={now}
        />
      ) : null}
    </FindPartContext.Provider>
  );
}
