import { Link } from 'react-router-dom';
import { ImageIcon } from '../components/icons';
import styles from './EmptyState.module.css';

/**
 * The empty grid.
 *
 * There are two quite different empties and conflating them is the usual
 * mistake. A *new install* has nothing at all, and the honest response is to
 * send the user to Create — this is the first screen most people will ever see
 * here, so it has to be a doorway rather than an apology. A *filtered* empty
 * means the library has things in it and this particular question has no
 * answer; the useful response there is to undo the question, and offering
 * "Start creating" instead would be a non-sequitur.
 */
export function EmptyState({
  filtered,
  onClearFilters,
}: {
  filtered: boolean;
  onClearFilters: () => void;
}) {
  if (filtered) {
    return (
      <div className={styles.empty}>
        <p className={`display ${styles.title}`}>Nothing matches</p>
        <p className={styles.body}>
          No renders fit that search and those filters. Widen it and they will come back — nothing
          has been deleted.
        </p>
        <button type="button" className={styles.action} onClick={onClearFilters}>
          Clear filters
        </button>
      </div>
    );
  }

  return (
    <div className={styles.empty}>
      <div className={styles.icon} aria-hidden>
        <ImageIcon size={22} />
      </div>
      <p className={`display ${styles.title}`}>Your library is empty</p>
      <p className={styles.body}>
        Everything you generate lands here automatically — the image, the prompt, the seed and every
        setting behind it, so any render can be reproduced or remixed later.
      </p>
      <Link to="/create" className={styles.cta}>
        Start creating
      </Link>
    </div>
  );
}
