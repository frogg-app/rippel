/**
 * Search, type chips and a family select — the artboard's filter band.
 *
 * One component for both tabs, but *not* one filter state: the installed list
 * filters on the API's folded family keys ("sdxl") and the catalogue filters on
 * the catalogue's own spellings ("SDXL"), and the two lists of options are not
 * interchangeable. The component takes options and gives back a value; which
 * vocabulary they are in is the caller's business.
 *
 * The families are a `<select>` rather than the chip row the artboard shows for
 * types: the real catalogue has 42 of them, and 42 chips is a wall, not a
 * filter. Types stay chips — there are six.
 */
import { useId } from 'react';
import type { ModelType } from '@comfy/shared';
import { TYPE_LABELS } from './catalogue';
import { ChevronIcon, SearchIcon } from './icons';
import styles from './ModelsPanels.module.css';

export interface FilterBarProps {
  q: string;
  onQ: (value: string) => void;
  searchLabel: string;
  searchPlaceholder: string;
  types: { type: ModelType; count: number }[];
  activeType: ModelType | null;
  onType: (type: ModelType | null) => void;
  familyOptions: { value: string; label: string }[];
  familyLabel: string;
  activeFamily: string | null;
  onFamily: (family: string | null) => void;
  /** "12 of 372" — shown so a filter that hid everything is legible as such. */
  shown: number;
  total: number;
}

export function FilterBar({
  q,
  onQ,
  searchLabel,
  searchPlaceholder,
  types,
  activeType,
  onType,
  familyOptions,
  familyLabel,
  activeFamily,
  onFamily,
  shown,
  total,
}: FilterBarProps) {
  const searchId = useId();
  const familyId = useId();

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
          <label className={styles.familyLabel} htmlFor={familyId}>
            {familyLabel}
          </label>
          <select
            id={familyId}
            className={styles.familySelect}
            value={activeFamily ?? ''}
            onChange={(event) => onFamily(event.target.value || null)}
          >
            <option value="">All</option>
            {familyOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <ChevronIcon size={12} className={styles.familyChevron} />
        </div>

        <span className={`mono ${styles.resultCount}`}>
          {shown === total ? total : `${shown} / ${total}`}
        </span>
      </div>

      <div className={styles.chips} role="group" aria-label="Filter by model type">
        <button
          type="button"
          className={`${styles.chip} ${activeType === null ? styles.chipOn : ''}`}
          aria-pressed={activeType === null}
          onClick={() => onType(null)}
        >
          All types
        </button>
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
      </div>
    </div>
  );
}
