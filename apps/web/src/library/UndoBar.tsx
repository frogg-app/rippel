import { CloseIcon, UndoIcon } from './icons';
import styles from './UndoBar.module.css';

/**
 * The bar that makes delete survivable.
 *
 * It is the whole reason the API's delete is soft. A confirmation dialog before
 * the fact asks a question the user cannot answer well — they are looking at a
 * thumbnail, not the picture — whereas undo after the fact costs nothing when
 * the delete was intended and saves everything when it was not.
 *
 * `role="status"` rather than `alert`: this is a consequence of something the
 * user just did, not an interruption, and it must not steal focus from the grid
 * they are still scrolling.
 */
export function UndoBar({
  message,
  actionLabel,
  onAction,
  onDismiss,
  tone = 'neutral',
}: {
  message: string;
  actionLabel?: string;
  onAction?: () => void;
  onDismiss: () => void;
  tone?: 'neutral' | 'danger';
}) {
  return (
    <div className={`${styles.bar} ${tone === 'danger' ? styles.danger : ''}`} role="status">
      <span className={styles.message}>{message}</span>
      {actionLabel && onAction ? (
        <button type="button" className={styles.action} onClick={onAction}>
          <UndoIcon size={14} />
          {actionLabel}
        </button>
      ) : null}
      <button type="button" className={styles.close} onClick={onDismiss} aria-label="Dismiss">
        <CloseIcon size={13} />
      </button>
    </div>
  );
}
