/**
 * Search, type chips and a family select — the artboard's filter band.
 *
 * One component for both tabs, but *not* one filter state: the installed list
 * filters on the API's folded family keys ("sdxl") and the catalogue filters on
 * the catalogue's own spellings ("SDXL"), and the two lists of options are not
 * interchangeable. The component takes options and gives back a value; which
 * vocabulary they are in is the caller's business.
 *
 * The families are a dropdown rather than the chip row the artboard shows for
 * types: the real catalogue has 42 of them, and 42 chips is a wall, not a
 * filter. Types stay chips — there are six.
 *
 * The runnability segments are optional and only the catalogue passes them. It
 * is the one filter here that is not about *what a file is* but about whether
 * it would work, which is the question people arrive with — "show me what will
 * actually run" — and it sits first in the row for that reason.
 *
 * There was briefly a second segment row above that one — "All files / Can
 * generate / Support files". It was removed rather than repaired. Type and kind
 * are the same axis at two resolutions (a checkpoint *is* the generator half),
 * so the two rows could never agree on a count: with Checkpoint selected the
 * kind row said "Support files 0" while the type row below it simultaneously
 * offered "LoRA 87". Now the type row defaults to Checkpoint and the two bands
 * under the grid carry the generator/support labelling, which is where that
 * distinction was always doing its real work. To put it back, restore the
 * `kind`/`onKind`/`kindCounts` props and their segment block from the previous
 * revision of this file — `KindFilter`, `KIND_FILTER_LABELS` and `matchesKind`
 * are all still in catalogue.ts, and `filterInstalled` and `filterCatalogue`
 * both still accept a `kind`.
 *
 * Every count here obeys one rule: **a count says how many rows you would get
 * if you clicked it, given everything else currently selected.** So the type
 * counts are taken over the search, the family and the runnability filter but
 * *not* over the type filter itself — otherwise the selected chip would report
 * its own result and every other chip would report nothing.
 */
import { useId } from 'react';
import type { ModelType } from '@comfy/shared';
import { RUN_FILTER_LABELS, TYPE_LABELS, type RunFilter } from './catalogue';
import { ChevronIcon, SearchIcon } from './icons';
import { Dropdown } from '../components/Dropdown';
import styles from './ModelsPanels.module.css';

export interface FilterBarProps {
  q: string;
  onQ: (value: string) => void;
  searchLabel: string;
  searchPlaceholder: string;
  types: { type: ModelType; count: number }[];
  /** How many rows "All types" would leave, under every other active filter. */
  allCount?: number;
  activeType: ModelType | null;
  onType: (type: ModelType | null) => void;
  familyOptions: { value: string; label: string }[];
  familyLabel: string;
  activeFamily: string | null;
  onFamily: (family: string | null) => void;
  /** "12 of 372" — shown so a filter that hid everything is legible as such. */
  shown: number;
  total: number;
  /**
   * Runnability segments, with the count each would leave. Omitted by the
   * installed list, which has no catalogue-wide verdict to filter on.
   */
  run?: RunFilter;
  onRun?: (run: RunFilter) => void;
  runCounts?: Record<RunFilter, number>;
}

const RUN_ORDER: RunFilter[] = ['all', 'runs', 'blocked'];

export function FilterBar({
  q,
  onQ,
  searchLabel,
  searchPlaceholder,
  types,
  allCount,
  activeType,
  onType,
  familyOptions,
  familyLabel,
  activeFamily,
  onFamily,
  shown,
  total,
  run,
  onRun,
  runCounts,
}: FilterBarProps) {
  const searchId = useId();
  const familyId = useId();
  const familyLabelId = useId();

  return (
    <div className={styles.filters}>
      <div className={styles.searchRow}>
        <div className={styles.search}>
          <SearchIcon size={17} className={styles.searchIcon} />
          <input
            id={searchId}
            className={styles.searchInput}
            type="search"
            value={q}
            placeholder={searchPlaceholder}
            aria-label={searchLabel}
            onChange={(event) => onQ(event.target.value)}
          />
        </div>

        <div className={styles.familyPicker}>
          <label className={styles.familyLabel} id={familyLabelId} htmlFor={familyId}>
            {familyLabel}
          </label>
          <Dropdown
            id={familyId}
            aria-labelledby={familyLabelId}
            className={styles.familySelect}
            value={activeFamily ?? ''}
            options={[{ value: '', label: 'All' }, ...familyOptions]}
            onChange={(next) => onFamily(next || null)}
          >
            <ChevronIcon size={12} className={styles.familyChevron} />
          </Dropdown>
        </div>

        <span className={`mono ${styles.resultCount}`}>
          {shown === total ? total : `${shown} / ${total}`}
        </span>
      </div>

      {run && onRun ? (
        <div className={styles.runFilter} role="group" aria-label="Filter by whether it will run">
          {RUN_ORDER.map((option) => (
            <button
              key={option}
              type="button"
              className={`${styles.segment} ${run === option ? styles.segmentOn : ''}`}
              aria-pressed={run === option}
              onClick={() => onRun(option)}
            >
              {RUN_FILTER_LABELS[option]}
              {runCounts ? <span className={`mono ${styles.chipCount}`}>{runCounts[option]}</span> : null}
            </button>
          ))}
        </div>
      ) : null}

      <div className={styles.chips} role="group" aria-label="Filter by model type">
        {types.map(({ type, count }) => (
          <button
            key={type}
            type="button"
            className={`${styles.chip} ${activeType === type ? styles.chipOn : ''}`}
            aria-pressed={activeType === type}
            onClick={() => onType(activeType === type ? null : type)}
          >
            {TYPE_LABELS[type]}
            <span className={`mono ${styles.chipCount}`}>{count}</span>
          </button>
        ))}
        {/* Last, and pushed to the far end. It stopped being the default — the
            screen opens on Checkpoint — so it stops being the first thing the
            eye lands on. It is the escape hatch, not the starting point. */}
        <button
          type="button"
          className={`${styles.chip} ${styles.chipAll} ${activeType === null ? styles.chipOn : ''}`}
          aria-pressed={activeType === null}
          onClick={() => onType(null)}
        >
          All types
          {allCount === undefined ? null : (
            <span className={`mono ${styles.chipCount}`}>{allCount}</span>
          )}
        </button>
      </div>
    </div>
  );
}
