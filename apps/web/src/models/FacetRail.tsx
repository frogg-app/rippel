/**
 * The Discover tab's left rail: one facet per tag group, with live counts.
 *
 * Every count obeys one rule: **how many cards you would get if you clicked
 * it, given everything else selected.** Tags are ANDed, so that is simply the
 * count among the current results (see `tagFacets`); the type facet is counted
 * against everything *except* the type filter, because types are exclusive and
 * a selected type would otherwise report its own total while every other type
 * reported zero.
 *
 * Task, model family and tags stay open — they are the questions anybody asks.
 * Type, library, format, language and licence fold under "More filters": the
 * intent chips above the grid have taken over the type facet's old job, and
 * the rest are answers only somebody who already knows ComfyUI is looking for.
 * The fold opens by itself when one of its filters is on, so an active filter
 * is never hidden from the person who has to turn it off.
 *
 * Long groups show their most common rows and fold the rest behind "+ N more";
 * the free-tag group gets more room because it is the most varied.
 */
import { useState } from 'react';
import type { ModelTagGroup, ModelType } from '@comfy/shared';
import { EXPERT_LABELS, TYPE_LABELS } from './catalogue';
import {
  RAIL_MORE_GROUPS,
  RAIL_OPEN_GROUPS,
  TAG_GROUP_ICON, TAG_GROUP_LABEL,
  facetRows,
  splitKey,
  type TagKey,
} from './discover';
import styles from './ModelsPanels.module.css';

export interface FacetRailProps {
  types: { type: ModelType; count: number }[];
  allTypesCount: number;
  activeType: ModelType | null;
  onType: (type: ModelType | null) => void;
  known: ReadonlySet<TagKey>;
  counts: ReadonlyMap<TagKey, number>;
  include: readonly TagKey[];
  onToggle: (key: TagKey) => void;
}

const LIMIT: Partial<Record<ModelTagGroup, number>> = { tag: 10 };
const DEFAULT_LIMIT = 6;

export function FacetRail({
  types,
  allTypesCount,
  activeType,
  onType,
  known,
  counts,
  include,
  onToggle,
}: FacetRailProps) {
  const [expanded, setExpanded] = useState<ReadonlySet<ModelTagGroup>>(new Set());
  const moreActive =
    activeType !== null || include.some((key) => RAIL_MORE_GROUPS.includes(splitKey(key).group));
  const [moreOpen, setMoreOpen] = useState(false);
  const showMore = moreOpen || moreActive;

  const tagGroup = (group: ModelTagGroup) => {
    const rows = facetRows(group, known, counts, include);
    if (rows.length === 0) return null;
    const limit = LIMIT[group] ?? DEFAULT_LIMIT;
    const open = expanded.has(group);
    // A selected row is never folded away, however rare it is.
    const shown = open ? rows : rows.filter((row, index) => index < limit || include.includes(row.key));
    const hidden = rows.length - shown.length;
    return (
      <div key={group} className={styles.facet} role="group" aria-label={`Filter by ${TAG_GROUP_LABEL[group]}`}>
        <h4 className={styles.facetTitle}>{TAG_GROUP_LABEL[group]}</h4>
        {shown.map((row) => {
          const on = include.includes(row.key);
          return (
            <button
              key={row.key}
              type="button"
              className={`${styles.facetRow} ${on ? styles.facetRowOn : ''}`}
              aria-pressed={on}
              onClick={() => onToggle(row.key)}
              title={row.value}
            >
              <span className={styles.facetIcon} aria-hidden>
                {TAG_GROUP_ICON[group]}
              </span>
              <span className={styles.facetValue}>{row.value}</span>
              <span className={`mono ${styles.facetCount}`}>{row.count}</span>
            </button>
          );
        })}
        {hidden > 0 || open ? (
          <button
            type="button"
            className={styles.facetMore}
            onClick={() =>
              setExpanded((current) => {
                const next = new Set(current);
                if (open) next.delete(group);
                else next.add(group);
                return next;
              })
            }
          >
            {open ? 'Show fewer' : `+ ${hidden} more`}
          </button>
        ) : null}
      </div>
    );
  };

  return (
    <aside className={styles.rail} aria-label="Filter the catalogue">
      {RAIL_OPEN_GROUPS.map(tagGroup)}

      <button
        type="button"
        className={styles.moreFilters}
        aria-expanded={showMore}
        aria-controls="discover-more-filters"
        // Cannot be folded while it holds an active filter; see the header.
        disabled={moreActive}
        onClick={() => setMoreOpen((open) => !open)}
      >
        <span aria-hidden>{showMore ? '▾' : '▸'}</span> More filters
      </button>

      {showMore ? (
        <div id="discover-more-filters">
          <div className={styles.facet} role="group" aria-label="Filter by model type">
            <h4 className={styles.facetTitle}>Type</h4>
            {types.map(({ type, count }) => (
              <button
                key={type}
                type="button"
                className={`${styles.facetRow} ${activeType === type ? styles.facetRowOn : ''}`}
                aria-pressed={activeType === type}
                title={EXPERT_LABELS[type]}
                onClick={() => onType(activeType === type ? null : type)}
              >
                <span className={styles.facetValue}>{TYPE_LABELS[type]}</span>
                <span className={`mono ${styles.facetCount}`}>{count}</span>
              </button>
            ))}
            <button
              type="button"
              className={`${styles.facetRow} ${activeType === null ? styles.facetRowOn : ''}`}
              aria-pressed={activeType === null}
              onClick={() => onType(null)}
            >
              <span className={styles.facetValue}>Any type</span>
              <span className={`mono ${styles.facetCount}`}>{allTypesCount}</span>
            </button>
          </div>
          {RAIL_MORE_GROUPS.map(tagGroup)}
        </div>
      ) : null}
    </aside>
  );
}
