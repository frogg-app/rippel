import { useLayoutEffect, useRef, useState } from 'react';
import { FitPill } from './CatalogueCard';
import type { Fit } from './cardFacts';
import styles from './ModelsPanels.module.css';

/**
 * How many grid columns a tile needs to hold `contentWidth` without cutting
 * it: the fewest that cover it, never more than the row has. Columns are read
 * from the grid's resolved template ("180px 180px 180px"), so this follows
 * auto-fill as the drawer narrows.
 */
export function factSpan(contentWidth: number, template: string, gap: number): number {
  const columns = template
    .split(/\s+/)
    .map((track) => parseFloat(track))
    .filter((width) => Number.isFinite(width) && width > 0);
  if (columns.length === 0) return 1;
  const column = columns[0]!;
  let span = 1;
  while (span < columns.length && span * column + (span - 1) * gap < contentWidth) span += 1;
  return span;
}

/**
 * The Fit tile: one column when the pill fits, more only when it needs them.
 * The pill stays on one line, so its natural width is what the tile must hold.
 */
export function FitFact({ fit }: { fit: Fit }) {
  const tileRef = useRef<HTMLDivElement>(null);
  const pillRef = useRef<HTMLSpanElement>(null);
  const [span, setSpan] = useState(1);

  useLayoutEffect(() => {
    const tile = tileRef.current;
    const pill = pillRef.current;
    const grid = tile?.parentElement;
    if (!tile || !pill || !grid) return;
    const measure = () => {
      const tileStyle = getComputedStyle(tile);
      const chrome =
        parseFloat(tileStyle.paddingLeft) +
        parseFloat(tileStyle.paddingRight) +
        parseFloat(tileStyle.borderLeftWidth) +
        parseFloat(tileStyle.borderRightWidth);
      const gridStyle = getComputedStyle(grid);
      const next = factSpan(
        pill.getBoundingClientRect().width + (chrome || 0),
        gridStyle.gridTemplateColumns,
        parseFloat(gridStyle.columnGap) || 0,
      );
      setSpan((current) => (current === next ? current : next));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(grid);
    return () => observer.disconnect();
  }, [fit.label]);

  return (
    <div ref={tileRef} className={`${styles.fact} ${styles.fitFact}`} style={span > 1 ? { gridColumn: `span ${span}` } : undefined}>
      <dt>Fit</dt>
      <dd>
        <FitPill fit={fit} ref={pillRef} />
      </dd>
    </div>
  );
}
