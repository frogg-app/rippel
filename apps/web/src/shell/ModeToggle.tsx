import { useState } from 'react';
import styles from './ModeToggle.module.css';

export type CreateMode = 'image' | 'video';

/**
 * Image / Video, top of the input panel (PLAN.md §6: video gets a first-class
 * mode toggle *and* an Animate action on every image).
 *
 * The selection is local state for now — nothing downstream reads it until the
 * controls workstream lands, and inventing a store for one boolean before then
 * would be a guess at an API that workstream has not made yet.
 */
export function ModeToggle() {
  const [mode, setMode] = useState<CreateMode>('image');

  return (
    <div className={styles.toggle} role="radiogroup" aria-label="Generation mode">
      {(['image', 'video'] as const).map((value) => (
        <button
          key={value}
          type="button"
          role="radio"
          aria-checked={mode === value}
          className={mode === value ? `${styles.option} ${styles.active}` : styles.option}
          onClick={() => setMode(value)}
        >
          {value === 'image' ? 'Image' : 'Video'}
        </button>
      ))}
    </div>
  );
}
