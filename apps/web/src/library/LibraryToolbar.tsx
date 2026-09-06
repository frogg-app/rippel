import { useEffect, useState } from 'react';
import type { LibraryFilters } from '../lib/api-library';
import { SearchIcon } from './icons';
import styles from './LibraryToolbar.module.css';

/**
 * The 60px bar over the grid: the screen's title, the prompt search, and the
 * All / Images / Video / Starred segmented control.
 *
 * The segments are four buttons rather than a `<select>` because the artboard
 * draws them as a segmented control and because with four options a menu costs
 * a click to learn what the options even are. They are exclusive, which is why
 * "Starred" clears `kind` — the design offers one axis at a time here, and the
 * collection rail is the second axis.
 */
export type Segment = 'all' | 'image' | 'video' | 'starred';

const SEGMENTS: Array<{ id: Segment; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'image', label: 'Images' },
  { id: 'video', label: 'Video' },
  { id: 'starred', label: 'Starred' },
];

export function segmentOf(filters: LibraryFilters): Segment {
  if (filters.starred) return 'starred';
  if (filters.kind === 'image') return 'image';
  if (filters.kind === 'video') return 'video';
  return 'all';
}

export function applySegment(filters: LibraryFilters, segment: Segment): LibraryFilters {
  const base = { ...filters, kind: undefined, starred: undefined } as LibraryFilters;
  if (segment === 'starred') return { ...base, starred: true };
  if (segment === 'image') return { ...base, kind: 'image' };
  if (segment === 'video') return { ...base, kind: 'video' };
  return base;
}

export function LibraryToolbar({
  filters,
  onChange,
  count,
}: {
  filters: LibraryFilters;
  onChange: (next: LibraryFilters) => void;
  /** How many rows are currently held, for the "N shown" hint. */
  count: number;
}) {
  const segment = segmentOf(filters);

  // The input is uncontrolled-ish: typing updates local state every keystroke
  // and only settles into the filters after a pause, so each character does
  // not throw away the feed and start a request.
  const [draft, setDraft] = useState(filters.q ?? '');
  useEffect(() => setDraft(filters.q ?? ''), [filters.q]);

  useEffect(() => {
    if (draft === (filters.q ?? '')) return;
    const timer = setTimeout(() => onChange({ ...filters, q: draft }), 250);
    return () => clearTimeout(timer);
  }, [draft, filters, onChange]);

  return (
    <header className={styles.bar}>
      <h1 className={`serif ${styles.title}`}>Library</h1>

      <div className={styles.search}>
        <SearchIcon size={15} className={styles.searchIcon} />
        <input
          className={styles.input}
          type="search"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="Search your prompts"
          aria-label="Search your prompts"
        />
      </div>

      <div className={styles.spacer} />

      {count > 0 ? <span className={`mono ${styles.count}`}>{count} shown</span> : null}

      <div className={styles.segments} role="group" aria-label="Filter by kind">
        {SEGMENTS.map((option) => (
          <button
            key={option.id}
            type="button"
            className={`${styles.segment} ${segment === option.id ? styles.segmentOn : ''}`}
            aria-pressed={segment === option.id}
            onClick={() => onChange(applySegment(filters, option.id))}
          >
            {option.label}
          </button>
        ))}
      </div>
    </header>
  );
}
