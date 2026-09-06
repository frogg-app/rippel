import { ClockIcon } from '../components/icons';
import { queueLabel } from '../lib/format';
import styles from './QueueChip.module.css';

/**
 * "2 in queue". Hidden entirely when nothing is queued — an empty queue is the
 * normal state and a chip reading "0 in queue" is noise on every screen.
 */
export function QueueChip({ depth }: { depth: number }) {
  if (depth <= 0) return null;
  return (
    <div className={styles.chip}>
      <ClockIcon size={13} />
      {queueLabel(depth)}
    </div>
  );
}
