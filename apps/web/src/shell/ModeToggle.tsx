import { type CreateMode, useCreateMode } from '../create/mode';
import styles from './ModeToggle.module.css';

export type { CreateMode };

/**
 * Image / Video, top of the input panel (PLAN.md §6: video gets a first-class
 * mode toggle *and* an Animate action on every image).
 *
 * The selection used to be local `useState`, which made this a button that
 * highlighted itself and told nobody: switching to Video left the Create form
 * still submitting `txt2img`, and left every video checkpoint in the picker
 * disabled with no way to reach it. The value now lives in `create/mode.ts`, a
 * module store both this and the Create screen subscribe to — the shell and the
 * screen are siblings, so neither can own state the other needs.
 */
export function ModeToggle() {
  const [mode, setMode] = useCreateMode();

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
